import { 
  S3Client, 
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

// Initialize Cloudflare R2 client
const s3Client = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  },
});

// Bucket name
const BUCKET_NAME = "whatspdf";

// File types we support
const ALLOWED_MIME_TYPES: Record<string, string> = {
  // Audio files
  "audio/ogg": ".ogg",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/webm": ".webm",
  // Image files
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  // Documents
  "application/pdf": ".pdf",
  // Archives
  "application/zip": ".zip",
  "application/x-zip-compressed": ".zip",
};

// Default expiration time for signed URLs (7 days - AWS maximum)
const DEFAULT_EXPIRATION = 60 * 60 * 24 * 7;

// Maximum allowed expiration time by AWS S3 (7 days)
const MAX_EXPIRATION = 60 * 60 * 24 * 7;

export interface R2StorageObjectMetadata {
  key: string;
  size: number;
  lastModified: Date;
  contentType: string;
  url: string;
}

/**
 * Upload a file to R2 storage
 * @param filePath Local file path to upload
 * @param contentType MIME type of the file
 * @param directory Optional directory within the bucket
 * @returns Object key in R2
 */
export async function uploadFileToR2(
  filePath: string,
  contentType: string,
  directory: string = "media"
): Promise<string> {
  try {
    // Validate file exists
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Determine file extension
    let fileExt = path.extname(filePath);
    if (!fileExt && ALLOWED_MIME_TYPES[contentType]) {
      fileExt = ALLOWED_MIME_TYPES[contentType];
    }

    // Generate unique key
    const uniqueId = uuidv4();
    const fileName = path.basename(filePath, path.extname(filePath));
    const sanitizedName = fileName.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const key = `${directory}/${sanitizedName}_${uniqueId}${fileExt}`;

    // Read file data
    const fileContent = fs.readFileSync(filePath);

    // Upload to R2
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: fileContent,
      ContentType: contentType,
      Metadata: {
        originalName: path.basename(filePath),
        uploadDate: new Date().toISOString(),
      },
    });

    await s3Client.send(command);
    console.log(`Uploaded file to R2: ${key}`);
    return key;
  } catch (error) {
    console.error("Error uploading file to R2:", error);
    throw error;
  }
}

/**
 * Generate a pre-signed URL for an object in R2
 * @param key Object key in R2
 * @param expiresIn Expiration time in seconds (default: 6 hours)
 * @returns Pre-signed URL
 */
export async function getSignedR2Url(
  key: string,
  expiresIn: number = DEFAULT_EXPIRATION
): Promise<string> {
  try {
    // Ensure expiration doesn't exceed AWS maximum
    const safeExpiration = Math.min(expiresIn, MAX_EXPIRATION);
    
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    const signedUrl = await getSignedUrl(s3Client, command, {
      expiresIn: safeExpiration,
    });

    return signedUrl;
  } catch (error) {
    console.error("Error generating signed URL:", error);
    throw error;
  }
}

/**
 * Delete a file from R2 storage
 * @param key Object key in R2
 * @returns Success status
 */
export async function deleteFileFromR2(key: string): Promise<boolean> {
  try {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    });

    await s3Client.send(command);
    console.log(`Deleted file from R2: ${key}`);
    return true;
  } catch (error) {
    console.error("Error deleting file from R2:", error);
    throw error;
  }
}

/**
 * List all files in a directory in R2
 * @param directory Directory prefix to list
 * @returns Array of object metadata
 */
export async function listFilesInR2(
  directory: string = "media"
): Promise<R2StorageObjectMetadata[]> {
  try {
    const command = new ListObjectsCommand({
      Bucket: BUCKET_NAME,
      Prefix: directory,
    });

    const response = await s3Client.send(command);
    const objects = response.Contents || [];

    // Generate signed URLs for each object
    const metadataPromises = objects.map(async (object) => {
      const key = object.Key!;
      const url = await getSignedR2Url(key);
      
      return {
        key,
        size: object.Size || 0,
        lastModified: object.LastModified || new Date(),
        contentType: object.StorageClass || "unknown",
        url,
      };
    });

    return Promise.all(metadataPromises);
  } catch (error) {
    console.error("Error listing files in R2:", error);
    throw error;
  }
}

/**
 * Test connection to R2
 * @returns True if connection successful
 */
export async function testR2Connection(): Promise<boolean> {
  try {
    const command = new ListObjectsCommand({
      Bucket: BUCKET_NAME,
      MaxKeys: 1,
    });

    await s3Client.send(command);
    console.log("R2 connection successful");
    return true;
  } catch (error) {
    console.error("R2 connection failed:", error);
    return false;
  }
}