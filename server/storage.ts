import { v4 as uuidv4 } from "uuid";
import { ChatExport, Message, InsertChatExport, InsertMessage } from "@shared/schema";
import { ProcessingOptions } from "@shared/types";
import path from "path";
import os from "os";
import fs from "fs";

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
}

// In-memory storage implementation
export class MemStorage implements IStorage {
  private chatExports: Map<number, ChatExport>;
  private messages: Map<number, Message>;
  private processingProgress: Map<string, { progress: number, step?: number }>;
  private currentChatExportId: number;
  private currentMessageId: number;

  constructor() {
    this.chatExports = new Map();
    this.messages = new Map();
    this.processingProgress = new Map();
    this.currentChatExportId = 1;
    this.currentMessageId = 1;
  }

  async saveChatExport(data: InsertChatExport): Promise<ChatExport> {
    const id = this.currentChatExportId++;
    const chatExport: ChatExport = {
      ...data,
      id,
      generatedAt: new Date().toISOString(),
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
}

export const storage = new MemStorage();
