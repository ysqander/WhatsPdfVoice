import { v4 as uuidv4 } from "uuid";
import { ProcessingOptions } from "@shared/types";
import path from "path";
import os from "os";
import fs from "fs";
import {
  uploadFileToR2,
  getSignedR2Url,
  deleteFileFromR2,
} from "./lib/r2Storage";
import { mediaProxyStorage } from "./mediaProxyStorage";
import { eq } from "drizzle-orm";
import { mediaProxyFiles } from "@shared/schema";
import { db } from "./db";
import {
  type MediaFile,
  type ChatExport,
  type Message,
  type InsertChatExport,
  type InsertMessage,
} from "@shared/schema";
import { DatabaseStorage } from "./databaseStorage";

// Create directories for storing files
const baseDir = path.join(os.tmpdir(), "whatspdf");
const pdfDir = path.join(baseDir, "pdfs");
const mediaDir = path.join(baseDir, "media");

// Ensure directories exist
[baseDir, pdfDir, mediaDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Storage interface
export interface IStorage {
  saveChatExport(data: InsertChatExport): Promise<ChatExport>;
  getChatExport(id: number): Promise<ChatExport | undefined>;
  saveMessage(message: InsertMessage): Promise<Message>;
  getMessagesByChatExportId(chatExportId: number): Promise<Message[]>;
  getLatestChatExport(): Promise<ChatExport | undefined>;
  saveProcessingProgress(
    clientId: string,
    progress: number,
    step?: number,
  ): void;
  getProcessingProgress(clientId: string): { progress: number; step?: number };
  savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void>;

  // Media file management with R2
  uploadMediaToR2(
    filePath: string,
    contentType: string,
    chatExportId: number,
    messageId?: number,
    type?: "voice" | "image" | "attachment" | "pdf",
    originalName?: string,
    fileHash?: string,
  ): Promise<MediaFile>;
  getMediaUrl(mediaId: string): Promise<string>;
  deleteMedia(mediaId: string): Promise<boolean>;
  getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]>;
  getMediaFile(mediaId: string): Promise<MediaFile | undefined>;
  updateMessageMediaUrl(
    messageId: number,
    r2Key: string,
    r2Url: string,
  ): Promise<void>;
  updateMessageProxyUrl(messageId: number, proxyUrl: string): Promise<void>;
}

// In-memory storage implementation
export class MemStorage implements IStorage {
  private chatExports: Map<number, ChatExport>;
  private messages: Map<number, Message>;
  private processingProgress: Map<string, { progress: number; step?: number }>;
  private mediaFiles: Map<string, MediaFile>;
  private currentChatExportId: number;
  private currentMessageId: number;

  constructor() {
    this.chatExports = new Map();
    this.messages = new Map();
    this.processingProgress = new Map();
    this.mediaFiles = new Map();
    this.currentChatExportId = 1;
    this.currentMessageId = 1;
  }

  async saveChatExport(data: InsertChatExport): Promise<ChatExport> {
    const id = this.currentChatExportId++;
    const chatExport: ChatExport = {
      ...data,
      id,
      generatedAt: new Date(),
      participants: data.participants || null,
      pdfUrl: data.pdfUrl || null,
    };
    this.chatExports.set(id, chatExport);
    return chatExport;
  }

  async getChatExport(id: number): Promise<ChatExport | undefined> {
    return this.chatExports.get(id);
  }

  async saveMessage(message: InsertMessage): Promise<Message> {
    const id = this.currentMessageId++;
    const savedMessage: Message = {
      ...message,
      id,
      type: message.type || "text", // Ensure type is always set
      mediaUrl: message.mediaUrl || null,
      duration: message.duration || null,
      isDeleted: message.isDeleted || null,
    };
    this.messages.set(id, savedMessage);
    return savedMessage;
  }

  async getMessagesByChatExportId(chatExportId: number): Promise<Message[]> {
    return Array.from(this.messages.values()).filter(
      (message) => message.chatExportId === chatExportId,
    );
  }

  async getLatestChatExport(): Promise<ChatExport | undefined> {
    if (this.chatExports.size === 0) {
      return undefined;
    }

    const entries = Array.from(this.chatExports.entries());
    const [_, latestChatExport] = entries.reduce((latest, current) => {
      return latest[0] > current[0] ? latest : current;
    });

    return latestChatExport;
  }

  saveProcessingProgress(
    clientId: string,
    progress: number,
    step?: number,
  ): void {
    this.processingProgress.set(clientId, { progress, step });
  }

  getProcessingProgress(clientId: string): { progress: number; step?: number } {
    return this.processingProgress.get(clientId) || { progress: 0 };
  }

  async savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void> {
    const chatExport = await this.getChatExport(chatExportId);
    if (chatExport) {
      chatExport.pdfUrl = pdfUrl;
      this.chatExports.set(chatExportId, chatExport);
    }
  }

