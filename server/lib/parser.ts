import AdmZip from "adm-zip";
import fs from "fs";
import path from "path";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import { v4 as uuidv4 } from "uuid";
import { ChatExport, Message, ProcessingOptions } from "@shared/types";
import os from "os";

// Temporary directory for extraction
const tempDir = path.join(os.tmpdir(), 'whatspdf-temp');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Regex patterns for parsing text chat
const messageRegex = /^\[(\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2})\] ([^:]+): (.+)$/;
const dateRegex = /(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/;

// Parse WhatsApp chat export ZIP file
export async function parse(filePath: string, options: ProcessingOptions): Promise<ChatExport> {
  // Create a unique extraction directory
  const extractDir = path.join(tempDir, uuidv4());
  if (!fs.existsSync(extractDir)) {
    fs.mkdirSync(extractDir, { recursive: true });
  }
  
  try {
    // Extract ZIP file
    const zip = new AdmZip(filePath);
    zip.extractAllTo(extractDir, true);
    
    // Check for text chat vs database format
    const files = fs.readdirSync(extractDir);
    
    // Find the chat text file (_chat.txt)
    const chatFile = files.find(file => file.endsWith('_chat.txt') || file === 'chat.txt');
    // Check for SQLite database
    const dbFile = files.find(file => file === 'msgstore.db');
    
    let messages: Message[] = [];
    let participants: string[] = [];
    
    if (chatFile) {
      // Parse text chat file
      const { parsedMessages, parsedParticipants } = await parseTextChat(path.join(extractDir, chatFile), extractDir, options);
      messages = parsedMessages;
      participants = parsedParticipants;
    } else if (dbFile) {
      // Parse SQLite database
      const { parsedMessages, parsedParticipants } = await parseDatabase(path.join(extractDir, dbFile), extractDir, options);
      messages = parsedMessages;
      participants = parsedParticipants;
    } else {
      throw new Error('No chat data found in the ZIP file');
    }
    
    // Create and return chat export object
    const chatExport: ChatExport = {
      originalFilename: path.basename(filePath),
      fileHash: '', // Will be set by the controller
      participants,
      messages,
      processingOptions: options
    };
    
    return chatExport;
    
  } catch (error) {
    // Clean up
    if (fs.existsSync(extractDir)) {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
    
    throw error;
  }
}

// Parse text chat file
async function parseTextChat(filePath: string, extractDir: string, options: ProcessingOptions): Promise<{ parsedMessages: Message[], parsedParticipants: string[] }> {
  const chatText = fs.readFileSync(filePath, 'utf8');
  const lines = chatText.split('\n');
  
  const parsedMessages: Message[] = [];
  const participantsSet = new Set<string>();
  
  for (const line of lines) {
    const match = line.match(messageRegex);
    if (match) {
      const [, timestamp, sender, content] = match;
      
      // Parse timestamp to ISO format
      const dateMatch = timestamp.match(dateRegex);
      if (!dateMatch) continue;
      
      const [, day, month, year, hours, minutes, seconds] = dateMatch;
      const isoTimestamp = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
      
      participantsSet.add(sender);
      
      // Determine message type
      let messageType: Message['type'] = 'text';
      let mediaUrl: string | undefined;
      let duration: number | undefined;
      
      if (content.includes('<attached: ')) {
        const attachmentMatch = content.match(/<attached: ([^>]+)>/);
        if (attachmentMatch) {
          const attachmentName = attachmentMatch[1];
          
          // Look for the file in the extracted directory
          const attachmentPath = findAttachment(extractDir, attachmentName);
          
          if (attachmentPath) {
            // Determine file type
            if (attachmentPath.match(/\.(opus|m4a|mp3|ogg)$/i) && options.includeVoiceMessages) {
              messageType = 'voice';
              mediaUrl = `/media/${path.basename(attachmentPath)}`;
              // For voice messages, estimate duration (could be extracted from the file)
              duration = 30; // Default to 30 seconds
            } else if (attachmentPath.match(/\.(jpg|jpeg|png|gif)$/i) && options.includeImages) {
              messageType = 'image';
              mediaUrl = `/media/${path.basename(attachmentPath)}`;
            } else if (options.includeAttachments) {
              messageType = 'attachment';
              mediaUrl = `/media/${path.basename(attachmentPath)}`;
            } else {
              // Skip this attachment if not included in options
              continue;
            }
            
            // Copy the file to the media directory
            const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
            if (!fs.existsSync(mediaDir)) {
              fs.mkdirSync(mediaDir, { recursive: true });
            }
            
            fs.copyFileSync(attachmentPath, path.join(mediaDir, path.basename(attachmentPath)));
          }
        }
      }
      
      parsedMessages.push({
        timestamp: isoTimestamp,
        sender,
        content: messageType === 'text' ? content : mediaUrl || '',
        type: messageType,
        mediaUrl,
        duration
      });
    }
  }
  
  return {
    parsedMessages,
    parsedParticipants: Array.from(participantsSet)
  };
}

// Parse SQLite database
async function parseDatabase(dbPath: string, extractDir: string, options: ProcessingOptions): Promise<{ parsedMessages: Message[], parsedParticipants: string[] }> {
  const db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  
  try {
    // Query to get messages with sender and content
    const rows = await db.all(`
      SELECT 
        messages.timestamp, 
        jid.raw_string AS sender,
        messages.data AS content,
        messages.media_url,
        messages.media_mime_type,
        messages.media_duration
      FROM messages
      JOIN jid ON messages.sender_jid = jid.jid
      ORDER BY messages.timestamp
    `);
    
    const parsedMessages: Message[] = [];
    const participantsSet = new Set<string>();
    
    for (const row of rows) {
      // Format sender (remove phone numbers, etc.)
      const sender = formatSender(row.sender);
      
      if (sender) {
        participantsSet.add(sender);
      }
      
      // Determine message type based on media_mime_type
      let messageType: Message['type'] = 'text';
      let mediaUrl: string | undefined;
      let duration: number | undefined;
      
      if (row.media_mime_type) {
        if (row.media_mime_type.startsWith('audio/') && options.includeVoiceMessages) {
          messageType = 'voice';
          mediaUrl = row.media_url ? `/media/${path.basename(row.media_url)}` : undefined;
          duration = row.media_duration;
          
          // Copy the media file if it exists
          if (row.media_url) {
            const sourceFile = path.join(extractDir, row.media_url);
            if (fs.existsSync(sourceFile)) {
              const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }
              
              fs.copyFileSync(sourceFile, path.join(mediaDir, path.basename(row.media_url)));
            }
          }
        } else if (row.media_mime_type.startsWith('image/') && options.includeImages) {
          messageType = 'image';
          mediaUrl = row.media_url ? `/media/${path.basename(row.media_url)}` : undefined;
          
          // Copy the media file if it exists
          if (row.media_url) {
            const sourceFile = path.join(extractDir, row.media_url);
            if (fs.existsSync(sourceFile)) {
              const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }
              
              fs.copyFileSync(sourceFile, path.join(mediaDir, path.basename(row.media_url)));
            }
          }
        } else if (options.includeAttachments) {
          messageType = 'attachment';
          mediaUrl = row.media_url ? `/media/${path.basename(row.media_url)}` : undefined;
          
          // Copy the media file if it exists
          if (row.media_url) {
            const sourceFile = path.join(extractDir, row.media_url);
            if (fs.existsSync(sourceFile)) {
              const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
              if (!fs.existsSync(mediaDir)) {
                fs.mkdirSync(mediaDir, { recursive: true });
              }
              
              fs.copyFileSync(sourceFile, path.join(mediaDir, path.basename(row.media_url)));
            }
          }
        } else {
          // Skip this message if attachments not included
          continue;
        }
      }
      
      // Convert Unix timestamp to ISO date
      const timestamp = new Date(row.timestamp).toISOString();
      
      parsedMessages.push({
        timestamp,
        sender: sender || 'Unknown',
        content: messageType === 'text' ? row.content : mediaUrl || '',
        type: messageType,
        mediaUrl,
        duration
      });
    }
    
    return {
      parsedMessages,
      parsedParticipants: Array.from(participantsSet)
    };
    
  } finally {
    await db.close();
  }
}

// Helper to format sender from raw JID
function formatSender(rawJid: string): string {
  // Extract name or phone number from JID
  const match = rawJid.match(/^([^@]+)@/);
  if (match) {
    return match[1];
  }
  return rawJid;
}

// Helper to find an attachment in the extracted directory
function findAttachment(extractDir: string, attachmentName: string): string | undefined {
  // Simple case: file exists directly
  const directPath = path.join(extractDir, attachmentName);
  if (fs.existsSync(directPath)) {
    return directPath;
  }
  
  // Search in subdirectories
  const searchRecursive = (dir: string): string | undefined => {
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        const result = searchRecursive(filePath);
        if (result) return result;
      } else if (file === attachmentName || file.endsWith(attachmentName)) {
        return filePath;
      }
    }
    
    return undefined;
  };
  
  return searchRecursive(extractDir);
}
