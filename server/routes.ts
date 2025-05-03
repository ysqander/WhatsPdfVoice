import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { uploadController } from "./controllers/uploadController";

// Setup temporary upload directory
const tempDir = path.join(os.tmpdir(), 'whatspdf-uploads');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Configure multer for file uploads
const storage2 = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, tempDir);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${uuidv4()}`;
    cb(null, `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  },
});

// Create multer instance with file size limits
const upload = multer({
  storage: storage2,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (_req, file, cb) => {
    console.log('Multer processing file:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      fieldname: file.fieldname
    });
    
    if (file.mimetype === "application/zip" || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      console.error('File type rejected:', file.mimetype);
      cb(new Error('Only ZIP files are allowed'));
    }
  },
}).single('file');

// Wrap multer middleware to handle errors
const uploadMiddleware = (req: Request, res: Response, next: Function) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err);
      return res.status(400).json({ message: `Upload error: ${err.message}` });
    } else if (err) {
      console.error('Unknown upload error:', err);
      return res.status(400).json({ message: err.message });
    }
    next();
  });
};

export async function registerRoutes(app: Express): Promise<Server> {
  // API routes
  app.post('/api/whatsapp/process', uploadMiddleware, uploadController.processFile);
  app.get('/api/whatsapp/process-status', uploadController.getProcessStatus);
  app.get('/api/whatsapp/download', uploadController.downloadPdf);
  app.get('/api/whatsapp/evidence-zip/:chatId', uploadController.downloadEvidenceZip);
  
  // Add PDF serving route
  app.get('/api/whatsapp/pdf/:filename', (req, res) => {
    const filename = req.params.filename;
    const pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', filename);
    
    console.log('PDF request received:', {
      filename,
      pdfPath,
      exists: fs.existsSync(pdfPath)
    });
    
    if (!fs.existsSync(pdfPath)) {
      console.error('PDF file not found:', pdfPath);
      return res.status(404).json({ error: 'PDF not found' });
    }
    
    res.sendFile(pdfPath);
  });
  
  // Add media files serving route - for voice messages and other referenced media
  app.get('/media/:chatId/:filename', (req, res) => {
    const { chatId, filename } = req.params;
    const mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', chatId, filename);
    
    console.log('Media request received:', {
      chatId,
      filename,
      mediaPath,
      exists: fs.existsSync(mediaPath)
    });
    
    if (!fs.existsSync(mediaPath)) {
      console.error('Media file not found:', mediaPath);
      return res.status(404).json({ error: 'Media file not found' });
    }
    
    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    let contentType = 'application/octet-stream'; // Default
    
    if (ext === '.ogg' || ext === '.oga') {
      contentType = 'audio/ogg';
    } else if (ext === '.mp3') {
      contentType = 'audio/mpeg';
    } else if (ext === '.m4a') {
      contentType = 'audio/mp4';
    } else if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg';
    } else if (ext === '.png') {
      contentType = 'image/png';
    } else if (ext === '.gif') {
      contentType = 'image/gif';
    } else if (ext === '.pdf') {
      contentType = 'application/pdf';
    }
    
    // Set appropriate headers and send file
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.sendFile(mediaPath);
  });
  
  // R2 Media Management Routes
  
  // Get all media files for a chat
  app.get('/api/media/:chatId', async (req, res) => {
    try {
      const chatId = parseInt(req.params.chatId, 10);
      if (isNaN(chatId)) {
        return res.status(400).json({ error: 'Invalid chat ID' });
      }
      
      // Get all media files for this chat
      const mediaFiles = await storage.getMediaFilesByChat(chatId);
      
      return res.status(200).json({ media: mediaFiles });
    } catch (error) {
      console.error('Error fetching media files:', error);
      return res.status(500).json({ 
        error: 'Failed to fetch media files',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Delete a media file
  app.delete('/api/media/:mediaId', async (req, res) => {
    try {
      const { mediaId } = req.params;
      
      // Delete the media file
      await storage.deleteMedia(mediaId);
      
      return res.status(200).json({ success: true, message: 'Media deleted successfully' });
    } catch (error) {
      console.error('Error deleting media file:', error);
      return res.status(500).json({ 
        error: 'Failed to delete media file',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
