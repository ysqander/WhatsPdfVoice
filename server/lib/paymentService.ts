import Stripe from "stripe";
import { PaymentBundle, InsertPaymentBundle } from "@shared/schema";
import { db } from "../db";
import { paymentBundles } from "@shared/schema";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { uploadFileToR2, getSignedR2Url, deleteFileFromR2 } from "./r2Storage";
import { ChatExport } from "@shared/types";
import { addDays } from "date-fns";

// Initialize Stripe
if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set. Please add it to your environment variables.");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2023-10-16" as any,
});

// Price ID for the large bundle
const STRIPE_PRICE_ID = "whats-bundle-large"; 
const PRICE_AMOUNT = 900; // $9.00 in cents

/**
 * Payment service for handling Stripe payments
 */
export class PaymentService {

  /**
   * Create a temporary bundle in R2 and a payment intent
   * 
   * @param chatExport The chat export data
   * @param pdfPath Path to the PDF file
   * @param messageCount Number of messages in the chat
   * @param mediaSizeBytes Size of all media files in bytes
   * @param email Customer's email address for notifications
   * @returns The created payment bundle
   */
  async createPaymentBundle(
    chatExport: ChatExport,
    pdfPath: string,
    messageCount: number,
    mediaSizeBytes: number,
    email?: string
  ): Promise<PaymentBundle> {
    try {
      // Generate a unique ID for this bundle
      const bundleId = uuidv4();
      
      // Upload PDF to R2 temp storage
      const tempKey = `tmp/${bundleId}/bundle.pdf`;
      
      // Make sure the PDF exists
      if (!fs.existsSync(pdfPath)) {
        throw new Error(`PDF file not found at path: ${pdfPath}`);
      }
      
      // Upload to R2
      await uploadFileToR2(pdfPath, "application/pdf", tempKey);
      
      // Calculate the expiry date (24 hours from now)
      const expiresAt = addDays(new Date(), 1);
      
      // Create a payment bundle record
      const insertData: InsertPaymentBundle = {
        chatExportId: chatExport.id,
        r2TempKey: tempKey,
        r2FinalKey: `live/${bundleId}/bundle.pdf`, // This will be the final location after payment
        messageCount,
        mediaSizeBytes,
        stripeSessionId: "", // Will be set after creating Stripe session
        expiresAt,
        emailAddress: email
      };
      
      // Insert into database
      const [bundle] = await db
        .insert(paymentBundles)
        .values(insertData)
        .returning();
      
      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: "WhatsApp Chat Export Bundle",
                description: `${messageCount} messages, ${(mediaSizeBytes / (1024 * 1024)).toFixed(1)}MB of media`,
              },
              unit_amount: PRICE_AMOUNT,
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${this.getBaseUrl()}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${this.getBaseUrl()}/payment-cancelled`,
        metadata: {
          bundle_id: bundle.id
        },
        customer_email: email,
      });
      
      // Update the bundle with Stripe session ID
      await db
        .update(paymentBundles)
        .set({ stripeSessionId: session.id })
        .where(eq(paymentBundles.id, bundle.id));
      
      // Get updated bundle
      const [updatedBundle] = await db
        .select()
        .from(paymentBundles)
        .where(eq(paymentBundles.id, bundle.id));
      
      return updatedBundle;
    } catch (error) {
      console.error("Error creating payment bundle:", error);
      throw error;
    }
  }
  
  /**
   * Handle webhook event from Stripe
   * 
   * @param event The Stripe webhook event
   * @returns true if the event was handled successfully
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<boolean> {
    try {
      // Handle the event
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          
          // Get the bundle ID from metadata
          const bundleId = session.metadata?.bundle_id;
          if (!bundleId) {
            console.error("No bundle ID in session metadata");
            return false;
          }
          
          // Get the bundle
          const [bundle] = await db
            .select()
            .from(paymentBundles)
            .where(eq(paymentBundles.id, bundleId));
          
          if (!bundle) {
            console.error(`Bundle not found with ID: ${bundleId}`);
            return false;
          }
          
          // Move file from temp to final location
          await this.moveFileAfterPayment(bundle);
          
          // Update bundle as paid
          await db
            .update(paymentBundles)
            .set({ 
              isPaid: true,
              paidAt: new Date()
            })
            .where(eq(paymentBundles.id, bundleId));
          
          // Send email with download link (in a real implementation)
          // await this.sendDownloadEmail(bundle);
          
          return true;
        }
        
        default:
          console.log(`Unhandled event type: ${event.type}`);
          return true;
      }
    } catch (error) {
      console.error("Error handling webhook event:", error);
      return false;
    }
  }
  
  /**
   * Move file from temporary to final location after payment
   * 
   * @param bundle The payment bundle
   */
  private async moveFileAfterPayment(bundle: PaymentBundle): Promise<void> {
    try {
      // TODO: Implement file movement in R2
      // This would typically involve:
      // 1. Getting the temporary file
      // 2. Uploading it to the final location
      // 3. Deleting the temporary file
      
      console.log(`Moving file from ${bundle.r2TempKey} to ${bundle.r2FinalKey}`);
      
      // For now, let's just log it - actual implementation would depend on your R2 setup
    } catch (error) {
      console.error("Error moving file after payment:", error);
      throw error;
    }
  }
  
  /**
   * Get bundle by ID
   * 
   * @param bundleId The bundle ID
   * @returns The payment bundle or undefined if not found
   */
  async getBundleById(bundleId: string): Promise<PaymentBundle | undefined> {
    const [bundle] = await db
      .select()
      .from(paymentBundles)
      .where(eq(paymentBundles.id, bundleId));
    
    return bundle;
  }
  
  /**
   * Get bundle by Stripe session ID
   * 
   * @param sessionId The Stripe session ID
   * @returns The payment bundle or undefined if not found
   */
  async getBundleBySessionId(sessionId: string): Promise<PaymentBundle | undefined> {
    const [bundle] = await db
      .select()
      .from(paymentBundles)
      .where(eq(paymentBundles.stripeSessionId, sessionId));
    
    return bundle;
  }
  
  /**
   * Get a signed URL for a bundle
   * 
   * @param bundle The payment bundle
   * @returns Signed URL for the bundle PDF
   */
  async getSignedBundleUrl(bundle: PaymentBundle): Promise<string> {
    // Use the correct key based on payment status
    const key = bundle.isPaid ? bundle.r2FinalKey : bundle.r2TempKey;
    
    // Get signed URL
    return await getSignedR2Url(key);
  }
  
  /**
   * Get the base URL for the application
   */
  private getBaseUrl(): string {
    return process.env.REPLIT_DOMAINS
      ? `https://${process.env.REPLIT_DOMAINS}`
      : "http://localhost:5000";
  }
  
  /**
   * Clean up expired temporary bundles
   * 
   * @returns Number of bundles cleaned up
   */
  async cleanupExpiredBundles(): Promise<number> {
    try {
      // Get all expired, unpaid bundles
      const now = new Date();
      const expiredBundles = await db
        .select()
        .from(paymentBundles)
        .where(
          eq(paymentBundles.isPaid, false)
        );
      
      let cleanedCount = 0;
      
      // Process each bundle
      for (const bundle of expiredBundles) {
        if (bundle.expiresAt && bundle.expiresAt < now) {
          // Delete from R2
          try {
            await deleteFileFromR2(bundle.r2TempKey);
          } catch (error) {
            console.error(`Error deleting expired file: ${bundle.r2TempKey}`, error);
          }
          
          // Delete from database
          await db
            .delete(paymentBundles)
            .where(eq(paymentBundles.id, bundle.id));
          
          cleanedCount++;
        }
      }
      
      return cleanedCount;
    } catch (error) {
      console.error("Error cleaning up expired bundles:", error);
      return 0;
    }
  }
}

// Export a singleton instance
export const paymentService = new PaymentService();