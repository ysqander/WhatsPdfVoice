import express, { type Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import path from "path";
import fs from "fs";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import { uploadController } from "./controllers/uploadController";
import mediaRouter from "./mediaRouter";
import Stripe from "stripe";
import { paymentService } from "./lib/paymentService";

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
  // Register the media router for proxy endpoints
  app.use(mediaRouter);
  
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

  // Initialize Stripe
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('STRIPE_SECRET_KEY is not set. Payment features will not work properly.');
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2023-10-16' as any,
  });

  // Webhook signing secret - would come from Stripe dashboard in production
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Checkout routes
  app.post('/api/checkout/:bundleId', async (req, res) => {
    try {
      const { bundleId } = req.params;
      const { email } = req.body;
      
      // Get bundle from database
      const bundle = await paymentService.getBundleById(bundleId);
      if (!bundle) {
        return res.status(404).json({ error: 'Bundle not found' });
      }
      
      // Get Stripe checkout session
      const session = await stripe.checkout.sessions.retrieve(bundle.stripeSessionId);
      
      // Return checkout session URL
      res.json({ 
        success: true, 
        checkoutUrl: session.url
      });
    } catch (error) {
      console.error('Error creating checkout session:', error);
      res.status(500).json({ 
        error: 'Error creating checkout session',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Stripe Webhook endpoint - use a middleware that preserves the raw body
  app.post('/webhook/payment', (req, res, next) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      req.rawBody = data;
      next();
    });
  }, async (req: any, res) => {
    try {
      // Verify webhook signature if secret is available
      let event: Stripe.Event;
      
      if (webhookSecret) {
        const signature = req.headers['stripe-signature'] as string;
        try {
          event = stripe.webhooks.constructEvent(
            req.rawBody,
            signature,
            webhookSecret
          );
        } catch (err) {
          console.error(`⚠️ Webhook signature verification failed.`, err);
          return res.status(400).send('Webhook signature verification failed');
        }
      } else {
        // If no webhook secret is configured, use the event as-is (less secure)
        event = req.body as Stripe.Event;
      }
      
      // Handle the webhook event
      const success = await paymentService.handleWebhookEvent(event);
      
      if (success) {
        res.json({ received: true });
      } else {
        res.status(400).json({ error: 'Failed to process webhook' });
      }
    } catch (error) {
      console.error('Error handling webhook:', error);
      res.status(500).json({ 
        error: 'Error handling webhook',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  });
  
  // Payment success page
  app.get('/payment-success', async (req, res) => {
    try {
      const sessionId = req.query.session_id as string;
      
      if (!sessionId) {
        return res.status(400).send('No session ID provided');
      }
      
      // Get bundle by session ID
      const bundle = await paymentService.getBundleBySessionId(sessionId);
      
      if (!bundle) {
        return res.status(404).send('Bundle not found');
      }
      
      // Get signed URL
      const url = await paymentService.getSignedBundleUrl(bundle);
      
      // Redirect to client success page with bundle URL
      res.redirect(`/?success=true&bundleUrl=${encodeURIComponent(url)}`);
    } catch (error) {
      console.error('Error handling payment success:', error);
      res.status(500).send('Error processing payment');
    }
  });
  
  // Payment cancelled page
  app.get('/payment-cancelled', (_req, res) => {
    res.redirect('/?cancelled=true');
  });
  
  // Get bundle status and download link if paid
  app.get('/api/bundle/:bundleId', async (req, res) => {
    try {
      const { bundleId } = req.params;
      
      // Get bundle
      const bundle = await paymentService.getBundleById(bundleId);
      
      if (!bundle) {
        return res.status(404).json({ error: 'Bundle not found' });
      }
      
      // Get signed URL if bundle is paid
      let downloadUrl = null;
      if (bundle.isPaid) {
        downloadUrl = await paymentService.getSignedBundleUrl(bundle);
      }
      
      res.json({
        bundleId: bundle.id,
        isPaid: bundle.isPaid,
        messageCount: bundle.messageCount,
        mediaSizeBytes: bundle.mediaSizeBytes,
        downloadUrl
      });
    } catch (error) {
      console.error('Error getting bundle:', error);
      res.status(500).json({ error: 'Error getting bundle' });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
