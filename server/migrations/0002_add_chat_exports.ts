
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const chatExports = pgTable("chat_exports", {
  id: integer("id").primaryKey(),
  originalFilename: text("original_filename").notNull(),
  fileHash: text("file_hash").notNull(),
  participants: text("participants").array(),
  generatedAt: timestamp("generated_at").defaultNow(),
  pdfUrl: text("pdf_url"),
  processingOptions: text("processing_options").notNull()
});
