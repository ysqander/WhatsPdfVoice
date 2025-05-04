import { pgTable, text, serial, integer, boolean, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { relations } from "drizzle-orm";

// Chat export table to store the processed chats
export const chatExports = pgTable("chat_exports", {
  id: serial("id").primaryKey(),
  originalFilename: text("original_filename").notNull(),
  fileHash: text("file_hash").notNull(),
  participants: text("participants").array(),
  generatedAt: timestamp("generated_at").defaultNow().notNull(),
  pdfUrl: text("pdf_url"),
  processingOptions: text("processing_options").notNull(),
});

// Messages table to store individual messages
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  chatExportId: integer("chat_export_id").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  sender: text("sender").notNull(),
  content: text("content").notNull(),
  type: text("type").notNull().default("text"),
  mediaUrl: text("media_url"),
  duration: integer("duration"),
  isDeleted: boolean("is_deleted").default(false)
});

// Media files table to store uploaded media
export const mediaFiles = pgTable("media_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  chatExportId: integer("chat_export_id").notNull(),
  messageId: integer("message_id"),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  url: text("url"),
  type: text("type").notNull().default("attachment"),
});

// Processing progress table to track file processing
export const processingProgress = pgTable("processing_progress", {
  clientId: text("client_id").primaryKey(),
  progress: integer("progress").notNull().default(0),
  step: integer("step"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Relations
export const chatExportsRelations = relations(chatExports, ({ many }) => ({
  messages: many(messages),
  mediaFiles: many(mediaFiles),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  chatExport: one(chatExports, {
    fields: [messages.chatExportId],
    references: [chatExports.id],
  }),
}));

export const mediaFilesRelations = relations(mediaFiles, ({ one }) => ({
  chatExport: one(chatExports, {
    fields: [mediaFiles.chatExportId],
    references: [chatExports.id],
  }),
  message: one(messages, {
    fields: [mediaFiles.messageId],
    references: [messages.id],
  }),
}));

// Create insert schemas
export const insertChatExportSchema = createInsertSchema(chatExports).omit({
  id: true,
  generatedAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
});

export const insertMediaFileSchema = createInsertSchema(mediaFiles).omit({
  id: true,
  uploadedAt: true,
});

export const insertProcessingProgressSchema = createInsertSchema(processingProgress).omit({
  updatedAt: true,
});

// Types
export type ChatExport = typeof chatExports.$inferSelect;
export type InsertChatExport = z.infer<typeof insertChatExportSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type MediaFile = typeof mediaFiles.$inferSelect;
export type InsertMediaFile = z.infer<typeof insertMediaFileSchema>;
export type ProcessingProgress = typeof processingProgress.$inferSelect;
export type InsertProcessingProgress = z.infer<typeof insertProcessingProgressSchema>;
