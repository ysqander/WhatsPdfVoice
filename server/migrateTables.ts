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
    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Error during migration:", error);
    process.exit(1);
  }
}

// In an ESM context, we can't use require.main === module
// Instead, we just export the function and call it from index.ts

export { migrateDatabase };