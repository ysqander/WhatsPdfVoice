
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

// Find chat file by recursing and testing for timestamp pattern
function findChatFile(dir: string): string | undefined {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      const found = findChatFile(p);
      if (found) return found;
    } else if (name.toLowerCase().endsWith('.txt')) {
      const firstChunk = fs.readFileSync(p, 'utf8').slice(0, 500);
      if (/\[\d{2}\.\d{2}\.\d{2},\s*\d{2}:\d{2}:\d{2}\]/.test(firstChunk)) {
        return p;
      }
    }
  }
}

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
    
    // Find chat file or database
    const chatFilePath = findChatFile(extractDir);
    const dbFile = fs.readdirSync(extractDir).find(file => file === 'msgstore.db');
    
    let messages: Message[] = [];
    let participants: string[] = [];
    
    if (chatFilePath) {
      // Parse text chat file
      const { parsedMessages, parsedParticipants } = await parseTextChat(chatFilePath, extractDir, options);
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
    
    console.log('Parsed chat export:', {
      messageCount: messages.length,
      participantCount: participants.length,
      firstMessageSample: messages[0],
      options
    });
    
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
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);

  const messageRegex = /^\s*\[(\d{2}\.\d{2}\.\d{2}),\s*(\d{2}:\d{2}:\d{2})\]\s*([^:]+):\s*(.*)$/;
  const attachmentRegex = /<attached:\s*([^>]+)>/i;
  const systemMessagePatterns = [
    /Messages and calls are end-to-end encrypted/i,
    /You changed this group's/i,
    /.*created group.*\./i,
    /.*was added\./i,
    /.*left\./i,
    /.*removed\./i,
    /.*changed their phone number\./i,
    /.*changed the subject/i,
    /.*changed the group description\./i,
    /.*changed the group icon\./i,
    /.*security code changed\./i,
    /.*joined using this group's invite link\./i
  ];
  
  const parsedMessages: Message[] = [];
  let lastMsg: Message | null = null;
  const participants = new Set<string>();

  for (let line of lines) {
    // strip BOM and directional marks
    line = line.replace(/^[\uFEFF]/, '').replace(/[\u200E\u200F]/g, '').trimEnd();

    const m = line.match(messageRegex);
    if (m) {
      const [, date, time, sender, rawContent] = m;
      
      // Filter out system messages
      if (systemMessagePatterns.some(pattern => pattern.test(rawContent))) {
        lastMsg = null;
        continue;
      }
      
      // build ISO timestamp
      const [d, mo, y] = date.split('.');
      const iso = `20${y}-${mo}-${d}T${time}`;

      participants.add(sender);

      // determine type
      let type: Message['type'] = 'text';
      let content: string = rawContent;
      let mediaUrl: string|undefined, duration: number|undefined;

      const att = rawContent.match(attachmentRegex);
      if (att) {
        const name = att[1];
        const found = findAttachment(extractDir, name);
        if (found) {
          if (found.match(/\.(opus|m4a|mp3|ogg)$/i) && options.includeVoiceMessages) {
            type = 'voice';
            mediaUrl = `/media/${path.basename(found)}`;
            duration = 30;
            content = mediaUrl;
            
            // Copy the file to the media directory
            const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
            if (!fs.existsSync(mediaDir)) {
              fs.mkdirSync(mediaDir, { recursive: true });
            }
            fs.copyFileSync(found, path.join(mediaDir, path.basename(found)));
          } else if (found.match(/\.(jpg|jpeg|png|gif)$/i) && options.includeImages) {
            type = 'image';
            mediaUrl = `/media/${path.basename(found)}`;
            content = mediaUrl;
            
            // Copy the file to the media directory
            const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
            if (!fs.existsSync(mediaDir)) {
              fs.mkdirSync(mediaDir, { recursive: true });
            }
            fs.copyFileSync(found, path.join(mediaDir, path.basename(found)));
          } else if (options.includeAttachments) {
            type = 'attachment';
            mediaUrl = `/media/${path.basename(found)}`;
            content = mediaUrl;
            
            // Copy the file to the media directory
            const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media');
            if (!fs.existsSync(mediaDir)) {
              fs.mkdirSync(mediaDir, { recursive: true });
            }
            fs.copyFileSync(found, path.join(mediaDir, path.basename(found)));
          }
        }
      }

      lastMsg = { timestamp: iso, sender, content, type, mediaUrl, duration };
      parsedMessages.push(lastMsg);
    } else if (lastMsg) {
      // continuation of previous message
      lastMsg.content += '\n' + line.trim();
    }
  }

  return {
    parsedMessages,
    parsedParticipants: Array.from(participants)
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
