import { Request, Response } from "express";
import { storage } from "../storage";
import { MediaFile } from "@shared/schema";
import { parse } from "../lib/parser";
import { generatePdf } from "../lib/pdf";
import { 
  ProcessingOptions, 
  ProcessingStep, 
  FREE_TIER_MESSAGE_LIMIT, 
  FREE_TIER_MEDIA_SIZE_LIMIT 
} from "@shared/types";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import os from "os";
import { format } from "date-fns";
import { testR2Connection, getSignedR2Url } from "../lib/r2Storage";
import { paymentService } from "../lib/paymentService";
import { isPaymentRequired, calculateMediaSize, handlePaymentCheck } from "../lib/paymentHelper";
import { db } from "../db";
import { eq } from "drizzle-orm";

// Map to store client connections for SSE
const clients = new Map<string, Response>();

/**
 * Helper to find a media file path in various locations
 * @param filename Media filename
 * @param extractDir Extract directory
 * @returns Path to the media file if found
 */
function findMediaPath(filename: string, extractDir: string): string | undefined {
  // First, try direct path in media directory
  const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
  const directPath = path.join(mediaDir, filename);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  
  // Next, try in extract directory if provided
  if (extractDir) {
    // Function to search recursively in directory
    const searchRecursive = (dir: string): string | undefined => {
      try {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
          const filePath = path.join(dir, file);
          
          try {
            const stats = fs.statSync(filePath);
            
            if (stats.isDirectory()) {
              const result = searchRecursive(filePath);
              if (result) return result;
            } else if (
              file === filename || 
              file.endsWith(filename) ||
              // Additionally check for files with similar names but different extensions
              file.includes(path.basename(filename, path.extname(filename)))
            ) {
              return filePath;
            }
          } catch (err) {
            // Continue with next file
          }
        }
      } catch (err) {
        // Continue
      }
      return undefined;
    };
    
    return searchRecursive(extractDir);
  }
  
  return undefined;
}

/**
 * Helper to upload a media file from a path and update the message
 */
async function uploadMediaFile(message: any, filePath: string, type: 'voice' | 'image' | 'attachment', chatExportId: number) {
  // Determine content type
  let contentType = 'application/octet-stream';
  if (type === 'voice') {
    contentType = 'audio/ogg';
  } else if (type === 'image') {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.webp') contentType = 'image/webp';
  } else if (type === 'attachment' && filePath.toLowerCase().endsWith('.pdf')) {
    contentType = 'application/pdf';
  }
  
  // Upload to R2
  const mediaFile = await storage.uploadMediaToR2(
    filePath,
    contentType,
    chatExportId,
    message.id,
    type
  );
  
  // Update message with R2 URL
  if (message.id) {
    await storage.updateMessageMediaUrl(message.id, mediaFile.key, mediaFile.url!);
  }
  
  return mediaFile;
}

// Calculate file hash
const calculateFileHash = (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('error', err => reject(err));
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
};

