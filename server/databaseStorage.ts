import { db } from "./db";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { eq, and, desc } from "drizzle-orm";
import {
  type ChatExport,
  type Message,
  type InsertChatExport,
  type InsertMessage,
  type MediaFile,
  chatExports,
  messages,
  mediaFiles,
  processingProgress,
} from "@shared/schema";
import { IStorage } from "./storage";
import { ProcessingOptions } from "@shared/types";
import {
  getSignedR2Url,
  uploadFileToR2,
  deleteFileFromR2,
} from "./lib/r2Storage";

export class DatabaseStorage implements IStorage {
  /**
   * Save a chat export
   */
  async saveChatExport(data: InsertChatExport): Promise<ChatExport> {
    // Convert ProcessingOptions to string for database storage
    const insertData = {
      ...data,
      processingOptions: JSON.stringify(data.processingOptions),
    };

    const [chatExport] = await db
      .insert(chatExports)
      .values(insertData)
      .returning();

    return {
      ...chatExport,
      // Convert string back to ProcessingOptions object
      processingOptions: JSON.parse(
        chatExport.processingOptions,
      ) as ProcessingOptions,
    };
  }

  /**
   * Get a chat export by ID
   */
  async getChatExport(id: number): Promise<ChatExport | undefined> {
    const [chatExport] = await db
      .select()
      .from(chatExports)
      .where(eq(chatExports.id, id));

    if (!chatExport) return undefined;

    return {
      ...chatExport,
      // Convert string back to ProcessingOptions object
      processingOptions: JSON.parse(
        chatExport.processingOptions,
      ) as ProcessingOptions,
    };
  }

  /**
   * Save a message
   */
  async saveMessage(message: InsertMessage): Promise<Message> {
    const [savedMessage] = await db
      .insert(messages)
      .values(message)
      .returning();

    return savedMessage;
  }

  /**
   * Get messages by chat export ID
   */
  async getMessagesByChatExportId(chatExportId: number): Promise<Message[]> {
    const messagesList = await db
      .select()
      .from(messages)
      .where(eq(messages.chatExportId, chatExportId));

    return messagesList;
  }

  /**
   * Get the latest chat export
   */
  async getLatestChatExport(): Promise<ChatExport | undefined> {
    const [chatExport] = await db
      .select()
      .from(chatExports)
      .orderBy(desc(chatExports.generatedAt))
      .limit(1);

    if (!chatExport) return undefined;

    return {
      ...chatExport,
      // Convert string back to ProcessingOptions object
      processingOptions: JSON.parse(
        chatExport.processingOptions,
      ) as ProcessingOptions,
    };
  }

  /**
   * Save processing progress
   */
  async saveProcessingProgress(
    clientId: string,
    progress: number,
    step?: number,
  ): Promise<void> {
    await db
      .insert(processingProgress)
      .values({
        clientId,
        progress,
        step,
      })
      .onConflictDoUpdate({
        target: processingProgress.clientId,
        set: {
          progress,
          step,
          updatedAt: new Date(),
        },
      });
  }

  /**
   * Get processing progress
   */
  async getProcessingProgress(
    clientId: string,
  ): Promise<{ progress: number; step?: number }> {
    const [progress] = await db
      .select()
      .from(processingProgress)
      .where(eq(processingProgress.clientId, clientId));

    if (!progress) {
      return { progress: 0 };
    }

    return {
      progress: progress.progress,
      step: progress.step,
    };
  }

  /**
   * Save PDF URL for chat export
   */
  async savePdfUrl(chatExportId: number, pdfUrl: string): Promise<void> {
    await db
      .update(chatExports)
      .set({ pdfUrl })
      .where(eq(chatExports.id, chatExportId));
  }

  /**
   * Upload media to R2 and save to database
   */
  async uploadMediaToR2(
    filePath: string,
    contentType: string,
    chatExportId: number,
    messageId?: number,
    type: "voice" | "image" | "attachment" | "pdf" = "attachment",
    originalName?: string,
    fileHash?: string,
  ): Promise<MediaFile> {
    try {
      // Get file stats for size
      const stats = fs.statSync(filePath);
      const fileName = originalName || path.basename(filePath);

      // Generate R2 key using directory structure for organization
      const typeFolder =
        type === "voice"
          ? "voice"
          : type === "image"
            ? "images"
            : type === "pdf"
              ? "pdf"
              : "attachments";

      const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
      const uniqueSuffix = uuidv4();
      const key = `chats/${chatExportId}/${typeFolder}/${sanitizedFileName.replace(/\s+/g, "_")}_${uniqueSuffix}.${path.extname(filePath).slice(1)}`;

      // Upload file to R2
      await uploadFileToR2(filePath, contentType, key);
      console.log(`Uploaded file to R2: ${key}`);

      // Get signed URL (this will expire, but our proxy system will handle that)
      const url = await getSignedR2Url(key);

      // Generate a UUID for the media file ID
      const id = uuidv4();
      
      // Create media file record in database
      const [mediaFile] = await db
        .insert(mediaFiles)
        .values({
          id,
          key,
          chatExportId,
          messageId,
          originalName,
          contentType,
          size: stats.size,
          url,
          type,
        })
        .returning();

      console.log(`Uploaded media file to R2: ${key}`);
      return mediaFile;
    } catch (error) {
      console.error("Error uploading media to R2:", error);
      throw error;
    }
  }

