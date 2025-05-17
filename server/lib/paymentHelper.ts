import { FREE_TIER_MESSAGE_LIMIT, FREE_TIER_MEDIA_SIZE_LIMIT } from "../../shared/types";
import { paymentService } from "./paymentService";
import type { ChatExport } from "../../shared/types";
import type { MediaFile } from "../../shared/schema";

/**
 * Determines if a chat export requires payment based on free tier limits
 * @param messageCount Number of messages in the chat
 * @param mediaSizeBytes Total size of media files in bytes
 * @returns Boolean indicating if payment is required
 */
export function isPaymentRequired(messageCount: number, mediaSizeBytes: number): boolean {
  // If message count is under limit AND media size is under limit, it's free
  return messageCount > FREE_TIER_MESSAGE_LIMIT || mediaSizeBytes > FREE_TIER_MEDIA_SIZE_LIMIT;
}

/**
 * Calculate the total size of media files in a chat export
 * @param mediaFiles Array of media files
 * @returns Total size in bytes
 */
export function calculateMediaSize(mediaFiles: MediaFile[]): number {
  return mediaFiles.reduce((total, file) => total + (file.size || 0), 0);
}

/**
 * Create a payment bundle for a chat export that exceeds free tier limits
 * @param chatExport The chat export
 * @param mediaFiles Array of media files
 * @returns Bundle ID if payment is required, null if free
 */
export async function handlePaymentCheck(
  chatExport: ChatExport,
  mediaFiles: MediaFile[]
): Promise<{ requiresPayment: boolean; bundleId?: string }> {
  // Calculate message count and media size
  const messageCount = chatExport.messages.length;
  const mediaSizeBytes = calculateMediaSize(mediaFiles);
  
  // Check if payment is required
  const requiresPayment = isPaymentRequired(messageCount, mediaSizeBytes);
  
  if (!requiresPayment) {
    // No payment required, it's free
    return { requiresPayment: false };
  }
  
  // Create a payment bundle
  const bundle = await paymentService.createPaymentBundle(
    chatExport.id as number,
    messageCount,
    mediaSizeBytes
  );
  
  return {
    requiresPayment: true,
    bundleId: bundle.bundleId
  };
}