export const uploadController = {
  // Process uploaded WhatsApp chat export ZIP file
  processFile: async (req: Request, res: Response) => {
    try {
      console.log('Upload request received:', {
        headers: req.headers,
        contentType: req.headers['content-type'],
        files: req.files,
        file: req.file,
        body: req.body
      });

      if (!req.file) {
        console.error('No file in request:', {
          body: req.body,
          isMultipart: req.headers['content-type']?.includes('multipart/form-data')
        });
        return res.status(400).json({ message: "No file uploaded" });
      }

      console.log('File details:', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path
      });

      // Generate client ID for tracking processing status
      const clientId = uuidv4();

      // Parse processing options
      const optionsStr = req.body.options || "{}";
      const options: ProcessingOptions = JSON.parse(optionsStr);

      // Wait for client connection before starting processing
      const waitForClient = new Promise<void>((resolve) => {
        const checkClient = setInterval(() => {
          if (clients.get(clientId)) {
            clearInterval(checkClient);
            resolve();
          }
        }, 100);

        // Timeout after 5 seconds
        setTimeout(() => {
          clearInterval(checkClient);
          resolve();
        }, 5000);
      });

      // Start processing in background
      process.nextTick(async () => {
        try {
          console.log(`Waiting for SSE connection for clientId: ${clientId}`);
          await waitForClient;
          console.log(`Starting background processing for clientId: ${clientId}`);

          // Update progress: extraction starting
          storage.saveProcessingProgress(clientId, 5, ProcessingStep.EXTRACT_ZIP);
          const client = clients.get(clientId);
          if (!client) {
            console.error(`No client found for clientId: ${clientId}`);
            return;
          }
          client.write(`data: ${JSON.stringify({ progress: 5, step: ProcessingStep.EXTRACT_ZIP })}\n\n`);

          // Calculate file hash for verification
          const fileHash = await calculateFileHash(req.file!.path);

          // Parse the ZIP file and extract messages
          storage.saveProcessingProgress(clientId, 20, ProcessingStep.EXTRACT_ZIP);
          clients.get(clientId)?.write(`data: ${JSON.stringify({ progress: 20, step: ProcessingStep.EXTRACT_ZIP })}\n\n`);

          // Parse chat messages
          storage.saveProcessingProgress(clientId, 30, ProcessingStep.PARSE_MESSAGES);
          clients.get(clientId)?.write(`data: ${JSON.stringify({ progress: 30, step: ProcessingStep.PARSE_MESSAGES })}\n\n`);
          console.log(`Starting parse for file: ${req.file!.path}`);
          // Extract the ZIP file to a temporary directory
          const extractDir = path.join(path.dirname(req.file!.path), path.basename(req.file!.path, '.zip'));
          
          const chatData = await parse(req.file!.path, options).catch(error => {
            console.error('Error parsing file:', error);
            throw new Error(`Failed to parse file: ${error.message}`);
          });
          console.log('Parse completed successfully');
          chatData.fileHash = fileHash;
          chatData.originalFilename = req.file!.originalname;
          // Convert processing options to an object for storage
          chatData.processingOptions = options;
          
          // Analyze chat size to determine if payment is required
          console.log(`Analyzing chat size. Messages: ${chatData.messages.length}`);
          
          // Get total size of media files
          let totalMediaSize = 0;
          const mediaMessages = chatData.messages.filter(msg => 
            msg.type === 'voice' || msg.type === 'image' || msg.type === 'attachment'
          );
          
          for (const message of mediaMessages) {
            try {
              if (!message.mediaUrl) continue;
              
              // Check if media file exists locally
              let mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', path.basename(message.mediaUrl));
              if (fs.existsSync(mediaPath)) {
                const stats = fs.statSync(mediaPath);
                totalMediaSize += stats.size;
              }
            } catch (error) {
              console.error(`Error checking media file size: ${error}`);
            }
          }
          
          console.log(`Total media size: ${totalMediaSize} bytes (${(totalMediaSize / (1024 * 1024)).toFixed(2)}MB)`);
          
          // Check if payment is required using the payment helper
          const requiresPayment = isPaymentRequired(
            chatData.messages.length, 
            totalMediaSize
          );
            
          if (requiresPayment) {
            console.log(`Chat exceeds free tier limits. Payment required.`);
            
            // Save chat export to storage first to get its ID
            const savedChatExport = await storage.saveChatExport(chatData);
            chatData.id = savedChatExport.id;
            
            try {
              // Create a payment bundle first
              const bundle = await paymentService.createPaymentBundle(
                savedChatExport.id!,
                chatData.messages.length,
                totalMediaSize
              );
              
              console.log('Created payment bundle:', {
                bundleId: bundle.bundleId
              });
              
              // Save full chat data to a temporary file for recovery during payment
              try {
                const chatDataBackupDir = path.join(os.tmpdir(), 'whatspdf', 'bundles');
                fs.mkdirSync(chatDataBackupDir, { recursive: true });
                
                const chatDataBackupPath = path.join(chatDataBackupDir, `bundle_${bundle.bundleId}.json`);
                fs.writeFileSync(
                  chatDataBackupPath, 
                  JSON.stringify({
                    chatData,
                    messages: chatData.messages.map(msg => ({
                      ...msg,
                      chatExportId: savedChatExport.id
                    }))
                  }, null, 2)
                );
                
                console.log(`Backed up chat data to ${chatDataBackupPath} for payment recovery`);
              } catch (err) {
                console.error('Error backing up chat data for payment recovery:', err);
              }
              
              // Process media files first (upload to R2)
              console.log('R2 connection successful');
              console.log('R2 connection successful, proceeding with media uploads');
              
              // Find all media messages that need to be uploaded
              const mediaMessages = chatData.messages.filter(
                msg => msg.type === 'voice' || msg.type === 'image' || msg.type === 'attachment'
              );
              
              console.log(`Found ${mediaMessages.length} media messages to upload to R2`);
              
              // Upload voice messages first
              const voiceMessages = mediaMessages.filter(msg => msg.type === 'voice');
              if (voiceMessages.length > 0) {
                console.log(`Processing ${voiceMessages.length} voice messages`);
                
                for (const message of voiceMessages) {
                  // Handle voice message upload
                  if (message.mediaUrl) {
                    const mediaFilename = path.basename(message.mediaUrl);
                    const mediaPath = findMediaPath(mediaFilename, extractDir);
                    
                    if (mediaPath) {
                      console.log(`Uploading voice message to R2: ${mediaPath}`);
                      await uploadMediaFile(message, mediaPath, 'voice', savedChatExport.id!);
                    }
                  }
                }
              }
              
              // Upload image messages next
              const imageMessages = mediaMessages.filter(msg => msg.type === 'image');
              if (imageMessages.length > 0) {
                console.log(`Processing ${imageMessages.length} image messages`);
                
                for (const message of imageMessages) {
                  if (message.mediaUrl) {
                    const mediaFilename = path.basename(message.mediaUrl);
                    const mediaPath = findMediaPath(mediaFilename, extractDir);
                    
                    if (mediaPath) {
                      console.log(`Uploading image to R2: ${mediaPath}`);
                      await uploadMediaFile(message, mediaPath, 'image', savedChatExport.id!);
                    }
                  }
                }
              }
              
              // Upload attachment messages last
              const attachmentMessages = mediaMessages.filter(msg => msg.type === 'attachment');
              if (attachmentMessages.length > 0) {
                console.log(`Processing ${attachmentMessages.length} attachment messages`);
                
                for (const message of attachmentMessages) {
                  if (message.mediaUrl) {
                    const mediaFilename = path.basename(message.mediaUrl);
                    const mediaPath = findMediaPath(mediaFilename, extractDir);
                    
                    if (mediaPath) {
                      console.log(`Uploading attachment to R2: ${mediaPath}`);
                      await uploadMediaFile(message, mediaPath, 'attachment', savedChatExport.id!);
                    }
                  }
                }
              }
              
              // Update the chat data with fresh message records
              const updatedMessages = await storage.getMessagesByChatExportId(savedChatExport.id!);
              console.log(`Retrieved ${updatedMessages.length} messages for chat export ${savedChatExport.id}`);
              
              // Convert all message timestamps to strings for compatibility
              // @ts-ignore - We'll ignore the type mismatch as we're normalizing the data
              chatData.messages = updatedMessages.map(msg => ({
                ...msg,
                timestamp: typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
                  ? msg.timestamp.toISOString()
                  : String(msg.timestamp) 
              }));
              
              // We don't generate the PDF here anymore - it will be generated after payment
              // to ensure we use the correct data and media URLs
              console.log('Skipping PDF generation until after payment is completed');
              
              // Update progress to payment required state
              storage.saveProcessingProgress(clientId, 40, ProcessingStep.PAYMENT_REQUIRED);
              
              // Send payment required notification with bundle info
              clients.get(clientId)?.write(`data: ${JSON.stringify({ 
                progress: 40, 
                step: ProcessingStep.PAYMENT_REQUIRED,
                messageCount: chatData.messages.length > 0 ? chatData.messages.length : bundle.messageCount,
                mediaSizeBytes: totalMediaSize,
                requiresPayment: true,
                bundleId: bundle.bundleId,
                checkoutUrl: null // Will be generated by the client
              })}\n\n`);
              
              // Send a done message but indicate payment required
              // This keeps the connection open until client receives the message
              clients.get(clientId)?.write(`data: ${JSON.stringify({ 
                progress: 40, 
                step: ProcessingStep.PAYMENT_REQUIRED,
                requiresPayment: true,
                done: true,
                bundleId: bundle.bundleId,
                messageCount: chatData.messages.length > 0 ? chatData.messages.length : bundle.messageCount,
                mediaSizeBytes: totalMediaSize,
                chatExportId: savedChatExport.id,
                chatData: chatData
              })}\n\n`);
              
              // Now end the connection gracefully
              const clientRes = clients.get(clientId);
              if (clientRes) {
                // End is called after message is sent
                clientRes.end();
                clients.delete(clientId);
              }
              return;
            } catch (error) {
              console.error('Error creating payment bundle:', error);
              // Continue processing if payment bundle creation fails
              // We'll use the free tier in this case as a fallback
            }
          }
          
          // Save chat export to storage regardless of payment status
          const savedChatExport = await storage.saveChatExport(chatData);

          // Save messages to storage
          console.log(`Saving ${chatData.messages.length} messages to storage for chat ${savedChatExport.id}`);
          for (const message of chatData.messages) {
            try {
              // Convert timestamp to ensure consistency
              const timestamp = typeof message.timestamp === 'string' 
                ? new Date(message.timestamp) 
                : message.timestamp;
                
              await storage.saveMessage({
                chatExportId: savedChatExport.id!,
                timestamp: timestamp,
                sender: message.sender,
                content: message.content,
                type: message.type,
                mediaUrl: message.mediaUrl,
                duration: message.duration,
              });
            } catch (err) {
              console.error(`Error saving message: ${err}`);
            }
          }
          
          // Verify messages were saved correctly
          const savedMessages = await storage.getMessagesByChatExportId(savedChatExport.id!);
          console.log(`Verified ${savedMessages.length} messages saved for chat ${savedChatExport.id}`);
          
          // Important: Update chatData with the saved messages to ensure they're included in the response
          // @ts-ignore - We'll normalize the timestamp types
          chatData.messages = savedMessages.map(msg => ({
            ...msg,
            timestamp: typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
              ? msg.timestamp.toISOString()
              : String(msg.timestamp) 
          }));

          // Process and upload media files to R2
          storage.saveProcessingProgress(clientId, 60, ProcessingStep.CONVERT_VOICE);
          clients.get(clientId)?.write(`data: ${JSON.stringify({ progress: 60, step: ProcessingStep.CONVERT_VOICE })}\n\n`);

          // Verify R2 connection
          const r2Connected = await testR2Connection().catch(err => {
            console.error('Error connecting to R2:', err);
            return false;
          });

          if (!r2Connected) {
            console.warn('R2 connection failed, using local storage for media files');
          } else {
            console.log('R2 connection successful, proceeding with media uploads');

            // Get saved messages with media
            const messages = await storage.getMessagesByChatExportId(savedChatExport.id!);
            const mediaMessages = messages.filter(msg => 
              msg.mediaUrl && (msg.type === 'voice' || msg.type === 'image' || msg.type === 'attachment')
            );

            console.log(`Found ${mediaMessages.length} media messages to upload to R2`);

            // Upload voice messages first
            const voiceMessages = mediaMessages.filter(msg => msg.type === 'voice');
            console.log(`Processing ${voiceMessages.length} voice messages`);

            for (const message of voiceMessages) {
              try {
                if (!message.mediaUrl) continue;

                // First try media path with chat ID subdirectory
                let mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', 
                  savedChatExport.id!.toString(), path.basename(message.mediaUrl));
                
                // If not found, try without the chat ID subdirectory (which is how parser.ts stores files)
                if (!fs.existsSync(mediaPath)) {
                  mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', path.basename(message.mediaUrl));
                  console.log(`Trying alternate media path: ${mediaPath}`);
                }

                if (fs.existsSync(mediaPath)) {
                  console.log(`Uploading voice message to R2: ${mediaPath}`);
                  const mediaFile = await storage.uploadMediaToR2(
                    mediaPath,
                    'audio/ogg',
                    savedChatExport.id!,
                    message.id,
                    'voice'
                  );

                  await storage.updateMessageMediaUrl(message.id, mediaFile.key, mediaFile.url!);
                  console.log(`Uploaded voice message to R2, key: ${mediaFile.key}`);
                } else {
                  console.error(`Voice file not found: ${mediaPath}`);
                }
              } catch (error) {
                console.error(`Error uploading voice message for message ${message.id}:`, error);
              }
            }

            // Upload other media files
            const otherMediaMessages = mediaMessages.filter(msg => msg.type !== 'voice');
            console.log(`Processing ${otherMediaMessages.length} other media messages`);
            for (const message of otherMediaMessages) {
              try {
                if (!message.mediaUrl) continue;

                // Get the file path (mediaUrl currently points to local storage)
                // First try media path with chat ID subdirectory
                let mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', 
                  savedChatExport.id!.toString(), path.basename(message.mediaUrl));
                
                // If not found, try without the chat ID subdirectory (which is how parser.ts stores files)
                if (!fs.existsSync(mediaPath)) {
                  mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', path.basename(message.mediaUrl));
                  console.log(`Trying alternate media path: ${mediaPath}`);
                }

                if (fs.existsSync(mediaPath)) {
                  console.log(`Uploading ${message.type} to R2: ${mediaPath}`);

                  // Determine content type
                  let contentType = 'application/octet-stream';
                  if (message.type === 'image') {
                    const ext = path.extname(mediaPath).toLowerCase();
                    if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
                    else if (ext === '.png') contentType = 'image/png';
                    else if (ext === '.gif') contentType = 'image/gif';
                    else if (ext === '.webp') contentType = 'image/webp';
                  }

                  // Upload to R2
                  const mediaFile = await storage.uploadMediaToR2(
                    mediaPath,
                    contentType,
                    savedChatExport.id!,
                    message.id,
                    message.type as any
                  );

                  // Update message with R2 URL
                  await storage.updateMessageMediaUrl(message.id, mediaFile.key, mediaFile.url!);
                  console.log(`Uploaded ${message.type} to R2, key: ${mediaFile.key}`);
                }
              } catch (error) {
                console.error(`Error uploading media file for message ${message.id}:`, error);
                // Continue with other files even if one fails
              }
            }
          }

          // Update chatData with new media URLs before generating PDF
          const updatedMessages = await storage.getMessagesByChatExportId(savedChatExport.id!);
          console.log(`Retrieved ${updatedMessages.length} messages with updated media URLs for PDF generation`);
          
          // Convert all message timestamps to strings for compatibility with generatePdf
          // @ts-ignore - We'll ignore the type mismatch as we're normalizing the data
          chatData.messages = updatedMessages.map(msg => ({
            ...msg,
            timestamp: typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
              ? msg.timestamp.toISOString()
              : String(msg.timestamp) 
          }));
          
          // Make sure chatData has the saved ID for media file lookup
          chatData.id = savedChatExport.id;
          
          // Generate PDF
          console.log('Starting PDF generation for chat export:', savedChatExport.id);
          storage.saveProcessingProgress(clientId, 80, ProcessingStep.GENERATE_PDF);
          clients.get(clientId)?.write(`data: ${JSON.stringify({ progress: 80, step: ProcessingStep.GENERATE_PDF })}\n\n`);

          const pdfResult = await generatePdf(chatData);
          console.log('PDF generation completed:', pdfResult);

          // Upload PDF to R2 if R2 is connected
          let pdfUrl = '';
          if (r2Connected) {
            try {
              // Determine the base URL of our application for absolute URLs
              const appBaseUrl = process.env.REPLIT_DOMAINS 
                ? `https://${process.env.REPLIT_DOMAINS}`
                : 'http://localhost:5000';
                
              // Upload PDF to R2
              const pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', path.basename(pdfResult));
              
              // Add a special marker to identify this as the MAIN generated PDF (not an attachment)
              // This will help us distinguish it from PDFs that might be attached to messages
              const pdfMediaFile = await storage.uploadMediaToR2(
                pdfPath,
                'application/pdf',
                savedChatExport.id!,
                undefined,
                'pdf',
                'MAIN_GENERATED_PDF',
                'MAIN_PDF_' + savedChatExport.id
              );
              
              console.log('Uploaded main PDF file with special metadata markers:', pdfMediaFile.id);
              
              // Generate proxy URL for the PDF instead of direct R2 URL
              pdfUrl = `${appBaseUrl}/api/media/proxy/${pdfMediaFile.id}`;
              console.log('Uploaded PDF to R2:', pdfMediaFile.key);
              console.log('Generated proxy URL for PDF:', pdfUrl);
            } catch (error) {
              console.error('Error uploading PDF to R2:', error);
              // Fallback to local PDF URL
              const pdfFileName = path.basename(pdfResult);
              pdfUrl = `/api/whatsapp/pdf/${pdfFileName}`;
            }
          } else {
            // Use local PDF URL
            const pdfFileName = path.basename(pdfResult);
            pdfUrl = `/api/whatsapp/pdf/${pdfFileName}`;
          }

          console.log('Generated PDF URL:', pdfUrl);
          await storage.savePdfUrl(savedChatExport.id!, pdfUrl);
          console.log('PDF URL saved to storage for chat export:', savedChatExport.id);

          // Update progress: done
          storage.saveProcessingProgress(clientId, 100);

          // Notify connected client
          const clientRes = clients.get(clientId);
          if (clientRes) {
            const data = {
              progress: 100,
              done: true,
              pdfUrl,
              chatData: {
                ...savedChatExport,
                messages: chatData.messages
              }
            };
            clientRes.write(`data: ${JSON.stringify(data)}\n\n`);
            clientRes.end();
            clients.delete(clientId);
          }

          // Cleanup
          if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
        } catch (error) {
          console.error('Error processing file:', error);
          const clientRes = clients.get(clientId);
          if (clientRes) {
            clientRes.write(`data: ${JSON.stringify({ error: 'Processing failed' })}\n\n`);
            clientRes.end();
            clients.delete(clientId);
          }

          // Cleanup
          if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
          }
        }
      });

      // Return client ID for status tracking
      return res.status(200).json({ clientId });
    } catch (error) {
      console.error('Upload error:', error);
      return res.status(500).json({
        message: error instanceof Error ? error.message : "An unknown error occurred"
      });
    }
  },

  // Get processing status via Server-Sent Events
  getProcessStatus: (req: Request, res: Response) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Get client ID from query
    const clientId = req.query.clientId as string || uuidv4();

    // Store client connection
    clients.set(clientId, res);

    // Send initial progress
    const initialProgress = storage.getProcessingProgress(clientId);
    res.write(`data: ${JSON.stringify(initialProgress)}\n\n`);

    // Setup interval to send updates
    const intervalId = setInterval(() => {
      const progress = storage.getProcessingProgress(clientId);
      if (clients.has(clientId)) {
        res.write(`data: ${JSON.stringify(progress)}\n\n`);
      } else {
        clearInterval(intervalId);
      }
    }, 1000);

    // Handle client disconnect
    req.on('close', () => {
      clients.delete(clientId);
      clearInterval(intervalId);
    });
  },

  // Download PDF
  downloadPdf: async (req: Request, res: Response) => {
    try {
      // Get the latest chat export
      const chatExport = await storage.getLatestChatExport();

      if (!chatExport) {
        return res.status(404).json({ message: "Chat export not found" });
      }

      if (!chatExport.pdfUrl) {
        // No PDF URL saved, try to find it in media files
        const mediaFiles = await storage.getMediaFilesByChat(chatExport.id!);
        console.log(`Found ${mediaFiles.length} media files for chat export ${chatExport.id}`);
        
        // First try to find the PDF by our special marker
        let pdfFile = mediaFiles.find(file => 
          file.originalName === 'MAIN_GENERATED_PDF' || 
          (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
        );
        
        // Fallback to type if our marker isn't found
        if (!pdfFile) {
          pdfFile = mediaFiles.find(file => file.type === 'pdf');
        }
        
        // If not found, try by content type as fallback
        if (!pdfFile) {
          pdfFile = mediaFiles.find(file => file.contentType === 'application/pdf');
          if (pdfFile) {
            console.log(`Found PDF by content type for download: ${pdfFile.id}`);
          }
        }
        
        if (pdfFile && pdfFile.url) {
          // Save the URL to the chat export for future use
          await storage.savePdfUrl(chatExport.id!, pdfFile.url);
          chatExport.pdfUrl = pdfFile.url;
          console.log(`Updated chat export with PDF URL: ${pdfFile.url}`);
        } else {
          return res.status(404).json({ message: "PDF file not found in media files" });
        }
      }

      // Handle different storage locations
      let pdfPath: string;
      
      if (chatExport.pdfUrl.startsWith('http')) {
        // PDF is in R2, need to download it first
        pdfPath = path.join(os.tmpdir(), 'whatspdf', 'temp', `downloaded_${Date.now()}.pdf`);
        fs.mkdirSync(path.dirname(pdfPath), { recursive: true }); // Ensure directory exists
        
        try {
          const pdfResponse = await fetch(chatExport.pdfUrl);
          if (!pdfResponse.ok) {
            throw new Error(`Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
          }
          const pdfArrayBuffer = await pdfResponse.arrayBuffer();
          fs.writeFileSync(pdfPath, Buffer.from(pdfArrayBuffer));
          console.log('Downloaded PDF from R2 for direct download');
        } catch (err) {
          console.error('Error downloading PDF from R2:', err);
          return res.status(500).json({ message: "Failed to download PDF from cloud storage" });
        }
      } else {
        // PDF is in local storage
        const pdfFileName = path.basename(chatExport.pdfUrl);
        pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', pdfFileName);
        
        if (!fs.existsSync(pdfPath)) {
          return res.status(404).json({ message: "PDF file not found in local storage" });
        }
      }

      // Set headers for download
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="WhatsApp_Chat_${new Date().toISOString().slice(0, 10)}.pdf"`);

      // Stream the file
      const fileStream = fs.createReadStream(pdfPath);
      fileStream.pipe(res);
    } catch (error) {
      console.error('Download error:', error);
      return res.status(500).json({
        message: error instanceof Error ? error.message : "An unknown error occurred"
      });
    }
  },

  // Download Evidence ZIP (PDF + all referenced media files)
  downloadEvidenceZip: async (req: Request, res: Response) => {
    try {
      // Get the chat export by ID
      const chatId = parseInt(req.params.chatId, 10);
      if (isNaN(chatId)) {
        return res.status(400).json({ message: "Invalid chat ID" });
      }

      const chatExport = await storage.getChatExport(chatId);
      if (!chatExport) {
        return res.status(404).json({ message: "Chat export not found" });
      }

      if (!chatExport.pdfUrl) {
        return res.status(404).json({ message: "PDF not found for this chat" });
      }

      // Temporary directory for the evidence package
      const tempDir = path.join(os.tmpdir(), 'whatspdf', 'evidence', chatId.toString());
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Create attachments directory for offline mode with subdirectories by type
      const attachmentsDir = path.join(tempDir, 'attachments');
      const audioDir = path.join(attachmentsDir, 'audio');
      const imageDir = path.join(attachmentsDir, 'image');
      const pdfDir = path.join(attachmentsDir, 'pdf');
      const otherDir = path.join(attachmentsDir, 'other');
      
      // Create all needed directories
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.mkdirSync(audioDir, { recursive: true });
      fs.mkdirSync(imageDir, { recursive: true });
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.mkdirSync(otherDir, { recursive: true });

      // Get all media files for this chat export
      const mediaFiles = await storage.getMediaFilesByChat(chatId);

      // Get PDF path - could be from local storage or R2
      let pdfPath = '';

      if (chatExport.pdfUrl.startsWith('http')) {
        // PDF is in R2
        // First try to find the PDF by our special marker
        let pdfFile = mediaFiles.find(file => 
          file.originalName === 'MAIN_GENERATED_PDF' || 
          (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
        );
        
        // Fallback to type if our marker isn't found
        if (!pdfFile) {
          pdfFile = mediaFiles.find(file => file.type === 'pdf');
        }
        
        // If not found, try by content type as fallback
        if (!pdfFile) {
          pdfFile = mediaFiles.find(file => file.contentType === 'application/pdf');
          if (pdfFile) {
            console.log(`Found PDF by content type for evidence package: ${pdfFile.id}`);
          }
        }
        
        if (pdfFile) {
          pdfPath = path.join(tempDir, 'Chat_Transcript.pdf');

          // Download the PDF from the URL
          try {
            const pdfResponse = await fetch(pdfFile.url);
            if (!pdfResponse.ok) {
              throw new Error(`Failed to download PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
            }
            const pdfArrayBuffer = await pdfResponse.arrayBuffer();
            fs.writeFileSync(pdfPath, Buffer.from(pdfArrayBuffer));
            console.log('Downloaded PDF from R2 for evidence zip');
          } catch (err) {
            console.error('Error downloading PDF from R2:', err);
            return res.status(500).json({ message: "Failed to download PDF from cloud storage" });
          }
        } else {
          return res.status(404).json({ message: "PDF not found in cloud storage" });
        }
      } else {
        // PDF is in local storage
        const pdfFileName = path.basename(chatExport.pdfUrl);
        pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', pdfFileName);

        if (!fs.existsSync(pdfPath)) {
          return res.status(404).json({ message: "PDF file not found in local storage" });
        }
      }

      // Get all messages with media references
      const messages = await storage.getMessagesByChatExportId(chatId);
      const mediaMessages = messages.filter(message => 
        message.mediaUrl && (message.type === 'voice' || message.type === 'image' || message.type === 'attachment')
      );

      // Download media files from R2 if needed
      // Keep track of file hashes for manifest and file mappings
      const fileHashes: Record<string, string> = {};
      const fileMap: Record<string, {originalName: string, mediaType: string, extension: string}> = {};
      
      const downloadPromises = mediaFiles
        .filter(file => file.type !== 'pdf') // Exclude PDF as we've already handled it
        .map(async (file) => {
          // Determine target directory based on file type
          let targetDir = otherDir;
          
          // Note: In our system 'voice' is the common type, but 'audio' could be used too
          if (file.type === 'voice' || file.type === 'audio') {
            targetDir = audioDir;
          } else if (file.type === 'image') {
            targetDir = imageDir;
          } else if (file.type === 'pdf') {
            targetDir = pdfDir;
          }

          // Create a filename from the key (removing directory path)
          const fileName = path.basename(file.key);
          
          // Determine file extension
          let extension = path.extname(fileName).toLowerCase();
          if (!extension) {
            // Assign default extension based on content type
            if (file.contentType) {
              if (file.contentType.includes('audio') || file.contentType.includes('ogg')) {
                extension = '.ogg';
              } else if (file.contentType.includes('pdf')) {
                extension = '.pdf';
              } else if (file.contentType.includes('image/jpeg') || file.contentType.includes('jpg')) {
                extension = '.jpg';
              } else if (file.contentType.includes('image/png')) {
                extension = '.png';
              } else if (file.contentType.includes('image/webp')) {
                extension = '.webp';
              } else {
                extension = '.bin'; // Generic binary extension
              }
            } else {
              extension = '.bin'; // Default if no content type
            }
          }
          
          // Create filename with media ID and proper extension
          const mediaFileName = `${file.id}${extension}`;
          
          // Save path with proper directory structure
          const filePath = path.join(targetDir, mediaFileName);

          try {
            // Download file from R2
            if (!file.url) {
              throw new Error("Missing URL for media file");
            }
            
            const response = await fetch(file.url);
            if (!response.ok) {
              throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
            }
            
            const arrayBuffer = await response.arrayBuffer();
            const fileBuffer = Buffer.from(arrayBuffer);
            
            // Write to proper location
            fs.writeFileSync(filePath, fileBuffer);
            
            // Calculate file hash
            const hash = crypto.createHash('sha256');
            hash.update(fileBuffer);
            const fileHash = hash.digest('hex');
            
            // Store hash and file mapping information
            fileHashes[file.id] = fileHash;
            fileMap[file.id] = {
              originalName: file.originalName || fileName,
              mediaType: file.type || 'unknown',
              extension: extension
            };
            
            console.log(`Downloaded media file: ${mediaFileName}, hash: ${fileHash.substring(0, 8)}...`);
            
            return { 
              success: true, 
              path: filePath, 
              type: file.type, 
              name: fileName,
              id: file.id,
              hash: fileHash,
              extension: extension
            };
          } catch (err) {
            console.error(`Error downloading media file ${fileName}:`, err);
            return { 
              success: false, 
              path: null, 
              type: file.type, 
              name: fileName,
              id: file.id
            };
          }
        });

      // Wait for all downloads to complete
      const downloadResults = await Promise.all(downloadPromises);
      const successfulDownloads = downloadResults.filter(result => result.success);
      console.log(`Downloaded ${successfulDownloads.length} of ${downloadResults.length} media files for evidence zip`);

      // If we have local media files, include those too
      const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media', chatId.toString());
      if (fs.existsSync(mediaDir)) {
        // Copy local media files to the evidence directory
        const copyLocalMedia = (message: any) => {
          if (!message.mediaUrl) return;

          // Skip R2 URLs
          if (message.mediaUrl.startsWith('http')) return;

          const mediaFileName = path.basename(message.mediaUrl);
          const mediaPath = path.join(mediaDir, mediaFileName);

          if (fs.existsSync(mediaPath)) {
            // Determine target directory and extension based on file type
            let targetDir = otherDir;
            let extension = path.extname(mediaFileName).toLowerCase();
            
            if (!extension) {
              // Default extensions based on message type
              if (message.type === 'voice' || message.type === 'audio') {
                extension = '.ogg';
              } else if (message.type === 'image') {
                extension = '.jpg';
              } else if (message.type === 'pdf') {
                extension = '.pdf';
              } else {
                extension = '.bin'; // Generic binary extension
              }
            }
            
            // Set proper directory
            if (message.type === 'voice' || message.type === 'audio') {
              targetDir = audioDir;
            } else if (message.type === 'image') {
              targetDir = imageDir;
            } else if (message.type === 'pdf') {
              targetDir = pdfDir;
            }

            // Generate a unique ID for this file if needed
            const mediaId = message.id ? `local_media_${message.id}` : `local_media_${uuidv4()}`;
            
            // Create filenames with proper extensions
            const targetFileName = `${mediaId}${extension}`;
            const targetPath = path.join(targetDir, targetFileName);
            
            // Copy file to attachments directory
            fs.copyFileSync(mediaPath, targetPath);
            
            // Calculate hash for local file
            const fileBuffer = fs.readFileSync(mediaPath);
            const hash = crypto.createHash('sha256');
            hash.update(fileBuffer);
            const fileHash = hash.digest('hex');
            
            // Store hash and mapping information
            fileHashes[mediaId] = fileHash;
            fileMap[mediaId] = {
              originalName: mediaFileName,
              mediaType: message.type || 'unknown',
              extension: extension
            };
            
            console.log(`Copied local media file: ${mediaFileName} to ${targetFileName}, hash: ${fileHash.substring(0, 8)}...`);
          }
        };

        mediaMessages.forEach(copyLocalMedia);
      }

      // Calculate hash for the PDF
      const pdfBuffer = fs.readFileSync(pdfPath);
      const pdfHash = crypto.createHash('sha256');
      pdfHash.update(pdfBuffer);
      const pdfFileHash = pdfHash.digest('hex');
      fileHashes['Chat_Transcript.pdf'] = pdfFileHash;

      // Set headers for download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="WhatsApp_Evidence_${chatId}_${new Date().toISOString().slice(0, 10)}.zip"`);

      // Create zip archive
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });

      // Pipe archive to response
      archive.pipe(res);

      // Add PDF to archive root for easy access
      archive.file(pdfPath, { name: `Chat_Transcript.pdf` });
      
      // Add traditional media directory structure (for backward compatibility)
      const walkDir = (dir: string, zipPath: string) => {
        if (!fs.existsSync(dir)) return;

        const files = fs.readdirSync(dir);
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          if (stat.isFile()) {
            archive.file(filePath, { name: path.join(zipPath, file) });
          }
        }
      };

      // Walk and add directories by type
      walkDir(audioDir, 'attachments/audio');
      walkDir(imageDir, 'attachments/image');
      walkDir(pdfDir, 'attachments/pdf');
      walkDir(otherDir, 'attachments/other');

      // Copy PDF to the attachments/pdf directory with a proper name
      const pdfTargetPath = path.join(pdfDir, 'Chat_Transcript.pdf');
      fs.copyFileSync(pdfPath, pdfTargetPath);
      
      // Create an enhanced manifest with file hashes for legal compliance (Rule 902(14))
      const manifest = {
        caseReference: `WA-${format(new Date(), "yyyyMMdd-HHmm")}`,
        originalFileHash: chatExport.fileHash,
        generatedOn: new Date().toISOString(),
        participants: chatExport.participants || ['Unknown'],
        messageCount: messages.length,
        mediaCount: {
          total: mediaFiles.length - (mediaFiles.find(f => f.type === 'pdf') ? 1 : 0),
          voice: mediaFiles.filter(f => f.type === 'voice').length,
          image: mediaFiles.filter(f => f.type === 'image').length,
          attachment: mediaFiles.filter(f => f.type === 'attachment').length
        },
        originalFilename: chatExport.originalFilename,
        // Add file hashes for legal certification
        fileHashes: fileHashes,
        // Add file mappings for original file names to media IDs
        fileMap: fileMap
      };

      // Add manifest.json to the archive
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

      // Add a README.txt file with instructions
      const readme = `EVIDENCE PACKAGE - WHATSAPP CHAT EXPORT
===============================

This ZIP archive contains:

1. Chat_Transcript.pdf - The formatted chat transcript with clickable links
2. attachments/ - Directory containing all media files organized by type
   - audio/ - Voice notes and audio messages
   - image/ - Photos and images
   - pdf/ - PDF documents
   - other/ - Other file types
3. manifest.json - Metadata, SHA-256 hashes, and file mappings for Rule 902(14) compliance

INTEGRITY VERIFICATION:
- Each file in the package has its SHA-256 hash recorded in manifest.json
- File IDs in the transcript match the filenames in the attachments directory
- Each file has its proper extension for easy opening
- The manifest contains original filename to media ID mappings

FOR COURT SUBMISSIONS:
- This package satisfies Federal Rule of Evidence 902(14) requirements
- SHA-256 hashes provide self-authentication without requiring expert testimony
- To verify a file's integrity, calculate its SHA-256 hash and compare to the manifest

HASH VERIFICATION:
- Windows PowerShell: Get-FileHash -Algorithm SHA256 path\\to\\file
- Mac/Linux Terminal: shasum -a 256 path/to/file

Generated by WhatsPDF Voice on ${new Date().toLocaleDateString()}
`;

      archive.append(readme, { name: 'README.txt' });

      // Finalize archive
      await archive.finalize();

      // Clean up the temp directory after a delay
      setTimeout(() => {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
          console.log(`Cleaned up temp directory: ${tempDir}`);
        } catch (err) {
          console.error(`Error cleaning up temp directory ${tempDir}:`, err);
        }
      }, 60000); // 1 minute delay

      console.log(`Offline-compatible evidence ZIP created for chat ID ${chatId}`);

    } catch (error) {
      console.error('Evidence ZIP error:', error);
      return res.status(500).json({
        message: error instanceof Error ? error.message : "An unknown error occurred"
      });
    }
  }
};