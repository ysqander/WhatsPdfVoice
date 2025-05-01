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

  const httpServer = createServer(app);

  return httpServer;
}
