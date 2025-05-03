import { type MediaFile as SchemaMediaFile } from "@shared/schema";
import { DatabaseStorage } from "./databaseStorage";

// For backward compatibility and proper typing
export type MediaFile = SchemaMediaFile;

// Simplified storage interface that focuses only on media storage
// for privacy (not storing any private chat/message data)
export interface IStorage {
  // Processing progress (temporary, cleared after processing)
  saveProcessingProgress(clientId: string, progress: number, step?: number): Promise<void>;
  getProcessingProgress(clientId: string): Promise<{ progress: number, step?: number }>;
  
  // Media file management with R2
  uploadMediaToR2(
    filePath: string, 
    contentType: string, 
    sessionId: number, // Just a reference ID, doesn't store actual chat data
    messageRef?: number, // Optional reference ID
    type?: 'voice' | 'image' | 'attachment' | 'pdf',
    expiresIn?: number,
    retentionMonths?: number // How long to keep media files
  ): Promise<MediaFile>;
  getMediaUrl(mediaId: string): Promise<string>;
  deleteMedia(mediaId: string): Promise<boolean>;
  getMediaFile(mediaId: string): Promise<MediaFile | undefined>;
  cleanupExpiredMedia(): Promise<number>;
  
  // Legacy methods - now disabled for privacy
  saveChatExport(data: any): Promise<any>;
  getChatExport(id: number): Promise<any>;
  saveMessage(message: any): Promise<any>;
  getMessagesByChatExportId(chatExportId: number): Promise<any[]>;
  getLatestChatExport(): Promise<any>;
  savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void>;
  getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]>;
  updateMessageMediaUrl(messageId: number, r2Key: string, r2Url: string): Promise<void>;
}

// Create and export our database storage implementation
export const storage = new DatabaseStorage();