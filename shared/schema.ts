import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Media files table - stores only essential data for voice message access
// This follows our privacy-focused approach and doesn't store any chat content
export const mediaFiles = pgTable("media_files", {
  id: serial("id").primaryKey(),
  mediaId: text("media_id").notNull().unique(), // UUID used in proxy URLs
  r2Key: text("r2_key").notNull(), // R2 storage key
  mediaType: text("media_type").notNull().default("voice"), // Only storing voice files
  createdAt: timestamp("created_at").defaultNow().notNull(), // Used for auto-deletion policy
  expiresAt: timestamp("expires_at"), // Optional expiration date
});

// Create insert schema for media files
export const insertMediaFileSchema = createInsertSchema(mediaFiles).omit({
  id: true,
  createdAt: true,
});

// Types
export type MediaFile = typeof mediaFiles.$inferSelect;
export type InsertMediaFile = z.infer<typeof insertMediaFileSchema>;
