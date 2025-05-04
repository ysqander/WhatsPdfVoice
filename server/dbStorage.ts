import { db } from "./db";
import { mediaFiles, type MediaFile, type InsertMediaFile } from "@shared/schema";
import { eq } from "drizzle-orm";
import { getSignedR2Url, deleteFileFromR2 } from "./lib/r2Storage";

// Storage interface for media files (voice messages only)
export interface IMediaStorage {
  // Save a media file record
  saveMediaFile(data: InsertMediaFile): Promise<MediaFile>;
  
  // Get a media file by its external ID (UUID)
  getMediaFileByMediaId(mediaId: string): Promise<MediaFile | undefined>;
  
  // Get a signed URL for a media file
  getSignedUrl(mediaId: string): Promise<string>;
  
  // Delete a media file
  deleteMediaFile(mediaId: string): Promise<boolean>;
  
  // Clean up expired media files
  cleanupExpiredMedia(): Promise<number>;
}

// Database implementation of the media storage
export class DatabaseMediaStorage implements IMediaStorage {
  async saveMediaFile(data: InsertMediaFile): Promise<MediaFile> {
    const [mediaFile] = await db
      .insert(mediaFiles)
      .values(data)
      .returning();
    
    return mediaFile;
  }
  
  async getMediaFileByMediaId(mediaId: string): Promise<MediaFile | undefined> {
    const results = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.mediaId, mediaId));
    
    return results[0];
  }
  
  async getSignedUrl(mediaId: string): Promise<string> {
    const mediaFile = await this.getMediaFileByMediaId(mediaId);
    
    if (!mediaFile) {
      throw new Error(`Media file not found with ID: ${mediaId}`);
    }
    
    if (!mediaFile.r2Key) {
      throw new Error(`Media file has no R2 key: ${mediaId}`);
    }
    
    // Generate a fresh signed URL (15 minutes expiration)
    return getSignedR2Url(mediaFile.r2Key, 60 * 15);
  }
  
  async deleteMediaFile(mediaId: string): Promise<boolean> {
    const mediaFile = await this.getMediaFileByMediaId(mediaId);
    
    if (!mediaFile) {
      throw new Error(`Media file not found with ID: ${mediaId}`);
    }
    
    if (mediaFile.r2Key) {
      // Delete from R2 storage
      await deleteFileFromR2(mediaFile.r2Key);
    }
    
    // Delete database record
    await db
      .delete(mediaFiles)
      .where(eq(mediaFiles.mediaId, mediaId));
    
    return true;
  }
  
  async cleanupExpiredMedia(): Promise<number> {
    // Find expired media files
    const expiredMedia = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.expiresAt, new Date()));
    
    let deletedCount = 0;
    
    // Delete each file from R2 and the database
    for (const media of expiredMedia) {
      try {
        if (media.r2Key) {
          await deleteFileFromR2(media.r2Key);
        }
        
        await db
          .delete(mediaFiles)
          .where(eq(mediaFiles.id, media.id));
        
        deletedCount++;
      } catch (error) {
        console.error(`Failed to delete expired media ${media.mediaId}:`, error);
      }
    }
    
    return deletedCount;
  }
}

// Create a singleton instance
export const mediaStorage = new DatabaseMediaStorage();