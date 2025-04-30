import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

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

// Create insert schemas
export const insertChatExportSchema = createInsertSchema(chatExports).omit({
  id: true,
  generatedAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
});

// Types
export type ChatExport = typeof chatExports.$inferSelect;
export type InsertChatExport = z.infer<typeof insertChatExportSchema>;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
