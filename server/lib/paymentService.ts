import Stripe from "stripe";
import { db } from "../db";
import { paymentBundles, PaymentBundle } from "../../shared/schema"; // Removed unused imports like insertPaymentBundleSchema, SchemaMessage
import { eq, and, lt, isNull } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import { storage } from "../storage"; // Assuming storage implements IStorage
import { mediaProxyStorage } from "../mediaProxyStorage";
import { generatePdf } from "./pdf";
import fs from "fs";
import path from "path";
import os from "os";
import { ChatExport, Message } from "../../shared/types"; // Using types from shared/types

// Ensure Stripe API key is available
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("STRIPE_SECRET_KEY environment variable is not set");
  // Consider throwing an error or exiting in a real application if Stripe is essential
}

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16", // Use a specific API version
});

export class PaymentService {
  /**
   * Create a payment bundle in the database
   * @param chatExportId The ID of the chat export
   * @param messageCount Number of messages in the chat
   * @param mediaSizeBytes Total size of media files in bytes
   * @param originalFileMediaId ID of the original chat file stored in R2 (optional, kept for potential future use but not for reprocessing)
   * @returns Created payment bundle
   */
  async createPaymentBundle(
    chatExportId: number,
    messageCount: number,
    mediaSizeBytes: number,
    originalFileMediaId?: string, // Keeping this parameter for potential future metadata, but not using it for reprocessing
  ): Promise<PaymentBundle> {
    const bundleId = uuidv4();

    const [bundle] = await db
      .insert(paymentBundles)
      .values({
        bundleId,
        chatExportId,
        messageCount,
        mediaSizeBytes,
        originalFileMediaId, // Store it if provided
        paidAt: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        createdAt: new Date(),
      })
      .returning();

    return bundle;
  }

  /**
   * Get a payment bundle by its ID
   * @param bundleId The bundle ID
   * @returns Payment bundle or undefined if not found
   */
  async getPaymentBundle(bundleId: string): Promise<PaymentBundle | undefined> {
    const [bundle] = await db
      .select()
      .from(paymentBundles)
      .where(eq(paymentBundles.bundleId, bundleId));

    return bundle;
  }

  /**
   * Mark a payment bundle as paid
   * @param bundleId The bundle ID
   * @returns Updated payment bundle or undefined if not found
   */
  async markBundleAsPaid(bundleId: string): Promise<PaymentBundle | undefined> {
    const [bundle] = await db
      .update(paymentBundles)
      .set({
        paidAt: new Date(),
        // Extend expiry significantly after payment (e.g., 30 days for download)
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .where(eq(paymentBundles.bundleId, bundleId))
      .returning();

    return bundle;
  }

  /**
   * Create a Stripe checkout session for a payment bundle
   * @param bundleId The bundle ID
   * @param successUrl URL to redirect on successful payment
   * @param cancelUrl URL to redirect on cancelled payment
   * @returns Checkout URL
   */
  async createCheckoutSession(
    bundleId: string,
    successUrl: string,
    cancelUrl: string,
  ): Promise<string> {
    const bundle = await this.getPaymentBundle(bundleId);
    if (!bundle) {
      throw new Error(`Payment bundle with ID ${bundleId} not found`);
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "WhatsApp Chat PDF Export", // More specific name
              description: `Transcript with ${bundle.messageCount || 0} messages and ${((bundle.mediaSizeBytes || 0) / (1024 * 1024)).toFixed(1)} MB media`,
            },
            unit_amount: 900, // $9.00 in cents (Adjust as needed)
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      success_url: successUrl, // Use dynamic success URL
      cancel_url: cancelUrl, // Use dynamic cancel URL
      client_reference_id: bundleId, // Link session to bundle
      metadata: {
        bundleId: bundleId,
        chatExportId: bundle.chatExportId?.toString() || "", // Include chat ID in metadata
      },
      // Consider adding automatic tax calculation if applicable
      // automatic_tax: { enabled: true },
      // Consider collecting billing address if needed for tax/fraud
      // billing_address_collection: 'required',
    });

    if (!session.url) {
      throw new Error("Stripe session URL not generated.");
    }
    return session.url;
  }

