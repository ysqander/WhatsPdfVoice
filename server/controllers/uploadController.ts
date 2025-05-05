import { Request, Response } from 'express'
import { storage } from '../storage'
import { mediaProxyStorage } from '../mediaProxyStorage'
import { MediaFile, Message as SchemaMessage } from '@shared/schema' // Ensure Message type is imported if needed elsewhere
import { parse } from '../lib/parser'
import { generatePdf } from '../lib/pdf'
import {
  ProcessingOptions,
  ProcessingStep,
  FREE_TIER_MESSAGE_LIMIT,
  FREE_TIER_MEDIA_SIZE_LIMIT,
} from '@shared/types'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import archiver from 'archiver'
import os from 'os'
import { format } from 'date-fns'
import { testR2Connection, getSignedR2Url } from '../lib/r2Storage' // getSignedR2Url might not be needed directly here anymore
import { paymentService } from '../lib/paymentService'
import { isPaymentRequired } from '../lib/paymentHelper' // Removed unused calculateMediaSize, handlePaymentCheck
import { db } from '../db'
import { eq } from 'drizzle-orm'
import { getAppBaseUrl } from '../lib/appBaseUrl'

// Map to store client connections for SSE
const clients = new Map<string, Response>()

/**
 * Helper to find a media file path in various locations
 * @param filename Media filename
 * @param extractDir Extract directory
 * @returns Path to the media file if found
 */
export function findMediaPath(
  filename: string,
  extractDir: string
): string | undefined {
  // First, try direct path in media directory (where parser saves)
  const mediaDir = path.join(os.tmpdir(), 'whatspdf', 'media')
  const directPath = path.join(mediaDir, filename)
  if (fs.existsSync(directPath)) {
    return directPath
  }

  // Next, try finding it within the extract directory recursively
  if (extractDir && fs.existsSync(extractDir)) {
    const searchRecursive = (dir: string): string | undefined => {
      try {
        const items = fs.readdirSync(dir)
        for (const item of items) {
          const fullPath = path.join(dir, item)
          try {
            const stats = fs.statSync(fullPath)
            if (stats.isDirectory()) {
              const result = searchRecursive(fullPath)
              if (result) return result
            } else if (
              item === filename ||
              item.endsWith(filename) ||
              // Case for files that might have slight name variations but correct base name
              item.includes(path.basename(filename, path.extname(filename)))
            ) {
              // Basic check to avoid matching unrelated files
              if (
                path.extname(item) === path.extname(filename) ||
                filename.includes('(file attached)')
              ) {
                return fullPath
              }
            }
          } catch (statErr) {
            // Ignore files we can't stat (e.g., permissions issues)
          }
        }
      } catch (readDirErr) {
        // Ignore directories we can't read
      }
      return undefined
    }
    return searchRecursive(extractDir)
  }

  return undefined
}

// Calculate file hash
const calculateFileHash = (filePath: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)

    stream.on('error', (err) => reject(err))
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

