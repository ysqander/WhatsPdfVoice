import Stripe from 'stripe';
import { db } from '../db';
import { paymentBundles, insertPaymentBundleSchema, PaymentBundle, Message as SchemaMessage } from '../../shared/schema';
import { eq, and, lt, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { storage } from '../storage';
import { generatePdf } from './pdf';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ChatExport, Message, ProcessingOptions } from '../../shared/types';

// Ensure Stripe API key is available
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY environment variable is not set');
}

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export class PaymentService {
  /**
   * Create a payment bundle in the database
   * @param chatExportId The ID of the chat export
   * @param messageCount Number of messages in the chat
   * @param mediaSizeBytes Total size of media files in bytes
   * @param originalFileMediaId ID of the original chat file stored in R2 (optional)
   * @returns Created payment bundle
   */
  async createPaymentBundle(
    chatExportId: number,
    messageCount: number,
    mediaSizeBytes: number,
    originalFileMediaId?: string
  ): Promise<PaymentBundle> {
    // Generate a unique bundle ID
    const bundleId = uuidv4();
    
    // Create the bundle record
    const bundle = await db.insert(paymentBundles)
      .values({
        bundleId,
        chatExportId,
        messageCount,
        mediaSizeBytes,
        originalFileMediaId,
        paidAt: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        createdAt: new Date(),
      })
      .returning()
      .then(rows => rows[0]);
    
    return bundle;
  }

  /**
   * Get a payment bundle by its ID
   * @param bundleId The bundle ID
   * @returns Payment bundle or undefined if not found
   */
  async getPaymentBundle(bundleId: string): Promise<PaymentBundle | undefined> {
    const bundle = await db.select()
      .from(paymentBundles)
      .where(eq(paymentBundles.bundleId, bundleId))
      .then(rows => rows[0]);
    
    return bundle;
  }

  /**
   * Mark a payment bundle as paid
   * @param bundleId The bundle ID
   * @returns Updated payment bundle or undefined if not found
   */
  async markBundleAsPaid(bundleId: string): Promise<PaymentBundle | undefined> {
    const bundle = await db.update(paymentBundles)
      .set({
        paidAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      })
      .where(eq(paymentBundles.bundleId, bundleId))
      .returning()
      .then(rows => rows[0]);
    
    return bundle;
  }

  /**
   * Create a Stripe checkout session for a payment bundle
   * @param bundleId The bundle ID
   * @param successUrl URL to redirect on successful payment
   * @param cancelUrl URL to redirect on cancelled payment
   * @returns Checkout URL
   */
  async createCheckoutSession(
    bundleId: string,
    successUrl: string,
    cancelUrl: string
  ): Promise<string> {
    // Get the bundle details
    const bundle = await this.getPaymentBundle(bundleId);
    if (!bundle) {
      throw new Error(`Payment bundle with ID ${bundleId} not found`);
    }
    
    // Create a Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'] as any, // Typecasting to avoid TypeScript error
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'WhatsApp Chat Export',
              description: `${bundle.messageCount || 0} messages and ${((bundle.mediaSizeBytes || 0) / (1024 * 1024)).toFixed(1)} MB of media`,
            },
            unit_amount: 900, // $9.00 in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: bundleId,
      metadata: {
        bundleId,
        chatExportId: bundle.chatExportId?.toString() || '',
      },
    });
    
    return session.url || '';
  }

  // We don't need the verifyWebhookSignature method anymore
  // as we're handling it directly in the routes

  /**
   * Handle a Stripe checkout.session.completed event
   * @param sessionId The Stripe checkout session ID
   * @returns Updated payment bundle or undefined if not found
   */
  async handleCheckoutSessionCompleted(sessionId: string): Promise<PaymentBundle | undefined> {
    try {
      console.log(`Retrieving Stripe session ${sessionId}`);
      
      // Retrieve the session
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      console.log(`Session retrieved, payment_status=${session.payment_status}, customer=${session.customer}`);
      
      // Get the bundle ID from metadata or client_reference_id
      let bundleId = session.metadata?.bundleId;
      
      // If not in metadata, try client_reference_id (older sessions may use this)
      if (!bundleId && session.client_reference_id) {
        bundleId = session.client_reference_id;
        console.log(`Using client_reference_id for bundleId: ${bundleId}`);
      }
      
      if (!bundleId) {
        console.error('No bundleId found in session metadata or client_reference_id', {
          sessionId: session.id,
          metadata: session.metadata,
          clientReferenceId: session.client_reference_id
        });
        return undefined;
      }
      
      console.log(`Processing payment for bundle ${bundleId}`);
      
      // Check if bundle exists before marking as paid
      const existingBundle = await this.getPaymentBundle(bundleId);
      if (!existingBundle) {
        console.error(`Bundle ${bundleId} not found in database`);
        return undefined;
      }
      
      console.log(`Existing bundle found: chatExportId=${existingBundle.chatExportId}, paidAt=${existingBundle.paidAt}`);
      
      // If already paid, just return the bundle
      if (existingBundle.paidAt) {
        console.log(`Bundle ${bundleId} already marked as paid at ${existingBundle.paidAt}`);
        // Ensure PDF URL is populated even if already paid (idempotency)
        await this.ensurePdfGeneratedAndLinked(existingBundle);
        return existingBundle;
      }
      
      // Mark the bundle as paid FIRST
      const updatedBundle = await this.markBundleAsPaid(bundleId);
      if (!updatedBundle) {
        console.error(`Failed to mark bundle ${bundleId} as paid`);
        return undefined; // Stop if marking as paid failed
      }
      console.log(`Bundle ${bundleId} marked as paid successfully.`);

      // --- START: Generate and Link PDF AFTER marking as paid ---
      await this.ensurePdfGeneratedAndLinked(updatedBundle);
      // --- END: Generate and Link PDF AFTER marking as paid ---
      
      return updatedBundle;
    } catch (error) {
      console.error('Error handling checkout session completed:', error);
      return undefined;
    }
  }
  
  /**
   * Ensures the final PDF for a paid bundle is generated, uploaded, and linked.
   * This is idempotent - safe to call even if already done.
   * @param bundle The payment bundle (must be marked as paid)
   * @returns ChatExport data with messages when recovery is successful, void otherwise
   */
  private async ensurePdfGeneratedAndLinked(bundle: PaymentBundle): Promise<ChatExport | void> {
    if (!bundle.paidAt) {
      console.warn(`ensurePdfGeneratedAndLinked called for unpaid bundle ${bundle.bundleId}. Skipping.`);
      return;
    }
    if (!bundle.chatExportId) {
      console.error(`Cannot generate PDF for bundle ${bundle.bundleId}: chatExportId is missing.`);
      return;
    }

    try {
      const chatExportId = bundle.chatExportId;
      console.log(`Ensuring PDF exists and is linked for paid chat export ${chatExportId}`);

      // Fetch chat export, check if PDF URL already exists and is valid
      const chatExport = await storage.getChatExport(chatExportId);
      if (!chatExport) {
        console.error(`ChatExport ${chatExportId} not found during PDF generation for bundle ${bundle.bundleId}.`);
        return;
      }

      // Check if a valid PDF URL pointing to our proxy already exists
      if (chatExport.pdfUrl && chatExport.pdfUrl.includes('/api/media/proxy/')) {
        // Attempt to resolve the proxy URL to check if the media file exists
        try {
          const mediaId = chatExport.pdfUrl.split('/').pop();
          if (mediaId) {
            const mediaFile = await storage.getMediaFile(mediaId);
            // Check if it looks like the main generated PDF
            if (mediaFile && (mediaFile.originalName === 'MAIN_GENERATED_PDF' || mediaFile.type === 'pdf')) {
              console.log(`PDF URL ${chatExport.pdfUrl} already exists and seems valid for chat ${chatExportId}. Skipping regeneration.`);
              return; // Assume it's correct and skip regeneration
            } else {
              console.log(`Existing PDF URL ${chatExport.pdfUrl} points to non-main PDF or missing media. Regenerating.`);
            }
          }
        } catch (e) {
          console.log(`Error verifying existing PDF URL ${chatExport.pdfUrl}. Regenerating. Error: ${e}`);
        }
      } else {
        console.log(`No valid PDF URL found for chat ${chatExportId}. Generating PDF.`);
      }

      // --- START: NEW SIMPLER APPROACH - REPROCESS THE ORIGINAL FILE ---
      // Check if we have a reference to the original file in R2
      if (bundle.originalFileMediaId) {
        console.log(`Found original file media ID ${bundle.originalFileMediaId} in bundle. Using it to reprocess the chat.`);
        try {
          // Get the media file details
          const originalFileMedia = await storage.getMediaFile(bundle.originalFileMediaId);
          
          if (!originalFileMedia) {
            throw new Error(`Original chat file not found for mediaId: ${bundle.originalFileMediaId}`);
          }
          
          console.log(`Found original chat file in R2 storage: ${originalFileMedia.key}`);
          
          // Get presigned URL for downloading the original file
          const presignedUrl = await storage.getMediaUrl(bundle.originalFileMediaId);
          
          if (!presignedUrl) {
            throw new Error(`Could not generate presigned URL for original chat file`);
          }
          
          // Download the file to a temporary location
          const tempDir = path.join(os.tmpdir(), 'whatspdf', 'paid-downloads');
          fs.mkdirSync(tempDir, { recursive: true });
          
          const tempFilePath = path.join(tempDir, `original_${bundle.bundleId}.zip`);
          
          console.log(`Downloading original chat file from R2 to ${tempFilePath}`);
          
          const response = await fetch(presignedUrl);
          if (!response.ok) {
            throw new Error(`Failed to download original file: ${response.status} ${response.statusText}`);
          }
          
          const fileBuffer = await response.arrayBuffer();
          fs.writeFileSync(tempFilePath, Buffer.from(fileBuffer));
          
          console.log(`Successfully downloaded original chat file to ${tempFilePath}`);
          
          // Now process the file just like in the uploadController
          console.log(`Reprocessing original chat file for paid bundle ${bundle.bundleId}`);
          
          // Get the original processing options from the chat export
          const originalOptions = chatExport.processingOptions || {
            includeVoiceMessages: true,
            includeTimestamps: true,
            highlightSenders: true,
            includeImages: true,
            includeAttachments: true
          };
          
          // Parse the file
          const { parse } = await import('../lib/parser');
          console.log(`Starting parse for paid bundle file: ${tempFilePath}`);
          
          const reparsedChatData = await parse(tempFilePath, originalOptions);
          console.log(`Reparsed chat data has ${reparsedChatData.messages.length} messages`);
          
          // Update the chat data with the file hash and other properties
          reparsedChatData.fileHash = chatExport.fileHash;
          reparsedChatData.originalFilename = chatExport.originalFilename;
          reparsedChatData.processingOptions = originalOptions;
          reparsedChatData.id = chatExportId;
          
          // Clean old messages from this chat if they exist
          try {
            // This is not implemented in the current storage interface, so we'll just log it
            console.log(`Would delete old messages for chat ${chatExportId} here (not implemented)`);
          } catch (err) {
            console.log(`Error cleaning old messages (not critical): ${err}`);
          }
          
          // Save the messages from the reparsed chat data
          console.log(`Saving ${reparsedChatData.messages.length} messages from reparsed chat data`);
          
          // First, clear existing messages for this chat (not implemented, would be done here)
          
          for (const message of reparsedChatData.messages) {
            try {
              await storage.saveMessage({
                chatExportId,
                timestamp: message.timestamp,
                sender: message.sender,
                content: message.content,
                type: message.type,
                mediaUrl: message.mediaUrl,
                duration: message.duration
              });
            } catch (err) {
              console.error(`Error saving reparsed message: ${err}`);
            }
          }
          
          // Fetch the messages to verify they were saved
          const updatedMessages = await storage.getMessagesByChatExportId(chatExportId);
          console.log(`Verified ${updatedMessages.length} messages saved after reprocessing`);
          
          if (updatedMessages.length > 0) {
            // Convert timestamps to strings for PDF generation
            const normalizedMessages = updatedMessages.map(msg => ({
              ...msg,
              timestamp: typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
                ? msg.timestamp.toISOString()
                : String(msg.timestamp)
            }));
            
            // Update the full chat data for PDF generation
            reparsedChatData.messages = normalizedMessages;
            
            // Clean up temporary file
            try {
              fs.unlinkSync(tempFilePath);
              console.log(`Cleaned up temporary file: ${tempFilePath}`);
            } catch (err) {
              console.log(`Error cleaning temporary file (non-critical): ${err}`);
            }
            
            // Get the extract directory where media files are unpacked
            const extractDir = path.join(path.dirname(tempFilePath), path.basename(tempFilePath, '.zip'));
            
            // Process media files if they exist
            const mediaMessages = reparsedChatData.messages.filter(msg => 
              msg.type === 'voice' || msg.type === 'image' || msg.type === 'attachment'
            );
            
            if (mediaMessages.length > 0) {
              console.log(`Processing ${mediaMessages.length} media files from reparsed chat`);
              
              // Import the findMediaPath function
              const { findMediaPath } = await import('../controllers/uploadController');
              
              for (const message of mediaMessages) {
                if (!message.mediaUrl) continue;
                
                try {
                  const mediaFilename = path.basename(message.mediaUrl);
                  const mediaPath = findMediaPath(mediaFilename, extractDir);
                  
                  if (mediaPath) {
                    console.log(`Found media file: ${mediaPath}`);
                    
                    // Upload to R2
                    let contentType = 'application/octet-stream';
                    if (message.type === 'voice') contentType = 'audio/ogg';
                    else if (message.type === 'image') {
                      const ext = path.extname(mediaPath).toLowerCase();
                      if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
                      else if (ext === '.png') contentType = 'image/png';
                      else if (ext === '.gif') contentType = 'image/gif';
                      else if (ext === '.webp') contentType = 'image/webp';
                    }
                    
                    const mediaFile = await storage.uploadMediaToR2(
                      mediaPath,
                      contentType,
                      chatExportId,
                      message.id,
                      message.type as any
                    );
                    
                    console.log(`Uploaded media file to R2: ${mediaFile.key}`);
                    
                    // Update message with R2 URL
                    if (message.id) {
                      await storage.updateMessageMediaUrl(message.id, mediaFile.key, mediaFile.url!);
                    }
                  }
                } catch (err) {
                  console.error(`Error processing media file: ${err}`);
                }
              }
            }
            
            // Return the reparsed chat data for PDF generation
            return reparsedChatData as ChatExport;
          }
          
        } catch (err) {
          console.error(`Error reprocessing original chat file: ${err}`);
          console.log(`Falling back to original recovery method`);
        }
      } else {
        console.log(`No original file media ID found in bundle. Using fallback recovery methods.`);
      }
      // --- END: NEW SIMPLER APPROACH ---
      
      // Fallback to original method if the new approach fails or isn't available
      
      // Fetch messages for this chat
      const messages = await storage.getMessagesByChatExportId(chatExportId);
      console.log(`Retrieved ${messages.length} messages for chat ${chatExportId} to include in PDF generation`);
      
      // Check if we have messages
      if (messages.length === 0) {
        console.error(`No messages found in memory storage for chat ${chatExportId}. Using fallback recovery.`);
        
        try {
          // Try to recover from bundle backup file
          const bundleId = bundle.bundleId;
          const chatDataBackupPath = path.join(os.tmpdir(), 'whatspdf', 'bundles', `bundle_${bundleId}.json`);
          
          console.log(`Attempting to recover messages from backup file: ${chatDataBackupPath}`);
          
          if (fs.existsSync(chatDataBackupPath)) {
            // Read backup file
            const backupData = JSON.parse(fs.readFileSync(chatDataBackupPath, 'utf8'));
            
            if (backupData.messages && backupData.messages.length > 0) {
              console.log(`Recovered ${backupData.messages.length} messages from bundle backup file`);
              
              // Save messages to storage
              for (const message of backupData.messages) {
                try {
                  await storage.saveMessage({
                    chatExportId,
                    timestamp: message.timestamp,
                    sender: message.sender,
                    content: message.content,
                    type: message.type,
                    mediaUrl: message.mediaUrl,
                    duration: message.duration,
                    isDeleted: message.isDeleted
                  });
                } catch (err) {
                  console.error(`Error saving recovered message: ${err}`);
                }
              }
              
              // Get fresh messages for PDF generation
              const updatedMessages = await storage.getMessagesByChatExportId(chatExportId);
              console.log(`After recovery: ${updatedMessages.length} messages available`);
              
              if (updatedMessages.length > 0) {
                // Normalize timestamp format
                const normalizedMessages = updatedMessages.map(msg => ({
                  ...msg,
                  timestamp: typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
                    ? msg.timestamp.toISOString()
                    : String(msg.timestamp)
                }));
                
                const fullChatData = {
                  ...chatExport,
                  messages: normalizedMessages,
                  id: chatExportId
                };
                return fullChatData as ChatExport;
              }
            }
          }
        } catch (err) {
          console.error(`Error recovering messages from backup: ${err}`);
        }
      }
      
      // Log sample of first few messages to verify content
      if (messages.length > 0) {
        console.log(`First message sample: ${JSON.stringify(messages[0]).substring(0, 200)}...`);
      } else {
        console.error(`Failed to recover messages. The PDF will be generated without message content.`);
      }
      
      // Convert all message timestamps to strings for compatibility
      const normalizedMessages = messages.map(message => ({
        ...message,
        timestamp: typeof message.timestamp === 'object' && message.timestamp instanceof Date 
          ? message.timestamp.toISOString() 
          : String(message.timestamp)
      }));
      
      const fullChatData = { 
        ...chatExport, 
        messages: normalizedMessages,
        id: chatExportId  // Ensure ID is explicitly set for lookup during PDF generation
      } as ChatExport; // Construct the full object needed by generatePdf

      // Generate the final PDF
      console.log(`Generating final PDF for chat ${chatExportId}...`);
      const pdfResultPath = await generatePdf(fullChatData);
      console.log(`Final PDF generated locally at: ${pdfResultPath}`);

      // Determine the base URL
      const appDomain = process.env.REPLIT_DOMAINS ? process.env.REPLIT_DOMAINS.split(',')[0] : null;
      const appBaseUrl = appDomain ? `https://${appDomain}` : 'http://localhost:5000';

      // Upload the final PDF to R2 with specific markers
      console.log(`Uploading final PDF to R2 for chat ${chatExportId}...`);
      const pdfMediaFile = await storage.uploadMediaToR2(
        pdfResultPath,
        'application/pdf',
        chatExportId,
        undefined, // Not linked to a specific message
        'pdf', // Type is 'pdf' for the main transcript
        'MAIN_GENERATED_PDF', // Use the special originalName marker
        'MAIN_PDF_' + chatExportId // Use the special fileHash marker
      );
      console.log(`Final PDF uploaded to R2: key=${pdfMediaFile.key}, id=${pdfMediaFile.id}`);

      // Generate the proxy URL for the PDF
      const finalPdfUrl = `${appBaseUrl}/api/media/proxy/${pdfMediaFile.id}`;
      console.log(`Generated final PDF proxy URL: ${finalPdfUrl}`);

      // Save the final PDF proxy URL to the chat export record
      await storage.savePdfUrl(chatExportId, finalPdfUrl);
      console.log(`Successfully saved final PDF URL for chat export ${chatExportId}`);

      // Optional: Clean up the local PDF file
      try {
        fs.unlinkSync(pdfResultPath);
        console.log(`Cleaned up local PDF: ${pdfResultPath}`);
      } catch (err) {
        console.error(`Error cleaning up local PDF ${pdfResultPath}:`, err);
      }
    } catch (error) {
      console.error(`CRITICAL ERROR generating/linking PDF for paid bundle ${bundle.bundleId} (Chat ${bundle.chatExportId}):`, error);
      // Payment is processed, but the PDF might be missing
    }
  }

  /**
   * Clean up expired unpaid bundles
   * @returns Number of bundles deleted
   */
  async cleanupExpiredBundles(): Promise<number> {
    const now = new Date();
    
    const deletedBundles = await db.delete(paymentBundles)
      .where(
        // Delete bundles that are expired and not paid
        and(
          isNull(paymentBundles.paidAt),
          lt(paymentBundles.expiresAt, now)
        )
      )
      .returning();
    
    return deletedBundles.length;
  }
}

// Create a singleton instance
export const paymentService = new PaymentService();