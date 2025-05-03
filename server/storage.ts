import { 
  type ChatExport, 
  type Message, 
  type InsertChatExport, 
  type InsertMessage,
  type MediaFile as SchemaMediaFile
} from "@shared/schema";
import { ProcessingOptions } from "@shared/types";
import { DatabaseStorage } from "./databaseStorage";

// For backward compatibility and proper typing
export type MediaFile = SchemaMediaFile;

// Storage interface
export interface IStorage {
  saveChatExport(data: InsertChatExport): Promise<ChatExport>;
  getChatExport(id: number): Promise<ChatExport | undefined>;
  saveMessage(message: InsertMessage): Promise<Message>;
  getMessagesByChatExportId(chatExportId: number): Promise<Message[]>;
  getLatestChatExport(): Promise<ChatExport | undefined>;
  saveProcessingProgress(clientId: string, progress: number, step?: number): Promise<void>;
  getProcessingProgress(clientId: string): Promise<{ progress: number, step?: number }>;
  savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void>;
  
  // Media file management with R2
  uploadMediaToR2(
    filePath: string, 
    contentType: string, 
    chatExportId: number, 
    messageId?: number, 
    type?: 'voice' | 'image' | 'attachment' | 'pdf',
    expiresIn?: number
  ): Promise<MediaFile>;
  getMediaUrl(mediaId: string): Promise<string>;
  deleteMedia(mediaId: string): Promise<boolean>;
  getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]>;
  getMediaFile(mediaId: string): Promise<MediaFile | undefined>;
  updateMessageMediaUrl(messageId: number, r2Key: string, r2Url: string): Promise<void>;
}

// Create and export our database storage implementation
export const storage = new DatabaseStorage();