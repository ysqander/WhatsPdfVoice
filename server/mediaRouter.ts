import { Router, Request, Response } from "express";
import { mediaProxyStorage } from "./mediaProxyStorage";
import fs from "fs";
import path from "path";
import os from "os";

const router = Router();

/**
 * Media proxy endpoint
 * This route gets a media file from the database and redirects to a freshly
 * generated R2 presigned URL. This approach allows us to have links that
 * remain valid for longer than the 7-day AWS SDK limit.
 * 
 * The database only tracks the minimal necessary information:
 * - mediaId: UUID used in proxy URLs
 * - r2Key: R2 object key for generating signed URLs
 * - r2Url: Current R2 signed URL (refreshed as needed)
 * - contentType: MIME type for proper content-type headers
 * - createdAt: For purging old entries (90+ days)
 * - lastAccessed: For tracking when the file was last accessed
 */
router.get('/api/media/proxy/:mediaId', async (req: Request, res: Response) => {
  try {
    const { mediaId } = req.params;
    console.log(`Media proxy request received for ID: ${mediaId}`);
    
    // Get the media file from database storage
    // This automatically refreshes the URL if it's old
    const mediaProxy = await mediaProxyStorage.getMediaProxy(mediaId);
    
    if (!mediaProxy) {
      console.error(`Media file not found with ID: ${mediaId}`);
      return res.status(404).json({ error: 'Media file not found' });
    }
    
    console.log(`Found media proxy record, R2 key: ${mediaProxy.r2Key}`);
    
    // Set appropriate content type based on the stored media information
    res.setHeader('Content-Type', mediaProxy.contentType);
    
    // Redirect to the R2 URL
    console.log(`Redirecting to R2 URL`);
    return res.redirect(mediaProxy.r2Url);
  } catch (error) {
    console.error('Failed to proxy media request:', error);
    return res.status(500).json({ 
      error: 'Error accessing media file',
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