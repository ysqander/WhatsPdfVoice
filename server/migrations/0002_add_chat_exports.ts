
import { integer, pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const messages = pgTable("messages", {
  id: integer("id").primaryKey(),
  chatExportId: integer("chat_export_id").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  sender: text("sender").notNull(),
  content: text("content").notNull(),
  type: text("type").notNull(),
  mediaUrl: text("media_url"),
  duration: integer("duration"),
  isDeleted: boolean("is_deleted").default(false)
});

export const mediaFiles = pgTable("media_files", {
  id: text("id").primaryKey(),
  key: text("key").notNull(),
  chatExportId: integer("chat_export_id"),
  messageId: integer("message_id"),
  originalName: text("original_name"),
  contentType: text("content_type").notNull(),
  size: integer("size"),
  url: text("url"),
  type: text("type"),
  fileHash: text("file_hash"),
  uploadedAt: timestamp("uploaded_at").defaultNow(),
});

export const chatExports = pgTable("chat_exports", {
  id: integer("id").primaryKey(),
  originalFilename: text("original_filename").notNull(),
  fileHash: text("file_hash").notNull(),
  participants: text("participants").array(),
  generatedAt: timestamp("generated_at").defaultNow(),
  pdfUrl: text("pdf_url"),
  processingOptions: text("processing_options").notNull()
});
