import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Media proxy files table - only storing essential information for our proxy
export const mediaProxyFiles = pgTable("media_proxy_files", {
  id: uuid("id").primaryKey().defaultRandom(), // The mediaId that will be used in proxy URLs
  r2Key: text("r2_key").notNull(),             // R2 object key for regenerating signed URLs
  r2Url: text("r2_url").notNull(),             // Current R2 signed URL (will be refreshed)
  contentType: text("content_type").notNull(), // MIME type for proper content-type headers
  createdAt: timestamp("created_at").defaultNow().notNull(), // For purging old entries
  lastAccessed: timestamp("last_accessed").defaultNow(), // Track when the file was last accessed
  expiryDate: timestamp("expiry_date"), // Optional explicit expiry date
});

// Create insert schema
export const insertMediaProxyFileSchema = createInsertSchema(mediaProxyFiles).omit({
  id: true,
  createdAt: true,
  lastAccessed: true,
});

// Types
export type MediaProxyFile = typeof mediaProxyFiles.$inferSelect;
export type InsertMediaProxyFile = z.infer<typeof insertMediaProxyFileSchema>;

// Re-export types needed for compatibility with existing code
export type ChatExport = {
  id?: number;
  originalFilename: string;
  fileHash: string;
  participants?: string[];
  generatedAt?: Date;
  pdfUrl?: string;
  processingOptions: any;
  messages?: Message[];
};

export type InsertChatExport = {
  originalFilename: string;
  fileHash: string;
  participants?: string[];
  pdfUrl?: string;
  processingOptions: any;
};

export type Message = {
  id?: number;
  chatExportId?: number;
  timestamp: Date | string;
  sender: string;
  content: string;
  type: string;
  mediaUrl?: string;
  duration?: number;
  isDeleted?: boolean;
};

export type InsertMessage = {
  chatExportId: number;
  timestamp: Date | string;
  sender: string;
  content: string;
  type: string;
  mediaUrl?: string;
  duration?: number;
  isDeleted?: boolean;
};

// Keep MediaFile type for compatibility with existing code
export type MediaFile = {
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
};
