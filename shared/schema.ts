import { pgTable, text, timestamp, uuid, integer, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Processing progress table
export const processingProgress = pgTable("processing_progress", {
  clientId: text("client_id").primaryKey(),
  progress: integer("progress").notNull(),
  step: integer("step"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// Messages table
export const messages = pgTable("messages", {
  id: integer("id").primaryKey().default(sql`nextval('messages_id_seq'::regclass)`),
  chatExportId: integer("chat_export_id").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  sender: text("sender").notNull(),
  content: text("content").notNull(),
  type: text("type").notNull(),
  mediaUrl: text("media_url"),
  duration: integer("duration"),
  isDeleted: boolean("is_deleted").default(false)
});

// Media files table
export const mediaFiles = pgTable("media_files", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  chatExportId: integer("chat_export_id"),
  messageId: integer("message_id"),
  originalName: text("original_name"),
  contentType: text("content_type").notNull(),
  size: integer("size"),
  url: text("url"),
  type: text("type"), // 'voice' | 'image' | 'attachment' | 'pdf'
  fileHash: text("file_hash"),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
});

// Chat exports table
export const chatExports = pgTable("chat_exports", {
  id: integer("id").primaryKey().default(sql`nextval('chat_exports_id_seq'::regclass)`),
  originalFilename: text("original_filename").notNull(),
  fileHash: text("file_hash").notNull(),
  participants: text("participants").array(),
  generatedAt: timestamp("generated_at").defaultNow(),
  pdfUrl: text("pdf_url"),
  processingOptions: text("processing_options").notNull()
});

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

// Payment bundles table - tracks the status of chat export bundles that require payment
export const paymentBundles = pgTable("payment_bundles", {
  id: uuid("id").primaryKey().defaultRandom(), // Internal ID
  bundleId: text("bundle_id").notNull().unique(), // The bundle ID used in URLs and payment metadata
  chatExportId: integer("chat_export_id"), // Associated chat export ID (if any)
  r2TempKey: text("r2_temp_key"), // Temporary R2 storage location
  r2FinalKey: text("r2_final_key"), // Final R2 storage location after payment
  originalFileMediaId: text("original_file_media_id"), // ID of the uploaded original chat file in R2
  messageCount: integer("message_count"), // Number of messages in the chat
  mediaSizeBytes: integer("media_size_bytes"), // Total size of media files in bytes
  isPaid: boolean("is_paid").default(false), // Whether this bundle has been paid for
  stripeSessionId: text("stripe_session_id"), // Stripe checkout session ID
  createdAt: timestamp("created_at").defaultNow().notNull(), // When the bundle was created
  paidAt: timestamp("paid_at"), // When the bundle was paid for
  expiresAt: timestamp("expires_at"), // When the temporary bundle expires (24h after creation)
  emailAddress: text("email_address"), // Customer email for sending download link
});

// Create insert schemas for payment bundles
export const insertPaymentBundleSchema = createInsertSchema(paymentBundles).omit({
  id: true,
  createdAt: true,
  isPaid: true,
  paidAt: true,
});

// Types
export type MediaProxyFile = typeof mediaProxyFiles.$inferSelect;
export type InsertMediaProxyFile = z.infer<typeof insertMediaProxyFileSchema>;
export type PaymentBundle = typeof paymentBundles.$inferSelect;
export type InsertPaymentBundle = z.infer<typeof insertPaymentBundleSchema>;

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
  fileHash?: string; // SHA-256 hash for legal authentication
};
