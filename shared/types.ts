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
  timestamp: string | Date;
  sender: string;
  content: string;
  type: string;
  mediaUrl?: string | null;
  duration?: number | null;
  chatExportId?: number;
  isDeleted?: boolean | null;
}

export interface ChatExport {
  id?: number;
  originalFilename: string;
  fileHash: string;
  participants?: string[];
  messages: Message[];
  generatedAt?: string;
  pdfUrl?: string;
  processingOptions: ProcessingOptions | string;
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
