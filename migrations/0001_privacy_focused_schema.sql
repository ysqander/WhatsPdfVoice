-- Migration SQL to remove the chat and message tables and update the media_files table

-- First alter the media_files table to add expiresAt field and remove references
ALTER TABLE media_files 
    ADD COLUMN expires_at TIMESTAMP,
    DROP CONSTRAINT IF EXISTS media_files_chat_export_id_fkey,
    DROP CONSTRAINT IF EXISTS media_files_message_id_fkey;

-- Make the chat_export_id field nullable for transition period
ALTER TABLE media_files ALTER COLUMN chat_export_id DROP NOT NULL;

-- Create an index on expires_at to speed up cleanup queries
CREATE INDEX IF NOT EXISTS idx_media_files_expires_at ON media_files(expires_at);

-- Drop the messages and chat_exports tables
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS chat_exports;