import { db } from "./db";
import { mediaProxyFiles } from "@shared/schema";
import { sql } from "drizzle-orm";

async function migrateDatabase() {
  console.log("Starting database migration...");

  try {
    // Create tables if they don't exist
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "media_proxy_files" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "r2_key" TEXT NOT NULL,
        "r2_url" TEXT NOT NULL,
        "content_type" TEXT NOT NULL,
        "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        "last_accessed" TIMESTAMP DEFAULT NOW(),
        "expiry_date" TIMESTAMP
      );
    `);
    
    console.log("Created media_proxy_files table");
    
    // Create payment bundles table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "payment_bundles" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "bundle_id" TEXT NOT NULL UNIQUE,
        "chat_export_id" INTEGER,
        "r2_temp_key" TEXT,
        "r2_final_key" TEXT,
        "message_count" INTEGER,
        "media_size_bytes" INTEGER,
        "is_paid" BOOLEAN DEFAULT FALSE,
        "stripe_session_id" TEXT,
        "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
        "paid_at" TIMESTAMP,
        "expires_at" TIMESTAMP,
        "email_address" TEXT
      );
    `);
    
    console.log("Created payment_bundles table");
    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Error during migration:", error);
    process.exit(1);
  }
}

// In an ESM context, we can't use require.main === module
// Instead, we just export the function and call it from index.ts

export { migrateDatabase };