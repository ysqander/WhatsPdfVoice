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
   * @returns Created payment bundle
   */
  async createPaymentBundle(
    chatExportId: number,
    messageCount: number,
    mediaSizeBytes: number
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

      // Fetch messages for this chat
      const messages = await storage.getMessagesByChatExportId(chatExportId);
      console.log(`Retrieved ${messages.length} messages for chat ${chatExportId} to include in PDF generation`);
      
      // Check if we have messages
      if (messages.length === 0) {
        console.error(`No messages found in memory storage for chat ${chatExportId}! This will result in an empty PDF.`);
        console.log(`Attempting to recover messages from the original chat processing...`);
        
        try {
          // First try to recover from bundle backup file
          const bundleId = bundle.bundleId;
          const chatDataBackupPath = path.join(os.tmpdir(), 'whatspdf', 'bundles', `bundle_${bundleId}.json`);
          
          console.log(`Attempting to recover messages from backup file: ${chatDataBackupPath}`);
          
          if (fs.existsSync(chatDataBackupPath)) {
            try {
              // Read backup file
              const backupData = JSON.parse(fs.readFileSync(chatDataBackupPath, 'utf8'));
              
              if (backupData.messages && backupData.messages.length > 0) {
                console.log(`Recovered ${backupData.messages.length} messages from bundle backup file`);
                
                // Use these messages as our source of truth
                const recoveredMessages = backupData.messages;
                
                // Convert timestamps to ensure compatibility
                // @ts-ignore - We know the shape of the message object from our backup
                const normalizedMessages = recoveredMessages.map((message: any) => ({
                  ...message,
                  chatExportId,
                  timestamp: typeof message.timestamp === 'object' ? 
                    (message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp) : 
                    message.timestamp
                }));
                
                console.log(`Recovery found ${normalizedMessages.length} messages for chat ${chatExportId}`);
                
                // Save these for future use
                for (const message of normalizedMessages) {
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
                    console.error(`Error saving recovered message from backup: ${err}`);
                  }
                }
                
                // Update our messages reference and return full chat data
                const updatedMessages = await storage.getMessagesByChatExportId(chatExportId);
                console.log(`After recovery from backup: ${updatedMessages.length} messages available`);
                
                if (updatedMessages.length > 0) {
                  const fullChatData = { 
                    ...chatExport, 
                    messages: updatedMessages.map(msg => ({
                      ...msg,
                      timestamp: typeof msg.timestamp === 'object' && msg.timestamp instanceof Date 
                        ? msg.timestamp.toISOString() 
                        : String(msg.timestamp)
                    })),
                    id: chatExportId
                  };
                  return fullChatData as ChatExport;
                }
              }
            } catch (err) {
              console.error(`Error reading backup file: ${err}`);
            }
          } else {
            console.log(`No backup file found at ${chatDataBackupPath}, trying alternative recovery`);
          }
          
          // If backup file recovery failed, try from chatExport
          const originalChatExport = chatExport;
          
          // Verify if the chatExport actually has messages
          console.log(`Inspecting chatExport for recovery, has messages: ${Boolean(originalChatExport.messages)}`);
          if (originalChatExport.messages) {
            console.log(`Found ${originalChatExport.messages.length} messages in the originalChatExport`);
          }
          
          // If we managed to recover messages, use them
          if (originalChatExport.messages && originalChatExport.messages.length > 0) {
            console.log(`Recovered ${originalChatExport.messages.length} messages from the original chat data`);
            
            // Make sure each recovered message has the correct chatExportId
            const recoveredMessages = originalChatExport.messages.map(msg => ({
              ...msg,
              chatExportId
            }));
            
            // Save these messages to storage for future use
            for (const message of recoveredMessages) {
              try {
                // Make sure timestamp is a string for compatibility with types.ts
                const timestamp = typeof message.timestamp === 'object' && message.timestamp instanceof Date
                  ? message.timestamp.toISOString()
                  : message.timestamp;
                
                await storage.saveMessage({
                  chatExportId,
                  timestamp,
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
            
            // Update our messages reference for PDF generation
            const updatedMessages = await storage.getMessagesByChatExportId(chatExportId);
            console.log(`After recovery: ${updatedMessages.length} messages available`);
            
            if (updatedMessages.length > 0) {
              console.log(`Using recovered messages for PDF generation`);
              // Convert all message timestamps to strings for compatibility
              const normalizedMessages = updatedMessages.map(message => ({
                ...message,
                timestamp: typeof message.timestamp === 'object' && message.timestamp instanceof Date 
                  ? message.timestamp.toISOString() 
                  : String(message.timestamp)
              }));
              
              // Update our reference to use normalized messages
              const fullChatData = { 
                ...chatExport, 
                messages: normalizedMessages,
                id: chatExportId  // Ensure ID is explicitly set for lookup during PDF generation
              };
              return fullChatData as ChatExport;
            }
          }
        } catch (err) {
          console.error(`Error attempting to recover messages: ${err}`);
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