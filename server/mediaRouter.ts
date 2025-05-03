import { Router, Request, Response } from "express";
import { getSignedR2Url } from "./lib/r2Storage";
import { storage } from "./storage";

const router = Router();

/**
 * Media proxy endpoint - with enhanced privacy
 * 
 * This route gets a voice message file from R2 storage and redirects to a fresh
 * presigned URL. This approach solves several problems:
 * 
 * 1. It ensures links remain valid beyond the 7-day AWS SDK limit for presigned URLs
 * 2. It allows us to implement a privacy policy that automatically removes old voice messages
 * 3. It ensures no personally identifying information is stored in our system
 * 4. It provides a consistent API for accessing voice messages across PDFs
 */
router.get('/api/media/proxy/:mediaId', async (req: Request, res: Response) => {
  try {
    const { mediaId } = req.params;
    console.log(`Voice message proxy request received for ID: ${mediaId}`);
    
    // Get the voice message file from storage
    const mediaFile = await storage.getMediaFile(mediaId);
    
    if (!mediaFile) {
      console.error(`Voice message not found with ID: ${mediaId}`);
      return res.status(404).json({ 
        error: 'Voice message not found',
        message: 'This voice message may have expired or been deleted according to our privacy policy.'
      });
    }
    
    // Check if the media file has a key (it should, but might not due to privacy changes)
    if (!mediaFile.key) {
      console.error(`Voice message found but has no key: ${mediaId}`);
      return res.status(404).json({ 
        error: 'Voice message data not available',
        message: 'This voice message reference exists but the actual file data is no longer available.'
      });
    }
    
    console.log(`Found voice message: ${mediaFile.id}, created: ${mediaFile.createdAt}`);
    
    // Generate a fresh signed URL (short expiration for security)
    const signedUrl = await getSignedR2Url(mediaFile.key, 60 * 15); // 15 minutes
    
    // Log with a truncated URL to avoid exposing full details in logs
    const truncatedUrl = signedUrl.substring(0, 75) + '...';
    console.log(`Generated signed URL: ${truncatedUrl}`);
    
    // Redirect to the actual R2 URL
    console.log(`Redirecting to R2 URL for voice message ${mediaId}`);
    return res.redirect(signedUrl);
  } catch (error) {
    console.error('Failed to proxy voice message request:', error);
    return res.status(500).json({ 
      error: 'Error accessing voice message',
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