  // R2 Media Management Methods - these now use our MediaProxyStorage for persistence

  /**
   * Upload a media file to R2 storage
   */
  async uploadMediaToR2(
    filePath: string,
    contentType: string,
    chatExportId: number,
    messageId?: number,
    type: "voice" | "image" | "attachment" | "pdf" = "attachment",
    customOriginalName?: string,
    customFileHash?: string,
  ): Promise<MediaFile> {
    try {
      // Get file stats
      const stats = fs.statSync(filePath);
      const originalName = customOriginalName || path.basename(filePath);

      // Upload to R2
      const directory = `chats/${chatExportId}/${type}`;
      const key = await uploadFileToR2(filePath, contentType, directory);

      // Get signed URL
      const url = await getSignedR2Url(key);

      // Create media proxy in database (this is the key change)
      const mediaProxy = await mediaProxyStorage.createMediaProxy(
        key, // R2 key
        url, // Initial R2 URL
        contentType,
        undefined, // No explicit expiry
      );

      // Create in-memory media file record
      const mediaFile: MediaFile = {
        id: mediaProxy.id, // Important: use the database-generated UUID
        key,
        chatExportId,
        messageId,
        originalName,
        contentType,
        size: stats.size,
        uploadedAt: new Date().toISOString(),
        url,
        type,
        fileHash: customFileHash,
      };

      // Store in memory
      this.mediaFiles.set(mediaFile.id, mediaFile);

      console.log(`Uploaded media file to R2: ${key}`);
      return mediaFile;
    } catch (error) {
      console.error("Error uploading media to R2:", error);
      throw error;
    }
  }

  /**
   * Get a fresh signed URL for a media file
   */
  async getMediaUrl(mediaId: string): Promise<string> {
    // Try to get from database first
    try {
      const mediaProxy = await mediaProxyStorage.getMediaProxy(mediaId);
      if (mediaProxy) {
        // Found in database, return the URL (it's refreshed automatically if needed)
        return mediaProxy.r2Url;
      }
    } catch (err) {
      console.log(
        "Media not found in database, falling back to memory storage",
      );
    }

    // Fallback to in-memory if not in database
    const mediaFile = this.mediaFiles.get(mediaId);
    if (!mediaFile) {
      throw new Error(`Media file not found: ${mediaId}`);
    }

    // Generate a fresh signed URL
    const url = await getSignedR2Url(mediaFile.key);

    // Update the URL in our records
    mediaFile.url = url;
    this.mediaFiles.set(mediaId, mediaFile);

    return url;
  }

  /**
   * Delete a media file from R2
   */
  async deleteMedia(mediaId: string): Promise<boolean> {
    // Try to delete from database first
    try {
      const result = await mediaProxyStorage.deleteMediaProxy(mediaId);
      if (result) {
        // Also remove from memory if it exists there
        this.mediaFiles.delete(mediaId);
        return true;
      }
    } catch (err) {
      console.log(
        "Media not found in database, falling back to memory storage",
      );
    }

    // Fallback to in-memory if not in database
    const mediaFile = this.mediaFiles.get(mediaId);
    if (!mediaFile) {
      throw new Error(`Media file not found: ${mediaId}`);
    }

    // Delete from R2
    await deleteFileFromR2(mediaFile.key);

    // Remove from our records
    this.mediaFiles.delete(mediaId);

    // If this media is associated with a message, update the message
    if (mediaFile.messageId) {
      const message = this.messages.get(mediaFile.messageId);
      if (message) {
        message.mediaUrl = null; // Set to null, not undefined
        this.messages.set(mediaFile.messageId, message);
      }
    }

    return true;
  }

