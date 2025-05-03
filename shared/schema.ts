import { pgTable, text, serial, integer, timestamp, uuid, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Media files table - Only stores information needed for the media proxy system
export const mediaFiles = pgTable("media_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  key: text("key").notNull(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  uploadedAt: timestamp("uploaded_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"), // Can be used to auto-delete media after X months
  url: text("url"),
  type: text("type").notNull().default("attachment"),
});

// Processing progress table to track file processing during uploads
export const processingProgress = pgTable("processing_progress", {
  clientId: text("client_id").primaryKey(),
  progress: integer("progress").notNull().default(0),
  step: integer("step"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Create insert schemas
export const insertMediaFileSchema = createInsertSchema(mediaFiles).omit({
  id: true,
  uploadedAt: true,
});

export const insertProcessingProgressSchema = createInsertSchema(processingProgress).omit({
  updatedAt: true,
});

// Types
export type MediaFile = typeof mediaFiles.$inferSelect;
export type InsertMediaFile = z.infer<typeof insertMediaFileSchema>;
export type ProcessingProgress = typeof processingProgress.$inferSelect;
export type InsertProcessingProgress = z.infer<typeof insertProcessingProgressSchema>;
