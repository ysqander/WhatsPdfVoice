import { v4 as uuidv4 } from "uuid";
import { ChatExport, Message, InsertChatExport, InsertMessage } from "@shared/schema";
import { ProcessingOptions } from "@shared/types";
import path from "path";
import os from "os";
import fs from "fs";
import { 
  uploadFileToR2, 
  getSignedR2Url, 
  deleteFileFromR2, 
  R2StorageObjectMetadata 
} from "./lib/r2Storage";

// Create directories for storing files
const baseDir = path.join(os.tmpdir(), 'whatspdf');
const pdfDir = path.join(baseDir, 'pdfs');
const mediaDir = path.join(baseDir, 'media');

// Ensure directories exist
[baseDir, pdfDir, mediaDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Define media file metadata structure
export interface MediaFile {
  id: string;
  key: string;
  chatExportId: number;
  messageId?: number;
  originalName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  url?: string;
  type: 'voice' | 'image' | 'attachment' | 'pdf';
}

// Storage interface
export interface IStorage {
  saveChatExport(data: InsertChatExport): Promise<ChatExport>;
  getChatExport(id: number): Promise<ChatExport | undefined>;
  saveMessage(message: InsertMessage): Promise<Message>;
  getMessagesByChatExportId(chatExportId: number): Promise<Message[]>;
  getLatestChatExport(): Promise<ChatExport | undefined>;
  saveProcessingProgress(clientId: string, progress: number, step?: number): void;
  getProcessingProgress(clientId: string): { progress: number, step?: number };
  savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void>;
  
  // Media file management with R2
  uploadMediaToR2(
    filePath: string, 
    contentType: string, 
    chatExportId: number, 
    messageId?: number, 
    type?: 'voice' | 'image' | 'attachment' | 'pdf'
  ): Promise<MediaFile>;
  getMediaUrl(mediaId: string): Promise<string>;
  deleteMedia(mediaId: string): Promise<boolean>;
  getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]>;
  getMediaFile(mediaId: string): Promise<MediaFile | undefined>;
  updateMessageMediaUrl(messageId: number, r2Key: string, r2Url: string): Promise<void>;
}

// In-memory storage implementation
export class MemStorage implements IStorage {
  private chatExports: Map<number, ChatExport>;
  private messages: Map<number, Message>;
  private processingProgress: Map<string, { progress: number, step?: number }>;
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
      type: message.type || 'text', // Ensure type is always set
      mediaUrl: message.mediaUrl || null,
      duration: message.duration || null,
      isDeleted: message.isDeleted || null
    };
    this.messages.set(id, savedMessage);
    return savedMessage;
  }

  async getMessagesByChatExportId(chatExportId: number): Promise<Message[]> {
    return Array.from(this.messages.values()).filter(
      (message) => message.chatExportId === chatExportId
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

  saveProcessingProgress(clientId: string, progress: number, step?: number): void {
    this.processingProgress.set(clientId, { progress, step });
  }

  getProcessingProgress(clientId: string): { progress: number, step?: number } {
    return this.processingProgress.get(clientId) || { progress: 0 };
  }

  async savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void> {
    const chatExport = await this.getChatExport(chatExportId);
    if (chatExport) {
      chatExport.pdfUrl = pdfUrl;
      this.chatExports.set(chatExportId, chatExport);
    }
  }

  // R2 Media Management Methods

  /**
   * Upload a media file to R2 storage
   */
  async uploadMediaToR2(
    filePath: string, 
    contentType: string, 
    chatExportId: number, 
    messageId?: number, 
    type: 'voice' | 'image' | 'attachment' | 'pdf' = 'attachment'
  ): Promise<MediaFile> {
    try {
      // Get file stats
      const stats = fs.statSync(filePath);
      const originalName = path.basename(filePath);

      // Upload to R2
      const directory = `chats/${chatExportId}/${type}`;
      const key = await uploadFileToR2(filePath, contentType, directory);
      
      // Get signed URL
      const url = await getSignedR2Url(key);
      
      // Create media file record
      const mediaFile: MediaFile = {
        id: uuidv4(),
        key,
        chatExportId,
        messageId,
        originalName,
        contentType,
        size: stats.size,
        uploadedAt: new Date().toISOString(),
        url,
        type
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
    // Filter media files by chat export ID
    const mediaFiles = Array.from(this.mediaFiles.values())
      .filter(media => media.chatExportId === chatExportId);
    
    // Create an array of promises to refresh URLs
    const refreshPromises = mediaFiles.map(async (media) => {
      // Refresh URL if it's expired or missing
      if (!media.url) {
        media.url = await getSignedR2Url(media.key);
        this.mediaFiles.set(media.id, media);
      }
      return media;
    });
    
    // Wait for all refreshes to complete
    return Promise.all(refreshPromises);
  }

  /**
   * Get a specific media file by ID
   */
  async getMediaFile(mediaId: string): Promise<MediaFile | undefined> {
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
  async updateMessageMediaUrl(messageId: number, r2Key: string, r2Url: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (message) {
      message.mediaUrl = r2Url;
      this.messages.set(messageId, message);
      
      // Also add to media files if not already there
      const existingMedia = Array.from(this.mediaFiles.values())
        .find(m => m.messageId === messageId);
      
      if (!existingMedia) {
        const mediaId = uuidv4();
        let contentType = "application/octet-stream";
        let type: 'voice' | 'image' | 'attachment' | 'pdf' = 'attachment';
        
        // Determine content type and type from message
        if (message.type === 'voice') {
          contentType = "audio/ogg";
          type = 'voice';
        } else if (message.type === 'image') {
          contentType = "image/jpeg";
          type = 'image';
        }
        
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
          type
        };
        
        this.mediaFiles.set(mediaId, mediaFile);
      }
    }
  }
}

export const storage = new MemStorage();
