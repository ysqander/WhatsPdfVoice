import { db } from "./db";
import {
  mediaFiles,
  processingProgress,
  MediaFile,
  InsertMediaFile
} from "@shared/schema";
import { IStorage } from "./storage";
import { eq, desc, sql } from "drizzle-orm";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import { getSignedR2Url, uploadFileToR2, deleteFileFromR2 } from "./lib/r2Storage";

// Helper function to calculate expiration date
const calculateExpirationDate = (months = 3) => {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  return date;
};

export class DatabaseStorage implements IStorage {
  /**
   * Save processing progress
   */
  async saveProcessingProgress(clientId: string, progress: number, step?: number): Promise<void> {
    await db
      .insert(processingProgress)
      .values({
        clientId,
        progress,
        step
      })
      .onConflictDoUpdate({
        target: processingProgress.clientId,
        set: {
          progress,
          step,
          updatedAt: new Date()
        }
      });
  }

  /**
   * Get processing progress
   */
  async getProcessingProgress(clientId: string): Promise<{ progress: number, step?: number }> {
    const [progress] = await db
      .select()
      .from(processingProgress)
      .where(eq(processingProgress.clientId, clientId));
    
    if (!progress) {
      return { progress: 0 };
    }
    
    return {
      progress: progress.progress,
      step: progress.step ?? undefined
    };
  }

  /**
   * Upload media to R2 and save to database
   * This method will store media files needed for the PDF but not save any private chat data
   */
  async uploadMediaToR2(
    filePath: string, 
    contentType: string, 
    sessionId: number, // We use this as a grouping ID but don't store chat contents
    messageRef?: number, // Optional reference for organization/grouping
    type: 'voice' | 'image' | 'attachment' | 'pdf' = 'attachment',
    expiresIn?: number,
    retentionMonths: number = 6 // Default retention period
  ): Promise<MediaFile> {
    try {
      // Get file stats for size
      const stats = fs.statSync(filePath);
      const originalName = path.basename(filePath);
      
      // Generate R2 key using directory structure for organization
      const typeFolder = type === 'voice' ? 'voice' : 
                         type === 'image' ? 'images' : 
                         type === 'pdf' ? 'pdf' : 'attachments';
      
      const fileName = originalName.replace(/[^a-zA-Z0-9_\-\.]/g, '_');
      const uniqueSuffix = uuidv4();
      const key = `media/${sessionId}/${typeFolder}/${fileName.replace(/\s+/g, '_')}_${uniqueSuffix}.${path.extname(filePath).slice(1)}`;
      
      // Upload file to R2
      await uploadFileToR2(filePath, contentType, key);
      console.log(`Uploaded file to R2: ${key}`);
      
      // Get signed URL (this will expire, but our proxy system will handle that)
      const url = await getSignedR2Url(key, expiresIn);
      
      // Set expiration date for automatic cleanup
      const expiresAt = calculateExpirationDate(retentionMonths);
      
      // Create media file record in database
      const [mediaFile] = await db
        .insert(mediaFiles)
        .values({
          key,
          originalName,
          contentType,
          size: stats.size,
          url,
          type,
          expiresAt
        })
        .returning();
      
      console.log(`Uploaded media file to R2: ${key} (expires: ${expiresAt.toISOString()})`);
      return mediaFile;
    } catch (error) {
      console.error("Error uploading media to R2:", error);
      throw error;
    }
  }

  /**
   * Get a fresh signed URL for a media file using our proxy system
   */
  async getMediaUrl(mediaId: string): Promise<string> {
    // First, check if the media file exists
    const [mediaFile] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaId));
      
    if (!mediaFile) {
      throw new Error(`Media file with ID ${mediaId} not found`);
    }
    
    // Check if the media has expired
    if (mediaFile.expiresAt && new Date() > mediaFile.expiresAt) {
      throw new Error(`Media file with ID ${mediaId} has expired`);
    }
    
    // Generate a fresh signed URL with a new expiration
    const freshUrl = await getSignedR2Url(mediaFile.key);
    
    // Update the URL in the database
    await db
      .update(mediaFiles)
      .set({ url: freshUrl })
      .where(eq(mediaFiles.id, mediaId));
    
    return freshUrl;
  }

  /**
   * Delete a media file from R2 and from the database
   */
  async deleteMedia(mediaId: string): Promise<boolean> {
    // Get the media file to get the R2 key
    const [mediaFile] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaId));
      
    if (!mediaFile) {
      return false;
    }
    
    try {
      // Delete from R2
      await deleteFileFromR2(mediaFile.key);
      
      // Delete from database
      await db
        .delete(mediaFiles)
        .where(eq(mediaFiles.id, mediaId));
      
      return true;
    } catch (error) {
      console.error(`Error deleting media file ${mediaId}:`, error);
      return false;
    }
  }

  /**
   * Get a specific media file by ID
   */
  async getMediaFile(mediaId: string): Promise<MediaFile | undefined> {
    const [mediaFile] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaId));
    
    return mediaFile;
  }
  
  /**
   * Clean up expired media files
   * This should be called periodically via a cron job
   */
  async cleanupExpiredMedia(): Promise<number> {
    // Find all expired media files
    const expiredFiles = await db
      .select()
      .from(mediaFiles)
      .where(sql`${mediaFiles.expiresAt} IS NOT NULL AND ${mediaFiles.expiresAt} < NOW()`);
    
    let deletedCount = 0;
    
    // Delete each expired file
    for (const file of expiredFiles) {
      try {
        await deleteFileFromR2(file.key);
        
        await db
          .delete(mediaFiles)
          .where(eq(mediaFiles.id, file.id));
        
        deletedCount++;
        console.log(`Cleaned up expired media file: ${file.id} (${file.key})`);
      } catch (error) {
        console.error(`Error cleaning up expired media file ${file.id}:`, error);
      }
    }
    
    return deletedCount;
  }
  
  // Provide stubs for the IStorage interface methods that we're not using anymore
  async saveChatExport() {
    throw new Error("Method not supported: saveChatExport - We no longer store chat data for privacy reasons");
  }
  
  async getChatExport() {
    throw new Error("Method not supported: getChatExport - We no longer store chat data for privacy reasons");
  }
  
  async saveMessage() {
    throw new Error("Method not supported: saveMessage - We no longer store message data for privacy reasons");
  }
  
  async getMessagesByChatExportId() {
    throw new Error("Method not supported: getMessagesByChatExportId - We no longer store message data for privacy reasons");
  }
  
  async getLatestChatExport() {
    throw new Error("Method not supported: getLatestChatExport - We no longer store chat data for privacy reasons");
  }
  
  async savePdfUrl() {
    throw new Error("Method not supported: savePdfUrl - We no longer store PDF data for privacy reasons");
  }
  
  async getMediaFilesByChat() {
    throw new Error("Method not supported: getMediaFilesByChat - We no longer store chat data for privacy reasons");
  }
  
  async updateMessageMediaUrl() {
    throw new Error("Method not supported: updateMessageMediaUrl - We no longer store message data for privacy reasons");
  }
}