  /**
   * Handle a Stripe 'checkout.session.completed' event after signature verification.
   * @param sessionId The Stripe checkout session ID
   * @returns Updated payment bundle or undefined if not found or error occurs
   */
  async handleCheckoutSessionCompleted(
    sessionId: string,
  ): Promise<PaymentBundle | undefined> {
    try {
      console.log(
        `[PaymentService] Handling checkout.session.completed for session: ${sessionId}`,
      );

      // Retrieve the session details from Stripe (already verified by webhook handler)
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      // Extract bundleId (prefer metadata, fallback to client_reference_id)
      const bundleId =
        session.metadata?.bundleId || session.client_reference_id;
      if (!bundleId) {
        console.error(
          `[PaymentService] CRITICAL: No bundleId found in session metadata or client_reference_id for session ${sessionId}`,
        );
        return undefined; // Cannot proceed without bundleId
      }

      console.log(
        `[PaymentService] Processing payment completion for bundle ${bundleId}`,
      );

      // Get the bundle from DB
      const existingBundle = await this.getPaymentBundle(bundleId);
      if (!existingBundle) {
        console.error(
          `[PaymentService] Bundle ${bundleId} referenced by session ${sessionId} not found in database.`,
        );
        // Consider creating a notification/alert here for investigation
        return undefined;
      }

      // Idempotency Check: If already marked as paid, ensure PDF is linked and return
      if (existingBundle.paidAt) {
        console.log(
          `[PaymentService] Bundle ${bundleId} already marked as paid at ${existingBundle.paidAt}. Ensuring PDF link.`,
        );
        await this.ensurePdfGeneratedAndLinked(existingBundle); // Ensure PDF is ready even if already paid
        return existingBundle;
      }

      // Mark the bundle as paid in the database
      const updatedBundle = await this.markBundleAsPaid(bundleId);
      if (!updatedBundle) {
        console.error(
          `[PaymentService] Failed to mark bundle ${bundleId} as paid in the database.`,
        );
        return undefined; // Stop if update failed
      }
      console.log(
        `[PaymentService] Bundle ${bundleId} successfully marked as paid.`,
      );

      // Generate and link the final PDF *after* marking as paid
      await this.ensurePdfGeneratedAndLinked(updatedBundle);

      return updatedBundle;
    } catch (error) {
      console.error(
        `[PaymentService] Error handling checkout session completed event for session ${sessionId}:`,
        error,
      );
      // Depending on the error type, you might want specific handling (e.g., retries for network issues)
      return undefined; // Indicate failure
    }
  }

