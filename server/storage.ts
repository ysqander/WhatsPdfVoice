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
  id: string;          // Unique identifier for the media file (used for proxy URLs)
  key: string;         // R2 storage key
  url?: string;        // Direct R2 URL (for internal use only)
  type: 'voice';       // Only storing voice messages
  createdAt: string;   // Timestamp for deletion policy
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
   * Only voice files will be stored in R2 for privacy reasons.
   * PDFs are generated on-demand and not stored.
   */
  async uploadMediaToR2(
    filePath: string, 
    contentType: string, 
    chatExportId: number, 
    messageId?: number, 
    type: 'voice' | 'image' | 'attachment' | 'pdf' = 'attachment'
  ): Promise<MediaFile> {
    try {
      // Only store voice files in R2
      if (type !== 'voice') {
        console.log(`Skipping upload of non-voice file: ${filePath} (type: ${type})`);
        
        // For PDFs, we still need to return a MediaFile object with an ID
        // but we don't actually store anything in R2
        if (type === 'pdf') {
          const mediaFile: MediaFile = {
            id: uuidv4(),
            key: '',  // Empty key since we're not storing
            type: 'voice', // Dummy value since we only store voice
            createdAt: new Date().toISOString(),
          };
          return mediaFile;
        }
        
        throw new Error(`Only voice files are stored in R2. Type provided: ${type}`);
      }
      
      // For voice files, proceed with upload
      const stats = fs.statSync(filePath);
      
      // Use a simpler, privacy-focused directory structure with just UUIDs
      // This helps ensure no identifiable information in the paths
      const mediaId = uuidv4();
      const directory = `voice-messages`;
      const key = await uploadFileToR2(filePath, contentType, directory, mediaId);
      
      // Get signed URL
      const url = await getSignedR2Url(key);
      
      // Create minimal media file record
      const mediaFile: MediaFile = {
        id: mediaId,
        key,
        url,
        type: 'voice',
        createdAt: new Date().toISOString()
      };
      
      // Store in memory
      this.mediaFiles.set(mediaFile.id, mediaFile);
      
      console.log(`Uploaded voice file to R2: ${key}`);
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
    if (!mediaFile || !mediaFile.key) {
      throw new Error(`Media file not found or has no key: ${mediaId}`);
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
   * Also implements auto-cleanup for files older than X months
   */
  async deleteMedia(mediaId: string): Promise<boolean> {
    const mediaFile = this.mediaFiles.get(mediaId);
    if (!mediaFile || !mediaFile.key) {
      throw new Error(`Media file not found or has no key: ${mediaId}`);
    }
    
    console.log(`Deleting media file from R2: ${mediaFile.key}`);
    
    // Delete from R2
    await deleteFileFromR2(mediaFile.key);
    
    // Remove from our records
    this.mediaFiles.delete(mediaId);
    
    return true;
  }

  /**
   * Get all media files (no longer filtered by chat export ID since we don't store that)
   * This is mostly for administrative purposes
   */
  async getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]> {
    console.log("Note: getMediaFilesByChat is deprecated as we no longer store chat associations");
    
    // Return all media files since we don't track chat ID anymore
    const mediaFiles = Array.from(this.mediaFiles.values());
    
    // Create an array of promises to refresh URLs
    const refreshPromises = mediaFiles.map(async (media) => {
      // Refresh URL if it's expired or missing
      if (media.key && !media.url) {
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
    if (mediaFile && mediaFile.key && !mediaFile.url) {
      mediaFile.url = await getSignedR2Url(mediaFile.key);
      this.mediaFiles.set(mediaId, mediaFile);
    }
    return mediaFile;
  }
  
  /**
   * Clean up old voice messages
   * This would typically be called by a scheduled job
   * For this implementation, we'll just log what would be cleaned up
   * @param ageInMonths How many months old files should be deleted
   */
  async cleanupOldVoiceMessages(ageInMonths: number = 3): Promise<number> {
    const now = new Date();
    let cleanupCount = 0;
    
    for (const [mediaId, mediaFile] of this.mediaFiles.entries()) {
      // Skip files with no created date or key
      if (!mediaFile.createdAt || !mediaFile.key) continue;
      
      const createdDate = new Date(mediaFile.createdAt);
      const ageInMs = now.getTime() - createdDate.getTime();
      const ageInDays = ageInMs / (1000 * 60 * 60 * 24);
      
      // If older than X months (approximately)
      if (ageInDays > ageInMonths * 30) {
        console.log(`Would delete old voice message: ${mediaFile.key} (created: ${mediaFile.createdAt})`);
        
        // In a real implementation, we would delete the file from R2
        // await deleteFileFromR2(mediaFile.key);
        // this.mediaFiles.delete(mediaId);
        
        cleanupCount++;
      }
    }
    
    console.log(`Found ${cleanupCount} voice messages older than ${ageInMonths} months that would be deleted`);
    return cleanupCount;
  }

  /**
   * Update a message with R2 media URL
   * This is simplified to only handle voice messages with our privacy-focused approach
   */
  async updateMessageMediaUrl(messageId: number, r2Key: string, r2Url: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (message) {
      // Determine the base URL of our application for absolute URLs
      // In Replit, we can use REPLIT_DOMAINS or fallback to localhost
      const appBaseUrl = process.env.REPLIT_DOMAINS 
        ? `https://${process.env.REPLIT_DOMAINS}`
        : 'http://localhost:5000'; // Fallback for local development
      
      // Only handle voice messages
      if (message.type !== 'voice') {
        console.log(`Skipping non-voice message: ${messageId}`);
        return;
      }
      
      // Create a new media file entry with minimal data
      const mediaId = uuidv4();
      
      // Create a minimal record for the media file
      const mediaFile: MediaFile = {
        id: mediaId,
        key: r2Key,
        url: r2Url,  // Store original R2 URL for internal use
        type: 'voice',
        createdAt: new Date().toISOString()
      };
      
      // Store the media file record
      this.mediaFiles.set(mediaId, mediaFile);
      
      // Set the message's mediaUrl to our proxy endpoint
      message.mediaUrl = `${appBaseUrl}/api/media/proxy/${mediaId}`;
      console.log(`Setting message ${messageId} media URL to proxy: ${message.mediaUrl}`);
      this.messages.set(messageId, message);
    }
  }
}

export const storage = new MemStorage();
