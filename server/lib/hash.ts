import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MediaFile } from '@shared/types';

/**
 * Calculate SHA-256 hash for a file
 * @param filePath Path to the file
 * @returns SHA-256 hash as hex string or undefined if file not found
 */
export function calculateFileHash(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }
    
    const fileBuffer = fs.readFileSync(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(fileBuffer);
    return hash.digest('hex');
  } catch (err) {
    console.error(`Error calculating hash for ${filePath}:`, err);
    return undefined;
  }
}

/**
 * Try to find the media file path for a MediaFile object
 * @param file MediaFile object
 * @param chatExportId Optional chat export ID to try in the path
 * @returns Full path to the file if found, undefined otherwise
 */
export function findMediaFilePath(file: MediaFile, chatExportId?: number): string | undefined {
  let mediaFilePath: string | undefined;
  
  // Try multiple paths to find the file
  const possiblePaths: string[] = [];
  
  // 1. Try to get the filename from file properties
  const fileName = 
    file.originalName || 
    (file.key ? path.basename(file.key) : undefined) || 
    file.id;
  
  if (!fileName) {
    return undefined;
  }
  
  // 2. Build possible paths based on our file storage conventions
  
  // 2.1 Try with chat ID subdirectory if provided
  if (chatExportId) {
    possiblePaths.push(
      path.join(os.tmpdir(), 'whatspdf', 'media', chatExportId.toString(), fileName)
    );
  }
  
  // 2.2 Try the main media directory
  possiblePaths.push(
    path.join(os.tmpdir(), 'whatspdf', 'media', fileName)
  );
  
  // 2.3 Try the type-specific directories if type is available
  if (file.type) {
    // Add possible paths for type-specific folders based on the file type
    const type = file.type;
    if (type === 'voice') {
      possiblePaths.push(path.join(os.tmpdir(), 'whatspdf', 'evidence', 'audio', fileName));
    } else if (type === 'image') {
      possiblePaths.push(path.join(os.tmpdir(), 'whatspdf', 'evidence', 'images', fileName));
    } else if (type === 'pdf') {
      possiblePaths.push(path.join(os.tmpdir(), 'whatspdf', 'evidence', 'pdfs', fileName));
    } else if (type === 'attachment') {
      possiblePaths.push(path.join(os.tmpdir(), 'whatspdf', 'evidence', 'other', fileName));
    }
  }
  
  // 3. Find the first path that exists
  for (const possiblePath of possiblePaths) {
    if (fs.existsSync(possiblePath)) {
      mediaFilePath = possiblePath;
      break;
    }
  }
  
  return mediaFilePath;
}

/**
 * Get file hash for a MediaFile object, calculating it if needed
 * @param file MediaFile object
 * @param chatExportId Optional chat export ID to try in the path
 * @returns SHA-256 hash as hex string or undefined if file not found
 */
export function getFileHash(file: MediaFile, chatExportId?: number): string | undefined {
  // If file already has a hash, return it
  if (file.fileHash) {
    return file.fileHash;
  }
  
  // Try to find the file path
  const filePath = findMediaFilePath(file, chatExportId);
  if (!filePath) {
    return undefined;
  }
  
  // Calculate the hash
  return calculateFileHash(filePath);
}