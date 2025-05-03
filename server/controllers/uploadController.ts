import { Request, Response } from "express";
import { storage } from "../storage";
import { parse } from "../lib/parser";
import { generatePdf } from "../lib/pdf";
import { ProcessingOptions, ProcessingStep } from "@shared/types";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import archiver from "archiver";
import os from "os";
import { format } from "date-fns";

// Map to store client connections for SSE
const clients = new Map<string, Response>();

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
          const chatData = await parse(req.file!.path, options).catch(error => {
            console.error('Error parsing file:', error);
            throw new Error(`Failed to parse file: ${error.message}`);
          });
          console.log('Parse completed successfully');
          chatData.fileHash = fileHash;
          chatData.originalFilename = req.file!.originalname;
          chatData.processingOptions = JSON.stringify(options);
          
          // Save chat export to storage
          const savedChatExport = await storage.saveChatExport(chatData);
          
          // Save messages to storage
          for (const message of chatData.messages) {
            await storage.saveMessage({
              chatExportId: savedChatExport.id!,
              timestamp: new Date(message.timestamp),
              sender: message.sender,
              content: message.content,
              type: message.type,
              mediaUrl: message.mediaUrl,
              duration: message.duration,
            });
          }
          
          // Process voice messages
          storage.saveProcessingProgress(clientId, 60, ProcessingStep.CONVERT_VOICE);
          clients.get(clientId)?.write(`data: ${JSON.stringify({ progress: 60, step: ProcessingStep.CONVERT_VOICE })}\n\n`);
          
          // Generate PDF
          console.log('Starting PDF generation for chat export:', savedChatExport.id);
          storage.saveProcessingProgress(clientId, 80, ProcessingStep.GENERATE_PDF);
          clients.get(clientId)?.write(`data: ${JSON.stringify({ progress: 80, step: ProcessingStep.GENERATE_PDF })}\n\n`);
          
          const pdfResult = await generatePdf(chatData);
          console.log('PDF generation completed:', pdfResult);
          
          // Save PDF URL
          const pdfFileName = path.basename(pdfResult);
          console.log('Generated PDF filename:', pdfFileName);
          const pdfUrl = `/api/whatsapp/pdf/${pdfFileName}`;
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
      
      if (!chatExport || !chatExport.pdfUrl) {
        return res.status(404).json({ message: "PDF not found" });
      }
      
      // Extract file name from the URL
      const pdfFileName = path.basename(chatExport.pdfUrl);
      const pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', pdfFileName);
      
      if (!fs.existsSync(pdfPath)) {
        return res.status(404).json({ message: "PDF file not found" });
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
      
      // Get the PDF path
      const pdfFileName = path.basename(chatExport.pdfUrl);
      const pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', pdfFileName);
      
      if (!fs.existsSync(pdfPath)) {
        return res.status(404).json({ message: "PDF file not found" });
      }
      
      // Get all messages with media files
      const messages = await storage.getMessagesByChatExportId(chatId);
      const mediaMessages = messages.filter(message => 
        message.mediaUrl && (message.type === 'voice' || message.type === 'image' || message.type === 'attachment')
      );
      
      // Set headers for download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="WhatsApp_Evidence_${chatId}_${new Date().toISOString().slice(0, 10)}.zip"`);
      
      // Create zip archive
      const archive = archiver('zip', {
        zlib: { level: 9 } // Maximum compression
      });
      
      // Pipe archive to response
      archive.pipe(res);
      
      // Add PDF to archive
      archive.file(pdfPath, { name: `Chat_Transcript.pdf` });
      
      // Create media directory in archive
      const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media', chatId.toString());
      
      // Add media files to archive
      for (const message of mediaMessages) {
        if (message.mediaUrl) {
          const mediaFileName = path.basename(message.mediaUrl);
          const mediaPath = path.join(mediaDir, mediaFileName);
          
          if (fs.existsSync(mediaPath)) {
            // Organize files by type
            let subDir = 'other';
            if (message.type === 'voice') {
              subDir = 'voice_messages';
            } else if (message.type === 'image') {
              subDir = 'images';
            }
            
            archive.file(mediaPath, { name: `media/${subDir}/${mediaFileName}` });
          }
        }
      }
      
      // Add a manifest file with metadata
      const manifest = {
        caseReference: `WA-${format(new Date(), "yyyyMMdd-HHmm")}`,
        fileHash: chatExport.fileHash,
        generatedOn: new Date().toISOString(),
        participants: chatExport.participants || ['Unknown'],
        messageCount: messages.length,
        mediaCount: mediaMessages.length,
        originalFilename: chatExport.originalFilename
      };
      
      // Add manifest.json to the archive
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      
      // Add a README.txt file with instructions
      const readme = `EVIDENCE PACKAGE - WHATSAPP CHAT EXPORT
===============================

This ZIP archive contains:

1. Chat_Transcript.pdf - The formatted chat transcript with clickable links
2. media/ - Directory containing all media files referenced in the transcript
   - voice_messages/ - Voice notes from the conversation
   - images/ - Images shared in the chat
   - other/ - Other attachments from the conversation
3. manifest.json - Metadata about this evidence package

For court submissions:
- The PDF transcript contains all messages in a printable format
- Voice messages can be played by clicking the links in the PDF
- All media files are included in their original format for verification

Generated by WhatsPDF Voice on ${new Date().toLocaleDateString()}
`;
      
      archive.append(readme, { name: 'README.txt' });
      
      // Finalize archive
      await archive.finalize();
      
      console.log(`Evidence ZIP created for chat ID ${chatId}`);
      
    } catch (error) {
      console.error('Evidence ZIP error:', error);
      return res.status(500).json({
        message: error instanceof Error ? error.message : "An unknown error occurred"
      });
    }
  }
};
