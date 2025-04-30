import { Request, Response } from "express";
import { storage } from "../storage";
import { parse } from "../lib/parser";
import { generatePdf } from "../lib/pdf";
import { ProcessingOptions, ProcessingStep } from "@shared/types";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import crypto from "crypto";

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
      if (!req.file) {
        return res.status(400).json({ message: "No file uploaded" });
      }
      
      // Generate client ID for tracking processing status
      const clientId = uuidv4();
      
      // Parse processing options
      const optionsStr = req.body.options || "{}";
      const options: ProcessingOptions = JSON.parse(optionsStr);
      
      // Start processing in background
      process.nextTick(async () => {
        try {
          // Update progress: extraction starting
          storage.saveProcessingProgress(clientId, 5, ProcessingStep.EXTRACT_ZIP);
          
          // Calculate file hash for verification
          const fileHash = await calculateFileHash(req.file!.path);
          
          // Parse the ZIP file and extract messages
          storage.saveProcessingProgress(clientId, 20, ProcessingStep.EXTRACT_ZIP);
          
          // Parse chat messages
          storage.saveProcessingProgress(clientId, 30, ProcessingStep.PARSE_MESSAGES);
          const chatData = await parse(req.file!.path, options);
          chatData.fileHash = fileHash;
          chatData.originalFilename = req.file!.originalname;
          chatData.processingOptions = options;
          
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
          
          // Generate PDF
          storage.saveProcessingProgress(clientId, 80, ProcessingStep.GENERATE_PDF);
          const pdfPath = await generatePdf(chatData);
          
          // Save PDF URL
          const pdfUrl = `/api/whatsapp/pdf/${path.basename(pdfPath)}`;
          await storage.savePdfUrl(savedChatExport.id!, pdfUrl);
          
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
      const pdfPath = path.join(process.cwd(), 'temp', 'pdfs', pdfFileName);
      
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
  }
};
