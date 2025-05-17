import { db } from "./db";
import { eq, lt, and, sql } from "drizzle-orm";
import { 
  mediaProxyFiles,
  type MediaProxyFile,
  type MediaFile
} from "@shared/schema";
import { getSignedR2Url, deleteFileFromR2 } from "./lib/r2Storage";

// 90 days in milliseconds
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * MediaProxyStorage handles persistent storage of R2 media proxy information
 * It maintains just the minimal mapping between mediaIds and R2 object keys
 * without storing any private user data
 */
export class MediaProxyStorage {
  /**
   * Create a new media proxy entry
   * @param r2Key The R2 object key
   * @param r2Url The R2 signed URL
   * @param contentType MIME type of the file
   * @param expiryDate Optional explicit expiry date
   * @returns MediaProxyFile with generated ID
   */
  async createMediaProxy(
    r2Key: string,
    r2Url: string,
    contentType: string,
    expiryDate?: Date
  ): Promise<MediaProxyFile> {
    const [mediaProxy] = await db
      .insert(mediaProxyFiles)
      .values({
        r2Key,
        r2Url,
        contentType,
        expiryDate
      })
      .returning();

    return mediaProxy;
  }

  /**
   * Get a media proxy by ID and refresh the signed URL if needed
   * @param id Media proxy ID
   * @returns MediaProxyFile with fresh signed URL
   */
  async getMediaProxy(id: string): Promise<MediaProxyFile | undefined> {
    // Find the media proxy
    const [mediaProxy] = await db
      .select()
      .from(mediaProxyFiles)
      .where(eq(mediaProxyFiles.id, id));

    if (!mediaProxy) {
      console.error(`No media proxy found with ID: ${id}`);
      return undefined;
    }

    console.log(`Found media proxy record: ${JSON.stringify({
      id: mediaProxy.id,
      r2Key: mediaProxy.r2Key,
      contentType: mediaProxy.contentType,
      createdAt: mediaProxy.createdAt
    })}`);

    // Update last accessed time
    await db
      .update(mediaProxyFiles)
      .set({ lastAccessed: new Date() })
      .where(eq(mediaProxyFiles.id, id));

    // Always refresh the URL to ensure it's valid
    try {
      console.log(`Generating fresh signed URL for R2 key: ${mediaProxy.r2Key}`);
      const newSignedUrl = await getSignedR2Url(mediaProxy.r2Key);
      
      // Update in database
      await db
        .update(mediaProxyFiles)
        .set({ r2Url: newSignedUrl })
        .where(eq(mediaProxyFiles.id, id));
      
      // Return updated proxy
      mediaProxy.r2Url = newSignedUrl;
      console.log(`Successfully refreshed R2 URL for key: ${mediaProxy.r2Key}`);
      return mediaProxy;
    } catch (error) {
      console.error(`Error generating signed URL for R2 key ${mediaProxy.r2Key}:`, error);
      // Return the existing URL even if refresh failed
      return mediaProxy;
    }
  }

  /**
   * Delete media proxy by ID
   * @param id Media proxy ID
   * @returns true if deleted, false if not found
   */
  async deleteMediaProxy(id: string): Promise<boolean> {
    // Get the proxy first to get the R2 key
    const [mediaProxy] = await db
      .select()
      .from(mediaProxyFiles)
      .where(eq(mediaProxyFiles.id, id));

    if (!mediaProxy) {
      return false;
    }

    // Delete from R2
    try {
      await deleteFileFromR2(mediaProxy.r2Key);
    } catch (error) {
      console.error(`Error deleting R2 object ${mediaProxy.r2Key}:`, error);
      // Continue anyway to delete the database record
    }

    // Delete from database
    await db
      .delete(mediaProxyFiles)
      .where(eq(mediaProxyFiles.id, id));

    return true;
  }

  /**
   * Purge expired media proxies (older than 90 days)
   * @returns Number of purged entries
   */
  async purgeExpiredMedia(): Promise<number> {
    // Calculate cutoff date (90 days ago)
    const cutoffDate = new Date(Date.now() - NINETY_DAYS_MS);
    const now = new Date();
    
    // Find expired entries with expiry date in the past
    const expiredByExpiryDate = await db
      .select()
      .from(mediaProxyFiles)
      .where(
        sql`expiry_date IS NOT NULL AND expiry_date < ${now}`
      );
    
    // Find expired entries that haven't been accessed in 90 days
    const expiredByInactivity = await db
      .select()
      .from(mediaProxyFiles)
      .where(
        and(
          lt(mediaProxyFiles.createdAt, cutoffDate),
          lt(mediaProxyFiles.lastAccessed, cutoffDate)
        )
      );
    
    // Combine both lists and filter duplicates
    const allEntries = [...expiredByExpiryDate, ...expiredByInactivity];
    const uniqueEntriesMap = new Map();
    
    for (const entry of allEntries) {
      uniqueEntriesMap.set(entry.id, entry);
    }
    
    const expiredEntries = Array.from(uniqueEntriesMap.values());
    
    // Delete each one from R2 first
    for (const entry of expiredEntries) {
      try {
        await deleteFileFromR2(entry.r2Key);
      } catch (error) {
        console.error(`Error deleting expired R2 object ${entry.r2Key}:`, error);
        // Continue with other deletions
      }
    }
    
    // Delete expired entries from database
    if (expiredEntries.length > 0) {
      const expiredIds = expiredEntries.map(e => e.id);
      
      await db
        .delete(mediaProxyFiles)
        .where(
          sql`id IN (${expiredIds.join(',')})`
        );
    }
    
    // Return count of deleted entries
    return expiredEntries.length;
  }

  /**
   * Get media statistics
   * @returns Object with count and oldest creation date
   */
  async getMediaStats(): Promise<{ count: number, oldestCreatedAt: Date | undefined }> {
    // Get count
    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(mediaProxyFiles);
    
    // Get oldest
    const [oldest] = await db
      .select()
      .from(mediaProxyFiles)
      .orderBy(mediaProxyFiles.createdAt)
      .limit(1);
    
    return {
      count: countResult[0].count,
      oldestCreatedAt: oldest ? oldest.createdAt : undefined
    };
  }

  /**
   * Convert traditional MediaFile to MediaProxyFile
   * Helper method to maintain compatibility with existing code
   */
  async mediaFileToProxyFile(mediaFile: MediaFile): Promise<MediaProxyFile> {
    return this.createMediaProxy(
      mediaFile.key,
      mediaFile.url || '',
      mediaFile.contentType,
      undefined // No explicit expiry date
    );
  }

  /**
   * Convert MediaProxyFile to MediaFile format
   * Helper method to maintain compatibility with existing code
   */
  convertToMediaFile(proxyFile: MediaProxyFile): MediaFile {
    return {
      id: proxyFile.id,
      key: proxyFile.r2Key,
      contentType: proxyFile.contentType,
      url: proxyFile.r2Url
    };
  }
}

// Export singleton instance
export const mediaProxyStorage = new MediaProxyStorage();