export const uploadController = {
  // Process uploaded WhatsApp chat export ZIP file
  processFile: async (req: Request, res: Response) => {
    try {
      console.log('Upload request received:', {
        headers: req.headers,
        contentType: req.headers['content-type'],
        file: req.file
          ? {
              originalname: req.file.originalname,
              size: req.file.size,
            }
          : null,
        body: req.body,
      })

      if (!req.file) {
        console.error('No file in request:', {
          body: req.body,
          isMultipart: req.headers['content-type']?.includes(
            'multipart/form-data'
          ),
        })
        return res.status(400).json({ message: 'No file uploaded' })
      }

      console.log('File details:', {
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        size: req.file.size,
        path: req.file.path,
      })

      // Generate client ID for tracking processing status
      const clientId = uuidv4()

      // Parse processing options
      const optionsStr = req.body.options || '{}'
      const options: ProcessingOptions = JSON.parse(optionsStr)

      // Wait for client connection before starting processing
      const waitForClient = new Promise<void>((resolve) => {
        const checkClient = setInterval(() => {
          if (clients.get(clientId)) {
            clearInterval(checkClient)
            resolve()
          }
        }, 100)

        // Timeout after 5 seconds
        setTimeout(() => {
          clearInterval(checkClient)
          // Resolve anyway, background process will check later
          resolve()
        }, 5000)
      })

      // Start processing in background
      process.nextTick(async () => {
        const processingStartTime = Date.now()
        // Use appBaseUrl for all absolute URL generation
        const appBaseUrl = getAppBaseUrl()

        let extractDir = '' // Define extractDir here to be accessible in catch/finally

        try {
          console.log(`Waiting for SSE connection for clientId: ${clientId}`)
          await waitForClient
          console.log(
            `Starting background processing for clientId: ${clientId}`
          )

          const client = clients.get(clientId)
          if (!client) {
            console.error(
              `No client found for clientId: ${clientId} after waiting. Aborting processing.`
            )
            // Cleanup uploaded file if it exists
            if (req.file && fs.existsSync(req.file.path)) {
              try {
                fs.unlinkSync(req.file.path)
              } catch (e) {
                console.error('Error cleaning up file on client disconnect:', e)
              }
            }
            return
          }

          // Update progress: extraction starting
          storage.saveProcessingProgress(
            clientId,
            5,
            ProcessingStep.EXTRACT_ZIP
          )
          client.write(
            `data: ${JSON.stringify({
              progress: 5,
              step: ProcessingStep.EXTRACT_ZIP,
            })}\n\n`
          )

          // Calculate file hash for verification
          const fileHash = await calculateFileHash(req.file!.path)

          // Parse the ZIP file and extract messages
          storage.saveProcessingProgress(
            clientId,
            20,
            ProcessingStep.EXTRACT_ZIP
          )
          client.write(
            `data: ${JSON.stringify({
              progress: 20,
              step: ProcessingStep.EXTRACT_ZIP,
            })}\n\n`
          )

          // Parse chat messages
          storage.saveProcessingProgress(
            clientId,
            30,
            ProcessingStep.PARSE_MESSAGES
          )
          client.write(
            `data: ${JSON.stringify({
              progress: 30,
              step: ProcessingStep.PARSE_MESSAGES,
            })}\n\n`
          )

          console.log(`Starting parse for file: ${req.file!.path}`)
          // Extract the ZIP file to a temporary directory (path defined in parser.ts)
          // We need the extractDir path for findMediaPath later
          extractDir = path.join(
            os.tmpdir(),
            'whatspdf-temp',
            path.basename(req.file!.path, '.zip') +
              '-' +
              uuidv4().substring(0, 8)
          ) // Get dir from parser concept

          const chatData = await parse(req.file!.path, options).catch(
            (error) => {
              console.error('Error parsing file:', error)
              throw new Error(`Failed to parse file: ${error.message}`)
            }
          )
          console.log(
            `Parse completed successfully. Found ${chatData.messages.length} messages.`
          )
          chatData.fileHash = fileHash
          chatData.originalFilename = req.file!.originalname
          chatData.processingOptions = options

          // Analyze chat size to determine if payment is required
          console.log(
            `Analyzing chat size. Messages: ${chatData.messages.length}`
          )

          // Get total size of media files by checking the actual files copied by the parser
          let totalMediaSize = 0
          const parsedMediaMessages = chatData.messages.filter(
            (msg) =>
              msg.type === 'voice' ||
              msg.type === 'image' ||
              msg.type === 'attachment'
          )

          for (const message of parsedMediaMessages) {
            try {
              if (!message.mediaUrl) continue
              // mediaUrl from parser should be like /media/filename.ext
              const filename = path.basename(message.mediaUrl)
              // The parser copies files to os.tmpdir()/whatspdf/media
              const mediaPath = path.join(
                os.tmpdir(),
                'whatspdf',
                'media',
                filename
              )
              if (fs.existsSync(mediaPath)) {
                const stats = fs.statSync(mediaPath)
                totalMediaSize += stats.size
              } else {
                console.warn(
                  `Media file from parser not found for size check: ${mediaPath}`
                )
              }
            } catch (error) {
              console.error(
                `Error checking media file size for ${message.mediaUrl}: ${error}`
              )
            }
          }

          console.log(
            `Total media size calculated: ${totalMediaSize} bytes (${(
              totalMediaSize /
              (1024 * 1024)
            ).toFixed(2)}MB)`
          )

          // Check if payment is required using the payment helper
          const requiresPayment = isPaymentRequired(
            chatData.messages.length,
            totalMediaSize
          )

          // --- PAYMENT REQUIRED PATH ---
          if (requiresPayment) {
            console.log(`Chat exceeds free tier limits. Payment required.`)

            // Save chat export to storage first to get its ID
            const savedChatExport = await storage.saveChatExport(chatData)
            chatData.id = savedChatExport.id // Update chatData with the assigned ID

            // Save messages associated with the chat export ID
            // Important: Need to save messages first to get their IDs for media linking
            const savedMessages: SchemaMessage[] = []
            for (const message of chatData.messages) {
              try {
                const timestamp =
                  typeof message.timestamp === 'string'
                    ? new Date(message.timestamp)
                    : message.timestamp

                const savedMsg = await storage.saveMessage({
                  chatExportId: savedChatExport.id!,
                  timestamp: timestamp,
                  sender: message.sender,
                  content: message.content, // This might be the local /media/ path initially
                  type: message.type,
                  mediaUrl: message.mediaUrl, // Keep local path for now
                  duration: message.duration,
                })
                savedMessages.push(savedMsg)
              } catch (err) {
                console.error(
                  `Error saving message during payment check: ${err}`
                )
                // Decide if we should continue or throw? For now, log and continue.
              }
            }
            console.log(
              `Saved ${savedMessages.length} messages to DB before media upload (Payment Path).`
            )
            // Update chatData messages with saved ones that have IDs
            chatData.messages = savedMessages.map((msg) => ({
              ...msg,
              timestamp:
                typeof msg.timestamp === 'object' &&
                msg.timestamp instanceof Date
                  ? msg.timestamp.toISOString()
                  : String(msg.timestamp),
              type: msg.type as 'text' | 'voice' | 'image' | 'attachment',
            }))

            try {
              // Store a copy of the original chat zip file to R2 for potential future reprocessing needs (e.g., support)
              console.log(
                `Saving original chat zip file to R2: ${req.file!.path}`
              )
              const zipMediaFile = await storage.uploadMediaToR2(
                req.file!.path,
                'application/zip',
                savedChatExport.id!,
                undefined, // Not linked to a specific message
                'attachment', // Use 'attachment' type for the zip
                `original_${path.basename(req.file!.originalname)}`, // Original name for clarity
                `ORIGINAL_ZIP_${savedChatExport.id}` // File hash marker
              )
              console.log(
                `Uploaded original zip file to R2: key=${zipMediaFile.key}, id=${zipMediaFile.id}`
              )

              // Create a payment bundle referencing the original zip file's media ID
              const bundle = await paymentService.createPaymentBundle(
                savedChatExport.id!,
                chatData.messages.length,
                totalMediaSize,
                zipMediaFile.id // Reference to the original zip in R2
              )
              console.log('Created payment bundle:', {
                bundleId: bundle.bundleId,
                originalFileMediaId: zipMediaFile.id,
              })

              // Process media files: Upload to R2 and update message records with PROXY URLs
              console.log(
                'R2 connection test successful, proceeding with media uploads (Payment Path)'
              )

              const messagesToProcessMedia = chatData.messages.filter(
                (msg) =>
                  msg.id &&
                  (msg.type === 'voice' ||
                    msg.type === 'image' ||
                    msg.type === 'attachment') &&
                  msg.mediaUrl &&
                  !msg.mediaUrl.startsWith('http')
              )
              console.log(
                `Found ${messagesToProcessMedia.length} messages with local media URLs to upload.`
              )

              for (const message of messagesToProcessMedia) {
                // mediaUrl from parser should be like /media/filename.ext
                const localFilename = path.basename(message.mediaUrl!)
                // The actual file path where parser copied it
                const localMediaPath = path.join(
                  os.tmpdir(),
                  'whatspdf',
                  'media',
                  localFilename
                )

                // Double check the extracted path if the primary isn't found
                const sourceMediaPath = fs.existsSync(localMediaPath)
                  ? localMediaPath
                  : findMediaPath(localFilename, extractDir)

                if (sourceMediaPath && message.id) {
                  // Ensure message ID and path exist
                  let contentType = 'application/octet-stream'
                  let mediaType: MediaFile['type'] = 'attachment'

                  if (message.type === 'voice') {
                    contentType = 'audio/ogg'
                    mediaType = 'voice'
                  } else if (message.type === 'image') {
                    mediaType = 'image'
                    const ext = path.extname(sourceMediaPath).toLowerCase()
                    if (ext === '.jpg' || ext === '.jpeg')
                      contentType = 'image/jpeg'
                    else if (ext === '.png') contentType = 'image/png'
                    else if (ext === '.gif') contentType = 'image/gif'
                    else if (ext === '.webp') contentType = 'image/webp'
                    // Add more image types if needed
                  } else if (message.type === 'attachment') {
                    mediaType = 'attachment'
                    const ext = path.extname(sourceMediaPath).toLowerCase()
                    if (ext === '.pdf') contentType = 'application/pdf'
                    // Add more document types if needed
                  }

                  try {
                    console.log(
                      `Uploading ${message.type} to R2: ${sourceMediaPath}`
                    )
                    const mediaFile = await storage.uploadMediaToR2(
                      sourceMediaPath,
                      contentType,
                      savedChatExport.id!,
                      message.id,
                      mediaType,
                      localFilename // Pass original name
                      // Add file hash calculation if needed for media files too
                    )

                    // Construct the proxy URL
                    const proxyUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`

                    // Update the message in the database with the PROXY URL
                    await storage.updateMessageProxyUrl(message.id, proxyUrl)
                    console.log(
                      `Updated message ${message.id} with proxy URL: ${proxyUrl}`
                    )
                  } catch (uploadError) {
                    console.error(
                      `Error uploading/updating media for message ${message.id}:`,
                      uploadError
                    )
                    // Decide how to handle: skip message? set URL to error indicator?
                  }
                } else {
                  console.warn(
                    `Media file path not found for message ${message.id}, local URL: ${message.mediaUrl}. Searched: ${localMediaPath} and in ${extractDir}`
                  )
                }
              }

              // Fetch the final state of messages to send to client
              const finalMessages = await storage.getMessagesByChatExportId(
                savedChatExport.id!
              )
              console.log(
                `Retrieved ${finalMessages.length} messages after processing media (Payment Path).`
              )
              // @ts-ignore - Normalize timestamp for client
              chatData.messages = finalMessages.map((msg) => ({
                ...msg,
                timestamp:
                  typeof msg.timestamp === 'object' &&
                  msg.timestamp instanceof Date
                    ? msg.timestamp.toISOString()
                    : String(msg.timestamp),
                type: msg.type as 'text' | 'voice' | 'image' | 'attachment',
              }))

              console.log(
                'Skipping PDF generation until after payment is completed.'
              )

              // Update progress to payment required state
              storage.saveProcessingProgress(
                clientId,
                40,
                ProcessingStep.PAYMENT_REQUIRED
              )
              client.write(
                `data: ${JSON.stringify({
                  progress: 40,
                  step: ProcessingStep.PAYMENT_REQUIRED,
                  messageCount: chatData.messages.length, // Use actual count
                  mediaSizeBytes: totalMediaSize, // Use calculated size
                  requiresPayment: true,
                  bundleId: bundle.bundleId,
                  checkoutUrl: null, // Will be generated by the client
                })}\n\n`
              )

              // Send final message indicating payment required state
              client.write(
                `data: ${JSON.stringify({
                  progress: 40, // Keep progress at payment step
                  step: ProcessingStep.PAYMENT_REQUIRED,
                  requiresPayment: true,
                  done: true, // Indicate processing is done *for now*
                  bundleId: bundle.bundleId,
                  messageCount: chatData.messages.length,
                  mediaSizeBytes: totalMediaSize,
                  chatExportId: savedChatExport.id,
                  chatData: chatData, // Send the latest chatData including messages with proxy URLs
                })}\n\n`
              )

              // End the connection gracefully
              client.end()
              clients.delete(clientId)
              console.log(
                `Payment required flow completed for client ${clientId}. Connection closed.`
              )
              return // Stop processing here
            } catch (error) {
              console.error(
                'Error during payment required flow (bundle creation or media upload):',
                error
              )
              // If payment setup fails, we might fall through to free tier logic,
              // or send an error back to the client. Let's send an error.
              throw new Error(
                `Failed during payment setup: ${
                  error instanceof Error ? error.message : error
                }`
              )
            }
          }

          // --- FREE TIER / NO PAYMENT PATH ---
          console.log('Processing as free tier or payment failed/not required.')
          // Save/update chat export (might have been saved already if payment failed after save)
          const savedChatExport = chatData.id
            ? (await storage.getChatExport(chatData.id)) ??
              (await storage.saveChatExport(chatData))
            : await storage.saveChatExport(chatData)
          chatData.id = savedChatExport.id // Ensure ID is set

          // Save/Update messages (ensure they have IDs)
          const finalSavedMessages: SchemaMessage[] = []
          for (const message of chatData.messages) {
            try {
              const timestamp =
                typeof message.timestamp === 'string'
                  ? new Date(message.timestamp)
                  : message.timestamp

              // If message already has an ID (from payment path save attempt), update it. Otherwise, insert.
              if (message.id) {
                // Update logic might be needed in storage interface if properties changed
                finalSavedMessages.push(message as SchemaMessage) // Assume it's good for now
              } else {
                const savedMsg = await storage.saveMessage({
                  chatExportId: savedChatExport.id!,
                  timestamp: timestamp,
                  sender: message.sender,
                  content: message.content,
                  type: message.type,
                  mediaUrl: message.mediaUrl,
                  duration: message.duration,
                })
                finalSavedMessages.push(savedMsg)
              }
            } catch (err) {
              console.error(`Error saving message (Free Tier Path): ${err}`)
            }
          }
          chatData.messages = finalSavedMessages.map((msg) => ({
            ...msg,
            timestamp:
              typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
                ? msg.timestamp.toISOString()
                : String(msg.timestamp),
            type: msg.type as 'text' | 'voice' | 'image' | 'attachment',
          }))
          console.log(
            `Ensured ${chatData.messages.length} messages are saved (Free Tier Path).`
          )

          // Process and upload media files to R2
          storage.saveProcessingProgress(
            clientId,
            60,
            ProcessingStep.CONVERT_VOICE
          ) // Step name might be misleading now
          client.write(
            `data: ${JSON.stringify({
              progress: 60,
              step: ProcessingStep.CONVERT_VOICE,
            })}\n\n`
          ) // Keep step for consistency

          const r2Connected = await testR2Connection().catch((err) => {
            console.error('Error connecting to R2:', err)
            return false
          })

          if (!r2Connected) {
            console.warn(
              'R2 connection failed. Media files will have local paths or be unavailable.'
            )
            // PDF will be generated with local URLs if they exist
          } else {
            console.log(
              'R2 connection successful, proceeding with media uploads (Free Tier Path)'
            )
            const messagesToProcessMedia = chatData.messages.filter(
              (msg) =>
                msg.id &&
                (msg.type === 'voice' ||
                  msg.type === 'image' ||
                  msg.type === 'attachment') &&
                msg.mediaUrl &&
                !msg.mediaUrl.startsWith('http')
            )
            console.log(
              `Found ${messagesToProcessMedia.length} messages with local media URLs to upload (Free Tier).`
            )

            for (const message of messagesToProcessMedia) {
              const localFilename = path.basename(message.mediaUrl!)
              const localMediaPath = path.join(
                os.tmpdir(),
                'whatspdf',
                'media',
                localFilename
              )
              const sourceMediaPath = fs.existsSync(localMediaPath)
                ? localMediaPath
                : findMediaPath(localFilename, extractDir)

              if (sourceMediaPath && message.id) {
                let contentType = 'application/octet-stream'
                let mediaType: MediaFile['type'] = 'attachment'

                if (message.type === 'voice') {
                  contentType = 'audio/ogg'
                  mediaType = 'voice'
                } else if (message.type === 'image') {
                  mediaType = 'image'
                  const ext = path.extname(sourceMediaPath).toLowerCase()
                  if (ext === '.jpg' || ext === '.jpeg')
                    contentType = 'image/jpeg'
                  else if (ext === '.png') contentType = 'image/png'
                  // Add more types
                } else if (message.type === 'attachment') {
                  mediaType = 'attachment'
                  const ext = path.extname(sourceMediaPath).toLowerCase()
                  if (ext === '.pdf') contentType = 'application/pdf'
                  // Add more types
                }

                try {
                  console.log(
                    `Uploading ${message.type} to R2: ${sourceMediaPath}`
                  )
                  const mediaFile = await storage.uploadMediaToR2(
                    sourceMediaPath,
                    contentType,
                    savedChatExport.id!,
                    message.id,
                    mediaType,
                    localFilename
                    // Add hash if needed
                  )

                  const proxyUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`
                  await storage.updateMessageProxyUrl(message.id, proxyUrl)
                  console.log(
                    `Updated message ${message.id} with proxy URL: ${proxyUrl} (Free Tier)`
                  )
                } catch (uploadError) {
                  console.error(
                    `Error uploading/updating media for message ${message.id} (Free Tier):`,
                    uploadError
                  )
                }
              } else {
                console.warn(
                  `Media file path not found for message ${message.id} (Free Tier), local URL: ${message.mediaUrl}. Searched: ${localMediaPath} and in ${extractDir}`
                )
              }
            }
          }

          // Update chatData with final message URLs before generating PDF
          const finalMessages = await storage.getMessagesByChatExportId(
            savedChatExport.id!
          )
          console.log(
            `Retrieved ${finalMessages.length} final messages for PDF generation (Free Tier).`
          )
          // @ts-ignore - Normalize timestamp for PDF generation
          chatData.messages = finalMessages.map((msg) => ({
            ...msg,
            timestamp:
              typeof msg.timestamp === 'object' && msg.timestamp instanceof Date
                ? msg.timestamp.toISOString()
                : String(msg.timestamp),
            type: msg.type as 'text' | 'voice' | 'image' | 'attachment',
          }))

          // Generate PDF
          console.log(
            'Starting PDF generation for chat export:',
            savedChatExport.id
          )
          storage.saveProcessingProgress(
            clientId,
            80,
            ProcessingStep.GENERATE_PDF
          )
          client.write(
            `data: ${JSON.stringify({
              progress: 80,
              step: ProcessingStep.GENERATE_PDF,
            })}\n\n`
          )

          const pdfResultPath = await generatePdf(chatData) // Use chatData with potentially updated proxy URLs
          console.log('PDF generation completed:', pdfResultPath)

          // Upload generated PDF to R2
          let finalPdfUrl = ''
          if (r2Connected) {
            try {
              console.log(`Uploading final generated PDF: ${pdfResultPath}`)
              const pdfMediaFile = await storage.uploadMediaToR2(
                pdfResultPath,
                'application/pdf',
                savedChatExport.id!,
                undefined, // Not linked to a message
                'pdf', // Type is 'pdf'
                'MAIN_GENERATED_PDF', // Special originalName marker
                'MAIN_PDF_' + savedChatExport.id // Special fileHash marker
              )
              console.log(
                'Uploaded main PDF file with special metadata markers:',
                pdfMediaFile.id
              )
              // Create a media proxy record to ensure the proxy endpoint works
              const mediaProxy = await mediaProxyStorage.createMediaProxy(
                pdfMediaFile.key,
                pdfMediaFile.url || '',
                'application/pdf'
              )
              console.log('Created media proxy record for PDF:', mediaProxy.id)

              // Use the proxy URL with the proxy ID, not the media file ID
              finalPdfUrl = `${appBaseUrl}/api/media/proxy/${mediaProxy.id}`
              console.log('Generated proxy URL for final PDF:', finalPdfUrl)
            } catch (error) {
              console.error('Error uploading final PDF to R2:', error)
              // Fallback to local PDF URL if upload fails
              finalPdfUrl = `/api/whatsapp/pdf/${path.basename(pdfResultPath)}`
              console.log('Using local PDF URL as fallback:', finalPdfUrl)
            }
          } else {
            // Use local PDF URL if R2 is not connected
            finalPdfUrl = `/api/whatsapp/pdf/${path.basename(pdfResultPath)}`
            console.log('Using local PDF URL (R2 not connected):', finalPdfUrl)
          }

          await storage.savePdfUrl(savedChatExport.id!, finalPdfUrl)
          console.log(
            `Final PDF URL (${finalPdfUrl}) saved to storage for chat export: ${savedChatExport.id}`
          )

          // Update progress: done
          storage.saveProcessingProgress(clientId, 100)

          // Notify connected client
          client.write(
            `data: ${JSON.stringify({
              progress: 100,
              done: true,
              pdfUrl: finalPdfUrl,
              chatData: {
                // Send final chat data including messages with correct URLs
                ...savedChatExport,
                messages: chatData.messages, // Ensure messages are included
              },
            })}\n\n`
          )
          client.end()
          clients.delete(clientId)
          console.log(
            `Processing finished successfully for client ${clientId}. Connection closed.`
          )
        } catch (error) {
          console.error('Error during background processing:', error)
          const clientRes = clients.get(clientId)
          if (clientRes) {
            try {
              clientRes.write(
                `data: ${JSON.stringify({
                  error: `Processing failed: ${
                    error instanceof Error ? error.message : 'Unknown error'
                  }`,
                })}\n\n`
              )
              clientRes.end()
            } catch (sseError) {
              console.error('Error sending error message via SSE:', sseError)
            }
            clients.delete(clientId)
          }
        } finally {
          console.log(
            `Background processing finished for ${clientId}. Elapsed time: ${
              Date.now() - processingStartTime
            }ms`
          )
          // Final cleanup of uploaded file and extracted directory
          if (req.file && fs.existsSync(req.file.path)) {
            try {
              fs.unlinkSync(req.file.path)
              console.log('Cleaned up uploaded file:', req.file.path)
            } catch (e) {
              console.error('Error cleaning up uploaded file:', e)
            }
          }
          if (extractDir && fs.existsSync(extractDir)) {
            try {
              fs.rmSync(extractDir, {
                recursive: true,
                force: true,
              })
              console.log('Cleaned up extraction directory:', extractDir)
            } catch (e) {
              console.error('Error cleaning up extraction directory:', e)
            }
          }
          // Also clean up the media dir created by parser? Maybe not, could be shared.
          // const mediaParserDir = path.join(os.tmpdir(), 'whatspdf', 'media');
          // if (fs.existsSync(mediaParserDir)) {
          //    try { fs.rmSync(mediaParserDir, { recursive: true, force: true }); console.log("Cleaned up parser media directory"); }
          //    catch(e) { console.error("Error cleaning up parser media directory:", e)}
          // }
        }
      })

      // Return client ID immediately for status tracking
      return res.status(200).json({ clientId })
    } catch (error) {
      console.error('Initial upload request error:', error)
      return res.status(500).json({
        message:
          error instanceof Error
            ? error.message
            : 'An unknown error occurred during upload setup.',
      })
    }
  },

  // Get processing status via Server-Sent Events
  getProcessStatus: (req: Request, res: Response) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    // Optional: Add CORS headers if client is on a different origin
    // res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders()

    // Get client ID from query
    const clientId = req.query.clientId as string
    if (!clientId) {
      console.error('SSE connection attempt without clientId')
      res.status(400).end() // Bad request
      return
    }

    console.log(`SSE connection established for clientId: ${clientId}`)

    // Store client connection
    clients.set(clientId, res)

    // Send initial progress
    const initialProgress = storage.getProcessingProgress(clientId)
    res.write(`data: ${JSON.stringify(initialProgress)}\n\n`)

    // Setup interval to send periodic updates (e.g., keepalive or check for stale progress)
    // This might not be strictly necessary if progress updates are pushed reliably
    // const intervalId = setInterval(() => {
    //   if (clients.has(clientId)) {
    //     const progress = storage.getProcessingProgress(clientId);
    //     res.write(`data: ${JSON.stringify(progress)}\n\n`); // Send current state periodically
    //   } else {
    //     clearInterval(intervalId);
    //   }
    // }, 5000); // Send update every 5 seconds

    // Handle client disconnect
    req.on('close', () => {
      console.log(`SSE connection closed for clientId: ${clientId}`)
      clients.delete(clientId)
      // clearInterval(intervalId); // Clear interval if using one
    })

    // Send a simple connected message immediately
    res.write(`data: ${JSON.stringify({ message: 'Connected' })}\n\n`)
  },

  // Download PDF - This now relies on the PDF URL being a proxy URL or local path
  downloadPdf: async (req: Request, res: Response) => {
    try {
      // Get chat ID from request, e.g., query param ?chatId=...
      const chatIdStr = req.query.chatId as string
      if (!chatIdStr) {
        return res.status(400).json({ message: 'Chat ID is required' })
      }
      const chatId = parseInt(chatIdStr, 10)
      if (isNaN(chatId)) {
        return res.status(400).json({ message: 'Invalid chat ID format' })
      }

      console.log(`Download PDF request for chat ID: ${chatId}`)

      // Get the specific chat export
      const chatExport = await storage.getChatExport(chatId)

      if (!chatExport) {
        console.error(`Chat export not found for ID: ${chatId}`)
        return res.status(404).json({ message: 'Chat export not found' })
      }

      if (!chatExport.pdfUrl) {
        console.error(
          `No PDF URL found for chat export ID: ${chatId}. Attempting to find in media.`
        )
        // Attempt to find the PDF in media files if URL is missing (maybe it wasn't saved correctly)
        const mediaFiles = await storage.getMediaFilesByChat(chatId)
        const pdfFile = mediaFiles.find(
          (file) =>
            file.type === 'pdf' &&
            (file.originalName === 'MAIN_GENERATED_PDF' ||
              (file.fileHash && file.fileHash.startsWith('MAIN_PDF_')))
        )

        if (pdfFile) {
          console.log(
            `Found main PDF in media files (ID: ${pdfFile.id}). Generating URL.`
          )
          // Assuming the URL stored in mediaFiles might be outdated, use the proxy structure
          const appBaseUrl = getAppBaseUrl()
          chatExport.pdfUrl = `${appBaseUrl}/api/media/proxy/${pdfFile.id}`
          // Optionally save this recovered URL back to the chatExport record
          await storage.savePdfUrl(chatId, chatExport.pdfUrl)
        } else {
          console.error(
            `Still no PDF found for chat export ID: ${chatId} after media search.`
          )
          return res.status(404).json({
            message: 'PDF not generated or linked for this chat',
          })
        }
      }

      console.log(`Attempting to serve PDF from URL: ${chatExport.pdfUrl}`)

      // Handle different storage locations based on URL format
      if (chatExport.pdfUrl.startsWith('/api/media/proxy/')) {
        // It's a proxy URL, redirect to it. The proxy handler will fetch from R2.
        console.log(`Redirecting to PDF proxy URL: ${chatExport.pdfUrl}`)
        return res.redirect(chatExport.pdfUrl)
      } else if (chatExport.pdfUrl.startsWith('/api/whatsapp/pdf/')) {
        // It's a local file path URL
        const pdfFileName = path.basename(chatExport.pdfUrl)
        const pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', pdfFileName)

        if (!fs.existsSync(pdfPath)) {
          console.error(`Local PDF file not found at: ${pdfPath}`)
          return res.status(404).json({
            message: 'PDF file not found in local storage',
          })
        }

        console.log(`Serving local PDF file: ${pdfPath}`)
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader(
          'Content-Disposition',
          `inline; filename="WhatsApp_Chat_${format(
            new Date(),
            'yyyyMMdd'
          )}.pdf"`
        )
        return res.sendFile(pdfPath)
      } else if (chatExport.pdfUrl.startsWith('http')) {
        // It's likely a direct R2 URL (older system? or fallback?) - redirect
        console.warn(
          `PDF URL is a direct external link (${chatExport.pdfUrl}). Redirecting.`
        )
        return res.redirect(chatExport.pdfUrl)
      } else {
        console.error(`Unrecognized PDF URL format: ${chatExport.pdfUrl}`)
        return res
          .status(500)
          .json({ message: 'Invalid PDF URL format stored.' })
      }
    } catch (error) {
      console.error('Error during PDF download/serving:', error)
      return res.status(500).json({
        message:
          error instanceof Error
            ? error.message
            : 'An unknown error occurred while retrieving the PDF.',
      })
    }
  },

  // Download Evidence ZIP (PDF + all referenced media files)
  // This logic seems okay, but ensure mediaFiles have up-to-date URLs if fetched directly
  downloadEvidenceZip: async (req: Request, res: Response) => {
    try {
      // Get the chat export by ID
      const chatId = parseInt(req.params.chatId, 10)
      if (isNaN(chatId)) {
        return res.status(400).json({ message: 'Invalid chat ID' })
      }

      const chatExport = await storage.getChatExport(chatId)
      if (!chatExport) {
        return res.status(404).json({ message: 'Chat export not found' })
      }

      // --- Fetch PDF ---
      let pdfBuffer: Buffer
      const pdfTempPath = path.join(
        os.tmpdir(),
        'whatspdf',
        'evidence_temp',
        `${chatId}_transcript.pdf`
      )
      fs.mkdirSync(path.dirname(pdfTempPath), { recursive: true })

      if (!chatExport.pdfUrl) {
        return res
          .status(404)
          .json({ message: 'PDF URL not found for this chat' })
      }

      console.log(
        `Fetching PDF for Evidence ZIP from URL: ${chatExport.pdfUrl}`
      )
      try {
        const pdfResponse = await fetch(chatExport.pdfUrl) // Fetch from proxy or local URL
        if (!pdfResponse.ok) {
          throw new Error(
            `Failed to fetch PDF (${pdfResponse.status}): ${pdfResponse.statusText}`
          )
        }
        const pdfArrayBuffer = await pdfResponse.arrayBuffer()
        pdfBuffer = Buffer.from(pdfArrayBuffer)
        fs.writeFileSync(pdfTempPath, pdfBuffer) // Save temporarily for hashing and zipping
        console.log(`Successfully fetched and saved PDF for ZIP.`)
      } catch (fetchError) {
        console.error(
          `Error fetching PDF for evidence package from ${chatExport.pdfUrl}:`,
          fetchError
        )
        return res.status(500).json({
          message: `Failed to retrieve PDF: ${
            fetchError instanceof Error ? fetchError.message : fetchError
          }`,
        })
      }

      // Temporary directory for the evidence package contents
      const tempDir = path.join(
        os.tmpdir(),
        'whatspdf',
        'evidence',
        chatId.toString()
      )
      if (fs.existsSync(tempDir))
        fs.rmSync(tempDir, { recursive: true, force: true }) // Clean previous attempt
      fs.mkdirSync(tempDir, { recursive: true })

      // Create attachments directory structure within tempDir
      const attachmentsDir = path.join(tempDir, 'attachments')
      const audioDir = path.join(attachmentsDir, 'audio')
      const imageDir = path.join(attachmentsDir, 'image')
      const pdfDir = path.join(attachmentsDir, 'pdf') // For attached PDFs, not the main transcript
      const otherDir = path.join(attachmentsDir, 'other')
      ;[attachmentsDir, audioDir, imageDir, pdfDir, otherDir].forEach((dir) =>
        fs.mkdirSync(dir, { recursive: true })
      )

      // --- Fetch Media Files ---
      const mediaFiles = await storage.getMediaFilesByChat(chatId)
      console.log(
        `Found ${mediaFiles.length} media files associated with chat ${chatId}.`
      )

      // Keep track of file hashes and mappings for the manifest
      const fileHashes: Record<string, string> = {}
      const fileMap: Record<
        string,
        { originalName: string; mediaType: string; extension: string }
      > = {}

      // Calculate PDF hash first
      const pdfHash = crypto
        .createHash('sha256')
        .update(pdfBuffer)
        .digest('hex')
      fileHashes['Chat_Transcript.pdf'] = pdfHash // Use fixed name for manifest key

      // Download media files
      const downloadPromises = mediaFiles
        // Exclude the main generated PDF file itself from being downloaded as an attachment
        .filter(
          (file) =>
            !(
              file.originalName === 'MAIN_GENERATED_PDF' ||
              (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
            )
        )
        .map(async (file) => {
          let targetDir = otherDir
          let mediaType = file.type || 'unknown'
          let extension = path
            .extname(file.key || file.originalName || '')
            .toLowerCase()

          // Determine target directory and ensure type is sensible
          if (file.type === 'voice') {
            targetDir = audioDir
            if (!extension) extension = '.ogg'
          } else if (file.type === 'image') {
            targetDir = imageDir
            if (!extension) extension = '.jpg'
          } // Default image ext
          else if (file.type === 'attachment') {
            if (file.contentType === 'application/pdf') {
              targetDir = pdfDir
              mediaType = 'pdf'
              if (!extension) extension = '.pdf'
            } else {
              targetDir = otherDir
              mediaType = 'attachment'
              if (!extension) extension = '.bin'
            } // Default other ext
          }
          // If type was just 'pdf' (possible if main PDF marker failed), put in pdfDir
          else if (file.type === 'pdf') {
            targetDir = pdfDir
            mediaType = 'pdf'
            if (!extension) extension = '.pdf'
          }

          const mediaFileName = `${file.id}${extension}` // Use media ID + extension for unique filename
          const filePath = path.join(targetDir, mediaFileName)
          const fileOriginalName =
            file.originalName || path.basename(file.key || 'unknown')

          try {
            // Fetch media using its proxy URL (preferred) or direct URL
            const fetchUrl = file.url?.includes('/api/media/proxy/')
              ? file.url
              : await storage.getMediaUrl(file.id) // Ensure fresh URL if direct
            if (!fetchUrl)
              throw new Error('Could not get valid URL for media file')

            const response = await fetch(fetchUrl)
            if (!response.ok) {
              throw new Error(
                `Failed to download media (${response.status}): ${response.statusText}`
              )
            }
            const arrayBuffer = await response.arrayBuffer()
            const fileBuffer = Buffer.from(arrayBuffer)

            fs.writeFileSync(filePath, fileBuffer)

            const hash = crypto
              .createHash('sha256')
              .update(fileBuffer)
              .digest('hex')
            fileHashes[mediaFileName] = hash // Use the actual filename in the zip for manifest key
            fileMap[mediaFileName] = {
              // Map filename in zip to original details
              originalName: fileOriginalName,
              mediaType: mediaType,
              extension: extension,
            }
            console.log(
              `Downloaded media file: ${mediaFileName} (Original: ${fileOriginalName})`
            )
            return { success: true }
          } catch (err) {
            console.error(
              `Error downloading media file ${file.id} (Original: ${fileOriginalName}):`,
              err
            )
            return { success: false }
          }
        })

      await Promise.all(downloadPromises)
      console.log(`Finished downloading media files for evidence zip.`)

      // --- Create ZIP ---
      res.setHeader('Content-Type', 'application/zip')
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="WhatsApp_Evidence_${chatId}_${format(
          new Date(),
          'yyyyMMdd'
        )}.zip"`
      )

      const archive = archiver('zip', { zlib: { level: 9 } })
      archive.pipe(res)

      // Add PDF to archive root
      archive.file(pdfTempPath, { name: 'Chat_Transcript.pdf' })

      // Add attachments directory
      archive.directory(attachmentsDir, 'attachments')

      // Create and add manifest.json
      const manifest = {
        caseReference: `WA-${format(new Date(), 'yyyyMMdd-HHmm')}`,
        originalFileHash: chatExport.fileHash,
        generatedOn: new Date().toISOString(),
        participants: chatExport.participants || ['Unknown'],
        messageCount:
          chatExport.messages?.length || chatExport.messages?.length || 0, // Use chatExport if available, else messages var
        mediaCount: {
          // Recalculate based on downloaded files if needed, or use mediaFiles count
          total: mediaFiles.filter(
            (f) =>
              !(
                f.originalName === 'MAIN_GENERATED_PDF' ||
                (f.fileHash && f.fileHash.startsWith('MAIN_PDF_'))
              )
          ).length,
          voice: mediaFiles.filter((f) => f.type === 'voice').length,
          image: mediaFiles.filter((f) => f.type === 'image').length,
          // Count attached PDFs separately from main transcript
          pdf: mediaFiles.filter(
            (f) =>
              f.type === 'pdf' &&
              !(
                f.originalName === 'MAIN_GENERATED_PDF' ||
                (f.fileHash && f.fileHash.startsWith('MAIN_PDF_'))
              )
          ).length,
          attachment: mediaFiles.filter(
            (f) =>
              f.type === 'attachment' && f.contentType !== 'application/pdf'
          ).length,
        },
        originalFilename: chatExport.originalFilename,
        fileHashes: fileHashes, // Includes main PDF and all attachments by their filename in the zip
        fileMap: fileMap, // Maps filename in zip to original name/type
      }
      archive.append(JSON.stringify(manifest, null, 2), {
        name: 'manifest.json',
      })

      // Add README.txt
      const readme = `EVIDENCE PACKAGE - WHATSAPP CHAT EXPORT
===============================

This ZIP archive contains:

1. Chat_Transcript.pdf - The formatted chat transcript with clickable links.
2. attachments/ - Directory containing all media files referenced in the transcript, organized by type (audio, image, pdf, other). Files are named using their unique internal ID and original extension.
3. manifest.json - Contains metadata about the export, including SHA-256 hashes for all included files (transcript and attachments) for integrity verification (Rule 902(14)). It also maps the filenames within the 'attachments' directory back to their original filenames as extracted from the chat export.
4. README.txt - This file.

INTEGRITY VERIFICATION:
- Verify the SHA-256 hash of any file within this package against the corresponding entry in 'manifest.json'.
- The key for each attachment hash in 'manifest.json' matches the filename found inside the 'attachments' subdirectories.
- The hash for the main transcript is listed under the key 'Chat_Transcript.pdf'.

FOR COURT SUBMISSIONS:
- This package is designed to meet requirements for self-authenticating electronic evidence under Federal Rule of Evidence 902(14).
- The cryptographic hashes provide a reliable method to confirm that the files have not been altered since generation.

HASH VERIFICATION TOOLS:
- Windows PowerShell: Get-FileHash -Algorithm SHA256 path\\to\\file
- Mac/Linux Terminal: shasum -a 256 path/to/file

Generated by WhatsPDF Voice on ${new Date().toLocaleDateString()}
`
      archive.append(readme, { name: 'README.txt' })

      // Finalize archive
      await archive.finalize()
      console.log(`Evidence ZIP stream finalized for chat ID ${chatId}`)

      // Clean up temporary files after a delay
      setTimeout(() => {
        try {
          fs.unlinkSync(pdfTempPath)
          fs.rmSync(tempDir, { recursive: true, force: true })
          console.log(
            `Cleaned up temp directory: ${tempDir} and temp PDF: ${pdfTempPath}`
          )
        } catch (err) {
          console.error(`Error cleaning up temp files for chat ${chatId}:`, err)
        }
      }, 30000) // 30 second delay
    } catch (error) {
      console.error('Evidence ZIP generation error:', error)
      // Avoid sending headers twice if archive already started piping
      if (!res.headersSent) {
        return res.status(500).json({
          message:
            error instanceof Error
              ? error.message
              : 'An unknown error occurred while creating the evidence package.',
        })
      } else {
        // If headers are sent, we can only destroy the connection
        res.end()
      }
    }
  },
}
