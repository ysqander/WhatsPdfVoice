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
  app.post('/api/create-payment-intent', async (req, res) => {
    try {
      const { bundleId } = req.body;
      
      // Get the origin for success and cancel URLs
      const origin = `${req.protocol}://${req.get('host')}`;
      const successUrl = `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`;
      const cancelUrl = `${origin}/payment-cancelled`;
      
      // Create a checkout session
      const checkoutUrl = await paymentService.createCheckoutSession(
        bundleId,
        successUrl,
        cancelUrl
      );
      
      // Return the checkout URL
      res.json({ 
        success: true, 
        clientSecret: null, // For compatibility with the client expectation
        checkoutUrl
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
  app.post('/webhook/payment', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      // Log important info for debugging
      console.log('Webhook received. Headers:', {
        'content-type': req.headers['content-type'],
        'stripe-signature': req.headers['stripe-signature'] ? 'Present' : 'Missing'
      });
      
      if (!req.headers['stripe-signature']) {
        return res.status(400).send('Stripe signature header is missing');
      }
      
      const signature = req.headers['stripe-signature'] as string;
      const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
      
      if (!webhookSecret) {
        console.error('STRIPE_WEBHOOK_SECRET environment variable is not set');
        return res.status(500).send('Webhook secret is not configured');
      }
      
      // Verify the event
      let event;
      try {
        // Make sure req.body is a Buffer - express.raw middleware should handle this
        const payload = req.body;
        
        if (!payload) {
          throw new Error('No request body received');
        }
        
        console.log('Request body type:', typeof payload, payload instanceof Buffer);
        
        event = stripe.webhooks.constructEvent(
          payload, 
          signature, 
          webhookSecret
        );
      } catch (err) {
        console.error('⚠️ Webhook signature verification failed:', err);
        return res.status(400).send(`Webhook Error: ${err instanceof Error ? err.message : 'Unknown Error'}`);
      }
      
      console.log(`Webhook verified successfully: ${event.type}`);
      
      // Handle the webhook event type
      if (event.type === 'checkout.session.completed') {
        // Handle the checkout.session.completed event
        const session = event.data.object as Stripe.Checkout.Session;
        
        console.log('Processing checkout session:', {
          sessionId: session.id,
          bundleId: session.client_reference_id,
          customerId: session.customer,
          paymentStatus: session.payment_status
        });
        
        const bundle = await paymentService.handleCheckoutSessionCompleted(session.id);
        
        if (bundle) {
          console.log(`Payment succeeded for bundle ${bundle.bundleId}`);
          
          // Get the PDF URL from the bundle's chat export
          // In a real implementation, this would also move the PDF from temporary storage
          // to a more permanent location with a longer expiry time
          
          console.log(`Bundle marked as paid, valid for 30 days`);
          
          return res.json({ received: true });
        } else {
          console.error('Bundle not found or payment failed');
          return res.status(400).json({ error: 'Failed to process payment' });
        }
      } else {
        // Ignore other event types
        return res.json({ received: true });
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
      
      // Process the completed session
      const bundle = await paymentService.handleCheckoutSessionCompleted(sessionId);
      
      if (!bundle) {
        return res.status(404).send('Bundle not found or payment could not be processed');
      }
      
      // Redirect to client success page
      res.redirect(`/?success=true&bundleId=${bundle.bundleId}`);
    } catch (error) {
      console.error('Error handling payment success:', error);
      res.status(500).send('Error processing payment');
    }
  });
  
  // Payment cancelled page
  app.get('/payment-cancelled', (_req, res) => {
    res.redirect('/?cancelled=true');
  });
  
  // Get bundle status
  app.get('/api/payment/:bundleId', async (req, res) => {
    try {
      const { bundleId } = req.params;
      
      // Get bundle from database
      const bundle = await paymentService.getPaymentBundle(bundleId);
      
      if (!bundle) {
        return res.status(404).json({ error: 'Bundle not found' });
      }
      
      // Check if chat export exists in database
      const chatExportId = bundle.chatExportId;
      const isPaid = bundle.paidAt !== null;
      let pdfUrl = null;
      
      if (isPaid && chatExportId) {
        try {
          // Get chat export to obtain the PDF URL
          const chatExport = await storage.getChatExport(chatExportId);
          if (chatExport && chatExport.pdfUrl) {
            pdfUrl = chatExport.pdfUrl;
          }
        } catch (err) {
          console.error('Error retrieving chat export for paid bundle:', err);
        }
      }
      
      res.json({
        bundleId: bundle.bundleId,
        isPaid,
        messageCount: bundle.messageCount,
        mediaSizeBytes: bundle.mediaSizeBytes,
        pdfUrl,
        paidAt: bundle.paidAt,
        expiresAt: bundle.expiresAt
      });
    } catch (error) {
      console.error('Error getting bundle:', error);
      res.status(500).json({ error: 'Error getting bundle' });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}