  /**
   * Get a fresh signed URL for a media file using our proxy system
   */
  async getMediaUrl(mediaId: string): Promise<string> {
    // First, check if the media file exists
    const [mediaFile] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaId));

    if (!mediaFile) {
      throw new Error(`Media file with ID ${mediaId} not found`);
    }

    // Generate a fresh signed URL with a new expiration
    const freshUrl = await getSignedR2Url(mediaFile.key);

    // Update the URL in the database
    await db
      .update(mediaFiles)
      .set({ url: freshUrl })
      .where(eq(mediaFiles.id, mediaId));

    return freshUrl;
  }

  /**
   * Delete a media file from R2 and from the database
   */
  async deleteMedia(mediaId: string): Promise<boolean> {
    // Get the media file to get the R2 key
    const [mediaFile] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaId));

    if (!mediaFile) {
      return false;
    }

    try {
      // Delete from R2
      await deleteFileFromR2(mediaFile.key);

      // Delete from database
      await db.delete(mediaFiles).where(eq(mediaFiles.id, mediaId));

      // If this media file is associated with a message, update the message
      if (mediaFile.messageId) {
        await db
          .update(messages)
          .set({ mediaUrl: null })
          .where(eq(messages.id, mediaFile.messageId));
      }

      return true;
    } catch (error) {
      console.error(`Error deleting media file ${mediaId}:`, error);
      return false;
    }
  }

  /**
   * Get all media files for a chat export
   */
  async getMediaFilesByChat(chatExportId: number): Promise<MediaFile[]> {
    const mediaFilesList = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.chatExportId, chatExportId));

    return mediaFilesList;
  }

  /**
   * Get a specific media file by ID
   */
  async getMediaFile(mediaId: string): Promise<MediaFile | undefined> {
    const [mediaFile] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.id, mediaId));

    return mediaFile;
  }

  /**
   * Update a message with R2 media URL
   */
  async updateMessageMediaUrl(
    messageId: number,
    r2Key: string,
    r2Url: string,
  ): Promise<void> {
    // Determine the base URL of our application for absolute URLs
    const appBaseUrl = process.env.REPLIT_DOMAINS
      ? `https://${process.env.REPLIT_DOMAINS}`
      : "http://localhost:5000";

    // Find existing media for this message
    const [existingMedia] = await db
      .select()
      .from(mediaFiles)
      .where(eq(mediaFiles.messageId, messageId));

    let mediaId: string;

    if (!existingMedia) {
      // Get the message to determine the content type and media type
      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, messageId));

      if (!message) {
        throw new Error(`Message with ID ${messageId} not found`);
      }

      let contentType = "application/octet-stream";
      let type: "voice" | "image" | "attachment" | "pdf" = "attachment";

      // Determine content type and type from message
      if (message.type === "voice") {
        contentType = "audio/ogg";
        type = "voice";
      } else if (message.type === "image") {
        contentType = "image/jpeg";
        type = "image";
      }

      // Generate a UUID for the media file ID
      const mediaFileId = uuidv4();
      
      // Create a new media file record
      const [mediaFile] = await db
        .insert(mediaFiles)
        .values({
          id: mediaFileId,
          key: r2Key,
          chatExportId: message.chatExportId,
          messageId,
          originalName: path.basename(r2Key),
          contentType,
          size: 0, // We don't know the size
          url: r2Url,
          type,
        })
        .returning();

      mediaId = mediaFile.id;
    } else {
      mediaId = existingMedia.id;

      // Update the existing media file with the new URL
      await db
        .update(mediaFiles)
        .set({
          key: r2Key,
          url: r2Url,
        })
        .where(eq(mediaFiles.id, mediaId));
    }

    // Create a proxy URL that points to our server
    const proxyUrl = `${appBaseUrl}/api/media/proxy/${mediaId}`;
    console.log(`Setting message ${messageId} media URL to proxy: ${proxyUrl}`);

    // Update the message with the proxy URL
    await db
      .update(messages)
      .set({ mediaUrl: proxyUrl })
      .where(eq(messages.id, messageId));
  }

  // In MemStorage or DatabaseStorage class:
  async updateMessageProxyUrl(
    messageId: number,
    proxyUrl: string,
  ): Promise<void> {
    try {
      const result = await db
        .update(messages)
        .set({ mediaUrl: proxyUrl })
        .where(eq(messages.id, messageId))
        .returning({ updatedId: messages.id }); // Optional: check if update happened

      if (result.length > 0) {
        console.log(
          `[DBStorage] Updated message ${messageId} mediaUrl to ${proxyUrl}`,
        );
      } else {
        console.warn(
          `[DBStorage] Message ${messageId} not found or mediaUrl unchanged.`,
        );
      }
    } catch (error) {
      console.error(
        `[DBStorage] Error updating message ${messageId} proxy URL:`,
        error,
      );
      throw error; // Re-throw the error to be handled upstream
    }
  }
}
