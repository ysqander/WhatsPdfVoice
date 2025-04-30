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
    if (file.mimetype === "application/zip" || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  // API routes
  app.post('/api/whatsapp/process', upload.single('file'), uploadController.processFile);
  app.get('/api/whatsapp/process-status', uploadController.getProcessStatus);
  app.get('/api/whatsapp/download', uploadController.downloadPdf);

  const httpServer = createServer(app);

  return httpServer;
}
