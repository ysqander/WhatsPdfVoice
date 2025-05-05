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
    
    // Check if bundle_id column exists in payment_bundles table, if not add it
    const result = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'payment_bundles' AND column_name = 'bundle_id';
    `);
    
    if (result.rowCount === 0) {
      console.log("Adding missing bundle_id column to payment_bundles table");
      await db.execute(sql`
        ALTER TABLE "payment_bundles" 
        ADD COLUMN "bundle_id" TEXT UNIQUE;
      `);
      
      // Update existing rows with a UUID
      await db.execute(sql`
        UPDATE "payment_bundles" 
        SET "bundle_id" = gen_random_uuid()::text 
        WHERE "bundle_id" IS NULL;
      `);
      
      // Make the column NOT NULL after populating it
      await db.execute(sql`
        ALTER TABLE "payment_bundles" 
        ALTER COLUMN "bundle_id" SET NOT NULL;
      `);
    }
    
    console.log("Created payment_bundles table");
    
    // Check if originalFileMediaId column exists, if not add it
    const columnResult = await db.execute(sql`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'payment_bundles' AND column_name = 'original_file_media_id';
    `);
    
    if (columnResult.rowCount === 0) {
      console.log("Adding original_file_media_id column to payment_bundles table");
      await db.execute(sql`
        ALTER TABLE "payment_bundles" 
        ADD COLUMN "original_file_media_id" TEXT;
      `);
    }
    
    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Error during migration:", error);
    process.exit(1);
  }
}

// In an ESM context, we can't use require.main === module
// Instead, we just export the function and call it from index.ts

export { migrateDatabase };