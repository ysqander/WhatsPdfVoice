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
  GENERATE_PDF = 3
}

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
}