  /**
   * Get all media files for a chat export
   */
  async getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]> {
    // Currently, we only track this in memory, so filter memory records
    // In a full implementation, this would search the database too
    const mediaFiles = Array.from(this.mediaFiles.values()).filter(
      (media) => media.chatExportId === chatExportId,
    );

    // Create an array of promises to refresh URLs
    const refreshPromises = mediaFiles.map(async (media) => {
      try {
        // Try to get fresh URL from database
        const proxyFile = await mediaProxyStorage.getMediaProxy(media.id);
        if (proxyFile) {
          media.url = proxyFile.r2Url;
        } else if (!media.url) {
          // Fallback to direct refresh if not in database
          media.url = await getSignedR2Url(media.key);
        }
      } catch (err) {
        // If that fails, try direct refresh
        if (!media.url) {
          media.url = await getSignedR2Url(media.key);
        }
      }

      this.mediaFiles.set(media.id, media);
      return media;
    });

    // Wait for all refreshes to complete
    return Promise.all(refreshPromises);
  }

  /**
   * Get a specific media file by ID
   */
  async getMediaFile(mediaId: string): Promise<MediaFile | undefined> {
    // Try to get from database first
    try {
      const mediaProxy = await mediaProxyStorage.getMediaProxy(mediaId);
      if (mediaProxy) {
        // Convert to MediaFile format for compatibility
        const inMemoryFile = this.mediaFiles.get(mediaId);

        if (inMemoryFile) {
          // Update the URL in the in-memory record
          inMemoryFile.url = mediaProxy.r2Url;
          this.mediaFiles.set(mediaId, inMemoryFile);
          return inMemoryFile;
        } else {
          // Create a minimal MediaFile object with the database info
          return mediaProxyStorage.convertToMediaFile(mediaProxy);
        }
      }
    } catch (err) {
      console.log(
        "Media not found in database, falling back to memory storage",
      );
    }

    // Fallback to in-memory
    const mediaFile = this.mediaFiles.get(mediaId);
    if (mediaFile && !mediaFile.url) {
      mediaFile.url = await getSignedR2Url(mediaFile.key);
      this.mediaFiles.set(mediaId, mediaFile);
    }
    return mediaFile;
  }

  /**
   * Update a message with R2 media URL
   */
  async updateMessageMediaUrl(
    messageId: number,
    r2Key: string,
    r2Url: string,
  ): Promise<void> {
    const message = this.messages.get(messageId);
    if (message) {
      // Determine the base URL of our application for absolute URLs
      const appBaseUrl = process.env.REPLIT_DOMAINS
        ? `https://${process.env.REPLIT_DOMAINS}`
        : "http://localhost:5000";

      // First create or update the media proxy in the database
      let mediaProxy;
      let mediaId;

      // Check for existing media entry
      const existingMedia = Array.from(this.mediaFiles.values()).find(
        (m) => m.messageId === messageId,
      );

      if (existingMedia) {
        // Update existing proxy
        try {
          mediaProxy = await mediaProxyStorage.getMediaProxy(existingMedia.id);
          if (mediaProxy) {
            // Update it with the new R2 key and URL if different
            if (mediaProxy.r2Key !== r2Key) {
              await db
                .update(mediaProxyFiles)
                .set({
                  r2Key,
                  r2Url,
                  lastAccessed: new Date(),
                })
                .where(eq(mediaProxyFiles.id, existingMedia.id));
            }
            mediaId = existingMedia.id;
          } else {
            // Not found in database, create it
            mediaProxy = await mediaProxyStorage.createMediaProxy(
              r2Key,
              r2Url,
              existingMedia.contentType,
            );
            mediaId = mediaProxy.id;
          }
        } catch (err) {
          console.log(
            "Failed to update existing media proxy, creating new one",
          );
          // Determine content type from message
          let contentType = "application/octet-stream";
          if (message.type === "voice") {
            contentType = "audio/ogg";
          } else if (message.type === "image") {
            contentType = "image/jpeg";
          }

          // Create new media proxy
          mediaProxy = await mediaProxyStorage.createMediaProxy(
            r2Key,
            r2Url,
            contentType,
          );
          mediaId = mediaProxy.id;
        }
      } else {
        // Create new media proxy
        let contentType = "application/octet-stream";
        let type: "voice" | "image" | "attachment" | "pdf" = "attachment";

        // Determine content type and type from message
        if (message.type === "voice") {
          contentType = "audio/ogg";
          type = "voice";
        } else if (message.type === "image") {
          contentType = "image/jpeg";
          type = "image";
        }

        // Create new media proxy
        mediaProxy = await mediaProxyStorage.createMediaProxy(
          r2Key,
          r2Url,
          contentType,
        );
        mediaId = mediaProxy.id;

        // Also create in-memory media file
        const mediaFile: MediaFile = {
          id: mediaId,
          key: r2Key,
          chatExportId: message.chatExportId,
          messageId,
          originalName: path.basename(r2Key),
          contentType,
          size: 0, // We don't know the size
          uploadedAt: new Date().toISOString(),
          url: r2Url,
          type,
        };

        this.mediaFiles.set(mediaId, mediaFile);
      }

      // Use a proxy URL that points to our server endpoint
      const proxyUrl = `${appBaseUrl}/api/media/proxy/${mediaId}`;
      console.log(
        `Setting message ${messageId} media URL to proxy: ${proxyUrl}`,
      );

      // Update the message with the proxy URL
      message.mediaUrl = proxyUrl;
      this.messages.set(messageId, message);
    }
  }

  async updateMessageProxyUrl(
    messageId: number,
    proxyUrl: string,
  ): Promise<void> {
    const message = this.messages.get(messageId);
    if (message) {
      message.mediaUrl = proxyUrl;
      this.messages.set(messageId, message);
      console.log(
        `[MemStorage] Updated message ${messageId} mediaUrl to ${proxyUrl}`,
      );
    } else {
      console.warn(
        `[MemStorage] Message ${messageId} not found for updating proxy URL.`,
      );
    }
  }
}

export const storage = new DatabaseStorage();
