// Types for the WhatsApp chat processing application

export interface ProcessingOptions {
  includeVoiceMessages: boolean;
  includeTimestamps: boolean;
  highlightSenders: boolean;
  includeImages: boolean;
  includeAttachments: boolean;
}

export interface Message {
  id?: number;
  timestamp: string;
  sender: string;
  content: string;
  type: 'text' | 'voice' | 'image' | 'attachment';
  mediaUrl?: string;
  duration?: number;
  chatExportId?: number;
}

export interface ChatExport {
  id?: number;
  originalFilename: string;
  fileHash: string;
  participants?: string[];
  messages: Message[];
  generatedAt?: string;
  pdfUrl?: string;
  processingOptions: ProcessingOptions;
}

export interface ProcessProgressEvent {
  progress: number;
  step?: number;
  done?: boolean;
  pdfUrl?: string;
  chatData?: ChatExport;
}

export enum ProcessingStep {
  EXTRACT_ZIP = 0,
  PARSE_MESSAGES = 1,
  CONVERT_VOICE = 2,
  GENERATE_PDF = 3,
  PAYMENT_REQUIRED = 4
}

// Constants for free tier limits
export const FREE_TIER_MESSAGE_LIMIT = 150;
export const FREE_TIER_MEDIA_SIZE_LIMIT = 20 * 1024 * 1024; // 20MB in bytes

// MediaFile interface (copy from schema.ts for direct import)
export interface MediaFile {
  id: string;
  key: string;
  chatExportId?: number;
  messageId?: number;
  originalName?: string;
  contentType: string;
  size?: number;
  uploadedAt?: string;
  url?: string;
  type?: 'voice' | 'image' | 'attachment' | 'pdf';
  fileHash?: string; // SHA-256 hash for legal authentication
}
