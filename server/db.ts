import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from "ws";
import * as schema from "@shared/schema";

// Configure Neon with WebSocket support
neonConfig.webSocketConstructor = ws;

// Modify the database URL to disable SSL
// This avoids the need for subtls but still allows secure connection via WebSocket TLS
let dbUrl = process.env.DATABASE_URL || "";
if (dbUrl.includes("sslmode=require")) {
  dbUrl = dbUrl.replace("sslmode=require", "sslmode=disable");
}

// Force disable PG SSL (we're using WebSocket TLS instead)
neonConfig.forceDisablePgSSL = true;

if (!dbUrl) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

// Create pool with better connection handling
export const pool = new Pool({ 
  connectionString: dbUrl,
  max: 3 // Reduce connection limit to avoid hitting serverless limits
});

// Catch unhandled rejections to prevent app crashes
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection in db connection:', err);
});

export const db = drizzle(pool, { schema });