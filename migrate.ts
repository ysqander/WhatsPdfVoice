import { db } from "./server/db";
import * as schema from "./shared/schema";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { Pool, neonConfig } from "@neondatabase/serverless";
import ws from "ws";

// WebSocket constructor for Neon
neonConfig.webSocketConstructor = ws;

// This script will create all the tables in the database
async function main() {
  console.log("Running database migrations...");
  
  try {
    // Make sure we're connected to the database
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    
    // Create a connection pool
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const client = drizzle(pool, { schema });
    
    // Run migrations
    await migrate(client, { migrationsFolder: "migrations" });
    
    console.log("Migrations complete!");
    
    // Close the pool
    await pool.end();
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

main();