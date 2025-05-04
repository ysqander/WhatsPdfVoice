import Stripe from 'stripe';
import { db } from '../db';
import { paymentBundles, insertPaymentBundleSchema, PaymentBundle } from '../../shared/schema';
import { eq, and, lt, isNull } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

// Ensure Stripe API key is available
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('STRIPE_SECRET_KEY environment variable is not set');
}

// Initialize Stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

export class PaymentService {
  /**
   * Create a payment bundle in the database
   * @param chatExportId The ID of the chat export
   * @param messageCount Number of messages in the chat
   * @param mediaSizeBytes Total size of media files in bytes
   * @returns Created payment bundle
   */
  async createPaymentBundle(
    chatExportId: number,
    messageCount: number,
    mediaSizeBytes: number
  ): Promise<PaymentBundle> {
    // Generate a unique bundle ID
    const bundleId = uuidv4();
    
    // Create the bundle record
    const bundle = await db.insert(paymentBundles)
      .values({
        bundleId,
        chatExportId,
        messageCount,
        mediaSizeBytes,
        paidAt: null,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours from now
        createdAt: new Date(),
      })
      .returning()
      .then(rows => rows[0]);
    
    return bundle;
  }

  /**
   * Get a payment bundle by its ID
   * @param bundleId The bundle ID
   * @returns Payment bundle or undefined if not found
   */
  async getPaymentBundle(bundleId: string): Promise<PaymentBundle | undefined> {
    const bundle = await db.select()
      .from(paymentBundles)
      .where(eq(paymentBundles.bundleId, bundleId))
      .then(rows => rows[0]);
    
    return bundle;
  }

  /**
   * Mark a payment bundle as paid
   * @param bundleId The bundle ID
   * @returns Updated payment bundle or undefined if not found
   */
  async markBundleAsPaid(bundleId: string): Promise<PaymentBundle | undefined> {
    const bundle = await db.update(paymentBundles)
      .set({
        paidAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
      })
      .where(eq(paymentBundles.bundleId, bundleId))
      .returning()
      .then(rows => rows[0]);
    
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
    cancelUrl: string
  ): Promise<string> {
    // Get the bundle details
    const bundle = await this.getPaymentBundle(bundleId);
    if (!bundle) {
      throw new Error(`Payment bundle with ID ${bundleId} not found`);
    }
    
    // Create a Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: 'WhatsApp Chat Export',
              description: `${bundle.messageCount} messages and ${(bundle.mediaSizeBytes / (1024 * 1024)).toFixed(1)} MB of media`,
            },
            unit_amount: 900, // $9.00 in cents
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: bundleId,
      metadata: {
        bundleId,
        chatExportId: bundle.chatExportId?.toString(),
      },
    });
    
    return session.url || '';
  }

  // We don't need the verifyWebhookSignature method anymore
  // as we're handling it directly in the routes

  /**
   * Handle a Stripe checkout.session.completed event
   * @param sessionId The Stripe checkout session ID
   * @returns Updated payment bundle or undefined if not found
   */
  async handleCheckoutSessionCompleted(sessionId: string): Promise<PaymentBundle | undefined> {
    try {
      // Retrieve the session
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      
      // Get the bundle ID from the session metadata
      const bundleId = session.metadata?.bundleId;
      if (!bundleId) {
        console.error('No bundleId found in session metadata', session);
        return undefined;
      }
      
      // Mark the bundle as paid
      return this.markBundleAsPaid(bundleId);
    } catch (error) {
      console.error('Error handling checkout session completed', error);
      return undefined;
    }
  }

  /**
   * Clean up expired unpaid bundles
   * @returns Number of bundles deleted
   */
  async cleanupExpiredBundles(): Promise<number> {
    const now = new Date();
    
    const deletedBundles = await db.delete(paymentBundles)
      .where(
        // Delete bundles that are expired and not paid
        and(
          isNull(paymentBundles.paidAt),
          lt(paymentBundles.expiresAt, now)
        )
      )
      .returning();
    
    return deletedBundles.length;
  }
}

// Create a singleton instance
export const paymentService = new PaymentService();