  /**
   * Ensures the final PDF for a paid bundle is generated, uploaded, and linked.
   * This function is designed to be idempotent. It fetches data directly from
   * the database, assuming the pre-payment processing correctly stored chat
   * details, messages, and media proxy URLs.
   *
   * @param bundle The payment bundle (must be marked as paid)
   */
  private async ensurePdfGeneratedAndLinked(
    bundle: PaymentBundle,
  ): Promise<void> {
    // Return type changed to void as it primarily performs actions
    if (!bundle.paidAt) {
      console.warn(
        `[PaymentService] ensurePdfGeneratedAndLinked called for unpaid bundle ${bundle.bundleId}. Skipping.`,
      );
      return;
    }
    if (!bundle.chatExportId) {
      console.error(
        `[PaymentService] Cannot generate PDF for bundle ${bundle.bundleId}: chatExportId is missing.`,
      );
      return;
    }

    const chatExportId = bundle.chatExportId;
    console.log(
      `[PaymentService] Ensuring PDF exists and is linked for paid chat export ${chatExportId}`,
    );

    try {
      // 1. Fetch ChatExport details
      const chatExport = await storage.getChatExport(chatExportId);
      if (!chatExport) {
        // This is critical if it happens after payment. Log / Alert needed.
        console.error(
          `[PaymentService] CRITICAL: ChatExport ${chatExportId} not found for paid bundle ${bundle.bundleId}.`,
        );
        return;
      }

      // 2. Check if a valid PDF (linked via proxy) already exists
      if (
        chatExport.pdfUrl &&
        chatExport.pdfUrl.includes("/api/media/proxy/")
      ) {
        try {
          const mediaId = chatExport.pdfUrl.split("/").pop();
          if (mediaId) {
            const mediaFile = await storage.getMediaFile(mediaId);
            // Check if the existing PDF seems to be the main generated transcript
            if (
              mediaFile &&
              (mediaFile.originalName === "MAIN_GENERATED_PDF" ||
                (mediaFile.type === "pdf" &&
                  mediaFile.fileHash?.startsWith("MAIN_PDF_")))
            ) {
              console.log(
                `[PaymentService] Valid PDF URL ${chatExport.pdfUrl} already exists for chat ${chatExportId}. Skipping regeneration.`,
              );
              return; // PDF seems correct, nothing more to do.
            } else {
              console.log(
                `[PaymentService] Existing PDF URL ${chatExport.pdfUrl} for chat ${chatExportId} seems invalid or is not the main transcript. Regenerating PDF.`,
              );
            }
          }
        } catch (e) {
          console.log(
            `[PaymentService] Error verifying existing PDF URL ${chatExport.pdfUrl}. Regenerating. Error: ${e}`,
          );
        }
      } else {
        console.log(
          `[PaymentService] No valid PDF proxy URL found for chat ${chatExportId}. Proceeding with PDF generation.`,
        );
      }

      // 3. Fetch Messages directly from the database
      // These messages should contain the correct proxy URLs set during pre-payment processing.
      console.log(
        `[PaymentService] Fetching messages from DB for chat ${chatExportId}...`,
      );
      const messages = await storage.getMessagesByChatExportId(chatExportId);
      console.log(
        `[PaymentService] Retrieved ${messages.length} messages from DB for chat ${chatExportId}.`,
      );

      if (messages.length === 0 && (bundle.messageCount ?? 0) > 0) {
        // CRITICAL: If payment happened but messages are gone from DB, this indicates a major issue.
        console.error(
          `[PaymentService] CRITICAL: No messages found in DB for paid chat ${chatExportId}, but bundle expected ${bundle.messageCount}. Cannot generate PDF content.`,
        );
        // TODO: Implement alerting / fallback mechanism (e.g., notify support).
        // Proceeding might generate an empty PDF, which is bad UX.
        // For now, let's stop here to prevent generating a bad PDF.
        return;
      } else if (messages.length > 0) {
        console.log(
          `[PaymentService] First message sample from DB: ID=${messages[0]?.id}, Type=${messages[0]?.type}, MediaURL=${messages[0]?.mediaUrl}`,
        );
      }

      // 4. Prepare data for PDF Generation (Normalize Timestamps)
      const normalizedMessages: Message[] = messages.map((message) => ({
        ...message,
        // Ensure timestamp is an ISO string for pdf-lib compatibility
        timestamp:
          typeof message.timestamp === "object" &&
          message.timestamp instanceof Date
            ? message.timestamp.toISOString()
            : String(message.timestamp),
        // Ensure mediaUrl is explicitly handled if potentially undefined from DB
        mediaUrl: message.mediaUrl ?? undefined,
      }));

      // Construct the full data object needed by generatePdf
      const fullChatData: ChatExport = {
        ...chatExport, // Use the data fetched earlier
        messages: normalizedMessages, // Use the messages fetched from DB
        id: chatExportId, // Ensure ID is set
        // Ensure processingOptions are parsed if stored as JSON string
        processingOptions:
          typeof chatExport.processingOptions === "string"
            ? JSON.parse(chatExport.processingOptions)
            : chatExport.processingOptions,
      };

      // 5. Generate the Final PDF
      console.log(
        `[PaymentService] Generating final PDF for chat ${chatExportId} using data fetched from DB...`,
      );
      const pdfResultPath = await generatePdf(fullChatData); // Pass the correct data object
      console.log(
        `[PaymentService] Final PDF generated locally at: ${pdfResultPath}`,
      );

      // 6. Upload Final PDF to R2
      // Determine the application's base URL for constructing the proxy URL
      const appDomain = process.env.REPLIT_DOMAINS
        ? process.env.REPLIT_DOMAINS.split(",")[0]
        : null;
      const appBaseUrl = appDomain
        ? `https://${appDomain}`
        : process.env.BASE_URL || "http://localhost:5000"; // Use BASE_URL env var if available

      console.log(
        `[PaymentService] Uploading final PDF to R2 for chat ${chatExportId}...`,
      );
      const pdfMediaFile = await storage.uploadMediaToR2(
        pdfResultPath,
        "application/pdf",
        chatExportId,
        undefined, // Not linked to a specific message
        "pdf", // Type is 'pdf' for the main transcript
        "MAIN_GENERATED_PDF", // Special originalName marker
        "MAIN_PDF_" + chatExportId, // Special fileHash marker
      );
      console.log(
        `[PaymentService] Final PDF uploaded to R2: key=${pdfMediaFile.key}, id=${pdfMediaFile.id}`,
      );

      // 7. Create a Media Proxy Record and Generate Proxy URL
      // This is crucial for the /api/media/proxy endpoint to work
      const mediaProxy = await mediaProxyStorage.createMediaProxy(
        pdfMediaFile.key,
        pdfMediaFile.url || '',
        "application/pdf"
      );
      console.log(
        `[PaymentService] Created media proxy record for PDF: ${mediaProxy.id}`
      );

      // Now generate the proxy URL with the proxy ID (not the media file ID)
      const finalPdfUrl = `${appBaseUrl}/api/media/proxy/${mediaProxy.id}`;
      console.log(
        `[PaymentService] Generated final PDF proxy URL: ${finalPdfUrl}`,
      );

      await storage.savePdfUrl(chatExportId, finalPdfUrl);
      console.log(
        `[PaymentService] Successfully saved final PDF URL for chat export ${chatExportId}`,
      );

      // 8. Cleanup Local PDF File
      try {
        if (fs.existsSync(pdfResultPath)) {
          fs.unlinkSync(pdfResultPath);
          console.log(
            `[PaymentService] Cleaned up temporary local PDF: ${pdfResultPath}`,
          );
        }
      } catch (err) {
        console.error(
          `[PaymentService] Error cleaning up local PDF ${pdfResultPath}:`,
          err,
        );
        // Non-critical error, just log it.
      }
    } catch (error) {
      // Catch-all for errors during PDF generation/linking
      console.error(
        `[PaymentService] CRITICAL ERROR during final PDF generation/linking for paid bundle ${bundle.bundleId} (Chat ${chatExportId}):`,
        error,
      );
      // TODO: Implement robust error handling/alerting here. Payment is done, but PDF delivery failed.
    }
  }

  /**
   * Clean up expired unpaid bundles from the database.
   * @returns Number of bundles deleted.
   */
  async cleanupExpiredBundles(): Promise<number> {
    const now = new Date();
    try {
      const deletedBundles = await db
        .delete(paymentBundles)
        .where(
          and(
            isNull(paymentBundles.paidAt), // Bundle is not paid
            lt(paymentBundles.expiresAt, now), // Expiry date is in the past
          ),
        )
        .returning(); // Return the deleted records (or just count)

      if (deletedBundles.length > 0) {
        console.log(
          `[PaymentService] Cleaned up ${deletedBundles.length} expired unpaid payment bundles.`,
        );
      }
      return deletedBundles.length;
    } catch (error) {
      console.error(
        "[PaymentService] Error during cleanup of expired bundles:",
        error,
      );
      return 0; // Return 0 on error
    }
  }
}

// Create and export a singleton instance
export const paymentService = new PaymentService();
