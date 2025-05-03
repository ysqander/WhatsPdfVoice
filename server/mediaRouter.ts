import { Router, Request, Response } from "express";
import { getSignedR2Url } from "./lib/r2Storage";
import { storage } from "./storage";

const router = Router();

/**
 * Media proxy endpoint
 * This route gets a media file key from storage and redirects to a freshly
 * generated R2 presigned URL. This approach allows us to have links that
 * remain valid for longer than the 7-day AWS SDK limit.
 */
router.get('/api/media/proxy/:mediaId', async (req: Request, res: Response) => {
  try {
    const { mediaId } = req.params;
    console.log(`Media proxy request received for ID: ${mediaId}`);
    
    // Get the media file from storage
    const mediaFile = await storage.getMediaFile(mediaId);
    
    if (!mediaFile) {
      console.error(`Media file not found with ID: ${mediaId}`);
      return res.status(404).json({ error: 'Media file not found' });
    }
    
    console.log(`Found media file: ${JSON.stringify(mediaFile, null, 2)}`);
    
    // Generate a fresh signed URL (1 hour expiration)
    const signedUrl = await getSignedR2Url(mediaFile.key, 60 * 60);
    console.log(`Generated signed URL: ${signedUrl}`);
    
    // Redirect to the actual R2 URL
    console.log(`Redirecting to R2 URL`);
    return res.redirect(signedUrl);
  } catch (error) {
    console.error('Failed to proxy media request:', error);
    return res.status(500).json({ 
      error: 'Error generating signed URL',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Legacy media file route - kept for compatibility with older PDFs
 * This will still work with filesystem-based media
 */
router.get('/media/:chatId/:filename', (req: Request, res: Response) => {
  const { chatId, filename } = req.params;
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  
  const mediaPath = path.join(os.tmpdir(), 'whatspdf', 'media', chatId, filename);
  
  if (!fs.existsSync(mediaPath)) {
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

export default router;