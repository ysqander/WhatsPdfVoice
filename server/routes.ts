import express, { type Express, Request, Response } from 'express'
import { createServer, type Server } from 'http'
import { storage } from './storage'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import { uploadController } from './controllers/uploadController'
import mediaRouter from './mediaRouter'
import Stripe from 'stripe'
import { paymentService } from './lib/paymentService'

// Setup temporary upload directory
const tempDir = path.join(os.tmpdir(), 'whatspdf-uploads')
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true })
}

// Configure multer for file uploads
const storage2 = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, tempDir)
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${uuidv4()}`
    cb(
      null,
      `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`
    )
  },
})

// Create multer instance with file size limits
const upload = multer({
  storage: storage2,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  },
  fileFilter: (_req, file, cb) => {
    console.log('Multer processing file:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      fieldname: file.fieldname,
    })

    if (
      file.mimetype === 'application/zip' ||
      file.originalname.endsWith('.zip')
    ) {
      cb(null, true)
    } else {
      console.error('File type rejected:', file.mimetype)
      cb(new Error('Only ZIP files are allowed'))
    }
  },
}).single('file')

// Wrap multer middleware to handle errors
const uploadMiddleware = (req: Request, res: Response, next: Function) => {
  upload(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      console.error('Multer error:', err)
      return res.status(400).json({ message: `Upload error: ${err.message}` })
    } else if (err) {
      console.error('Unknown upload error:', err)
      return res.status(400).json({ message: err.message })
    }
    next()
  })
}

export async function registerRoutes(app: Express): Promise<Server> {
  // --- STRIPE WEBHOOK: MUST BE FIRST! ---
  // Register the Stripe webhook route BEFORE any other middleware or route.
  // This ensures no body parser or other middleware mutates the raw body, which is required for signature verification.
  app.post(
    '/webhook/payment',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
      try {
        // Log important info for debugging
        console.log('Webhook received. Headers:', {
          'content-type': req.headers['content-type'],
          'stripe-signature': req.headers['stripe-signature']
            ? 'Present'
            : 'Missing',
        })

        if (!req.headers['stripe-signature']) {
          console.error('Stripe signature header is missing')
          return res.status(400).send('Stripe signature header is missing')
        }

        const signature = req.headers['stripe-signature'] as string
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

        if (!webhookSecret) {
          console.error('STRIPE_WEBHOOK_SECRET environment variable is not set')
          return res.status(500).send('Webhook secret is not configured')
        }

        // Verify the event
        let event
        try {
          console.log('Webhook raw body received:', !!req.body, typeof req.body)
          // The request body should be a Buffer at this point
          if (!Buffer.isBuffer(req.body)) {
            console.error('Request body is not a Buffer as expected')
          }

          // Construct the event from the raw body
          event = stripe.webhooks.constructEvent(
            req.body,
            signature,
            webhookSecret
          )

          console.log('Event construction successful:', event.type)
        } catch (err) {
          console.error('⚠️ Webhook signature verification failed:', err)
          return res
            .status(400)
            .send(
              `Webhook Error: ${
                err instanceof Error ? err.message : 'Unknown Error'
              }`
            )
        }

        console.log(`Webhook verified successfully: ${event.type}`)

        // Handle the webhook event type
        if (event.type === 'checkout.session.completed') {
          // Handle the checkout.session.completed event
          const session = event.data.object as Stripe.Checkout.Session

          console.log('Processing checkout session:', {
            sessionId: session.id,
            bundleId: session.client_reference_id,
            customerId: session.customer,
            paymentStatus: session.payment_status,
          })

          const bundle = await paymentService.handleCheckoutSessionCompleted(
            session.id
          )

          if (bundle) {
            console.log(`Payment succeeded for bundle ${bundle.bundleId}`)

            // Get the PDF URL from the bundle's chat export
            if (bundle.chatExportId) {
              try {
                // Get the chat export to access its PDF URL
                const chatExport = await storage.getChatExport(
                  bundle.chatExportId
                )

                if (chatExport) {
                  if (chatExport.pdfUrl) {
                    console.log(
                      `Retrieved PDF URL for paid bundle: ${chatExport.pdfUrl}`
                    )
                  } else {
                    console.warn(
                      `Chat export found but no PDF URL available for bundle ${bundle.bundleId}`
                    )

                    // Try to find the PDF in media files and set it
                    const mediaFiles = await storage.getMediaFilesByChat(
                      bundle.chatExportId
                    )
                    console.log(
                      `Found ${mediaFiles.length} media files for chat export ${bundle.chatExportId}`
                    )

                    // Log all media files for debugging
                    mediaFiles.forEach((file, index) => {
                      console.log(`Media file ${index + 1}:`, {
                        id: file.id,
                        type: file.type,
                        contentType: file.contentType,
                        key: file.key,
                        originalName: file.originalName,
                        fileHash: file.fileHash,
                      })
                    })

                    // First try to find the PDF by our special marker
                    let pdfFile = mediaFiles.find(
                      (file) =>
                        file.originalName === 'MAIN_GENERATED_PDF' ||
                        (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
                    )

                    // Fallback to type if our marker isn't found
                    if (!pdfFile) {
                      pdfFile = mediaFiles.find((file) => file.type === 'pdf')
                    }

                    if (pdfFile) {
                      try {
                        console.log(
                          `Found main PDF file by marker: ${pdfFile.id}, originalName: ${pdfFile.originalName}, hash: ${pdfFile.fileHash}`
                        )
                        // Generate a fresh URL and save it to the chat export
                        const pdfUrl = await storage.getMediaUrl(pdfFile.id)
                        await storage.savePdfUrl(bundle.chatExportId, pdfUrl)
                        console.log(
                          `Found and saved PDF URL for bundle ${bundle.bundleId} from media files: ${pdfUrl}`
                        )
                      } catch (error) {
                        console.error(
                          `Error updating PDF URL for bundle ${bundle.bundleId}:`,
                          error
                        )
                      }
                    } else {
                      console.error(
                        `No PDF file found in media files for chat export ${bundle.chatExportId}`
                      )

                      // If we can't find a PDF file by marker or type, look for any media file
                      // with the PDF contentType as a final fallback
                      const pdfByContentType = mediaFiles.find(
                        (file) => file.contentType === 'application/pdf'
                      )

                      if (pdfByContentType) {
                        try {
                          console.log(
                            `Found PDF by content type: ${pdfByContentType.id}`
                          )
                          const pdfUrl = await storage.getMediaUrl(
                            pdfByContentType.id
                          )
                          await storage.savePdfUrl(bundle.chatExportId, pdfUrl)
                          console.log(
                            `Saved PDF URL from content type for bundle ${bundle.bundleId}: ${pdfUrl}`
                          )
                        } catch (fallbackError) {
                          console.error(
                            `Error with PDF fallback for bundle ${bundle.bundleId}:`,
                            fallbackError
                          )
                        }
                      }
                    }
                  }
                } else {
                  console.error(
                    `Chat export ${bundle.chatExportId} not found for bundle ${bundle.bundleId}`
                  )
                }
              } catch (err) {
                console.error(
                  `Error retrieving chat export for paid bundle ${bundle.bundleId}:`,
                  err
                )
              }
            } else {
              console.warn(
                `No chatExportId found for paid bundle ${bundle.bundleId}`
              )
            }

            console.log(`Bundle marked as paid, valid for 30 days`)

            return res.json({ received: true })
          } else {
            console.error('Bundle not found or payment failed')
            return res.status(400).json({ error: 'Failed to process payment' })
          }
        } else {
          // Ignore other event types
          return res.json({ received: true })
        }
      } catch (error) {
        console.error('Error handling webhook:', error)
        res.status(500).json({
          error: 'Error handling webhook',
          message: error instanceof Error ? error.message : 'Unknown error',
        })
      }
    }
  )

  // Register the media router for proxy endpoints
  app.use(mediaRouter)

  // API routes
  app.post(
    '/api/whatsapp/process',
    uploadMiddleware,
    uploadController.processFile
  )
  app.get('/api/whatsapp/process-status', uploadController.getProcessStatus)
  app.get('/api/whatsapp/download', uploadController.downloadPdf)
  app.get(
    '/api/whatsapp/evidence-zip/:chatId',
    uploadController.downloadEvidenceZip
  )

  // Get chat export by ID (for showing previews after payment)
  app.get('/api/whatsapp/chat/:chatExportId', async (req, res) => {
    try {
      const chatExportId = parseInt(req.params.chatExportId, 10)

      if (isNaN(chatExportId)) {
        return res.status(400).json({ error: 'Invalid chat export ID' })
      }

      console.log(`Fetching chat export ${chatExportId}`)

      // Get chat export from storage
      const chatExport = await storage.getChatExport(chatExportId)

      if (!chatExport) {
        console.error(`Chat export ${chatExportId} not found`)
        return res.status(404).json({ error: 'Chat export not found' })
      }

      // Get messages for this chat export
      const messages = await storage.getMessagesByChatExportId(chatExportId)

      // Add messages to the chat export object
      const chatData = {
        ...chatExport,
        messages,
      }

      console.log(
        `Returning chat export ${chatExportId} with ${messages.length} messages`
      )

      res.json(chatData)
    } catch (error) {
      console.error('Error fetching chat export:', error)
      res.status(500).json({ error: 'Error fetching chat export' })
    }
  })

  // Add PDF serving route
  app.get('/api/whatsapp/pdf/:filename', (req, res) => {
    const filename = req.params.filename
    const pdfPath = path.join(os.tmpdir(), 'whatspdf', 'pdfs', filename)

    console.log('PDF request received:', {
      filename,
      pdfPath,
      exists: fs.existsSync(pdfPath),
    })

    if (!fs.existsSync(pdfPath)) {
      console.error('PDF file not found:', pdfPath)
      return res.status(404).json({ error: 'PDF not found' })
    }

    res.sendFile(pdfPath)
  })

  // Add media files serving route - for voice messages and other referenced media
  app.get('/media/:chatId/:filename', (req, res) => {
    const { chatId, filename } = req.params
    const mediaPath = path.join(
      os.tmpdir(),
      'whatspdf',
      'media',
      chatId,
      filename
    )

    console.log('Media request received:', {
      chatId,
      filename,
      mediaPath,
      exists: fs.existsSync(mediaPath),
    })

    if (!fs.existsSync(mediaPath)) {
      console.error('Media file not found:', mediaPath)
      return res.status(404).json({ error: 'Media file not found' })
    }

    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase()
    let contentType = 'application/octet-stream' // Default

    if (ext === '.ogg' || ext === '.oga') {
      contentType = 'audio/ogg'
    } else if (ext === '.mp3') {
      contentType = 'audio/mpeg'
    } else if (ext === '.m4a') {
      contentType = 'audio/mp4'
    } else if (ext === '.jpg' || ext === '.jpeg') {
      contentType = 'image/jpeg'
    } else if (ext === '.png') {
      contentType = 'image/png'
    } else if (ext === '.gif') {
      contentType = 'image/gif'
    } else if (ext === '.pdf') {
      contentType = 'application/pdf'
    }

    // Set appropriate headers and send file
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
    res.sendFile(mediaPath)
  })

  // R2 Media Management Routes

  // Get all media files for a chat
  app.get('/api/media/:chatId', async (req, res) => {
    try {
      const chatId = parseInt(req.params.chatId, 10)
      if (isNaN(chatId)) {
        return res.status(400).json({ error: 'Invalid chat ID' })
      }

      // Get all media files for this chat
      const mediaFiles = await storage.getMediaFilesByChat(chatId)

      return res.status(200).json({ media: mediaFiles })
    } catch (error) {
      console.error('Error fetching media files:', error)
      return res.status(500).json({
        error: 'Failed to fetch media files',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // Delete a media file
  app.delete('/api/media/:mediaId', async (req, res) => {
    try {
      const { mediaId } = req.params

      // Delete the media file
      await storage.deleteMedia(mediaId)

      return res
        .status(200)
        .json({ success: true, message: 'Media deleted successfully' })
    } catch (error) {
      console.error('Error deleting media file:', error)
      return res.status(500).json({
        error: 'Failed to delete media file',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // Initialize Stripe
  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn(
      'STRIPE_SECRET_KEY is not set. Payment features will not work properly.'
    )
  }
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2023-10-16' as any,
  })

  // Webhook signing secret - would come from Stripe dashboard in production
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET

  // Checkout routes
  app.post('/api/create-payment-intent', async (req, res) => {
    try {
      const { bundleId } = req.body

      // Get the origin for success and cancel URLs
      const origin = `${req.protocol}://${req.get('host')}`
      const successUrl = `${origin}/payment-success?session_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${origin}/payment-cancelled`

      // Create a checkout session
      const checkoutUrl = await paymentService.createCheckoutSession(
        bundleId,
        successUrl,
        cancelUrl
      )

      // Return the checkout URL
      res.json({
        success: true,
        clientSecret: null, // For compatibility with the client expectation
        checkoutUrl,
      })
    } catch (error) {
      console.error('Error creating checkout session:', error)
      res.status(500).json({
        error: 'Error creating checkout session',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // Payment success page
  app.get('/payment-success', async (req, res) => {
    try {
      const sessionId = req.query.session_id as string

      if (!sessionId) {
        return res.status(400).send('No session ID provided')
      }

      console.log(`Processing success redirect for session: ${sessionId}`)

      // Process the completed session
      const bundle = await paymentService.handleCheckoutSessionCompleted(
        sessionId
      )

      if (!bundle) {
        console.error(`No bundle found for session ${sessionId}`)
        return res
          .status(404)
          .send('Bundle not found or payment could not be processed')
      }

      console.log(
        `Success redirect for bundle: ${bundle.bundleId}, chatExportId: ${bundle.chatExportId}`
      )

      // If we have a chat export ID, verify that we can actually get the PDF URL
      if (bundle.chatExportId) {
        try {
          const chatExport = await storage.getChatExport(bundle.chatExportId)

          if (chatExport) {
            if (chatExport.pdfUrl) {
              console.log(
                `PDF URL for paid bundle ${bundle.bundleId}: ${chatExport.pdfUrl}`
              )
            } else {
              console.warn(
                `No PDF URL found for chat export ${bundle.chatExportId}`
              )

              // Try to find PDF in media files
              const mediaFiles = await storage.getMediaFilesByChat(
                bundle.chatExportId
              )
              console.log(
                `Found ${mediaFiles.length} media files for chat export ${bundle.chatExportId} in redirect flow`
              )

              // Log media files for debugging
              mediaFiles.forEach((file, index) => {
                console.log(`Media file ${index + 1} in redirect:`, {
                  id: file.id,
                  type: file.type,
                  contentType: file.contentType,
                  key: file.key,
                })
              })

              // First try to find the PDF by our special marker
              let pdfFile = mediaFiles.find(
                (file) =>
                  file.originalName === 'MAIN_GENERATED_PDF' ||
                  (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
              )

              // Fallback to type if our marker isn't found
              if (!pdfFile) {
                pdfFile = mediaFiles.find((file) => file.type === 'pdf')
              }

              // Try content type as fallback
              if (!pdfFile) {
                pdfFile = mediaFiles.find(
                  (file) => file.contentType === 'application/pdf'
                )
                if (pdfFile) {
                  console.log(
                    `Found PDF by content type in redirect: ${pdfFile.id}`
                  )
                }
              }

              if (pdfFile) {
                try {
                  // Generate a fresh URL and save it to the chat export
                  const pdfUrl = await storage.getMediaUrl(pdfFile.id)
                  await storage.savePdfUrl(bundle.chatExportId, pdfUrl)
                  console.log(
                    `Found and saved PDF URL for redirect of bundle ${bundle.bundleId}: ${pdfUrl}`
                  )
                } catch (error) {
                  console.error(
                    `Error updating PDF URL for bundle ${bundle.bundleId} in redirect:`,
                    error
                  )
                }
              } else {
                console.error(
                  `No PDF media file found for chat export ${bundle.chatExportId} in redirect flow`
                )
              }
            }
          } else {
            console.error(
              `Chat export ${bundle.chatExportId} not found for bundle ${bundle.bundleId} in redirect flow`
            )
          }
        } catch (err) {
          console.error(
            `Error getting chat export for bundle ${bundle.bundleId} in redirect:`,
            err
          )
        }
      }

      // Redirect to client success page
      res.redirect(`/?success=true&bundleId=${bundle.bundleId}`)
    } catch (error) {
      console.error('Error handling payment success:', error)
      res.status(500).send('Error processing payment')
    }
  })

  // Payment cancelled page
  app.get('/payment-cancelled', (_req, res) => {
    res.redirect('/?cancelled=true')
  })

  // Get bundle status
  app.get('/api/payment/:bundleId', async (req, res) => {
    try {
      const { bundleId } = req.params

      console.log(`Fetching payment bundle status for ${bundleId}`)

      // Get bundle from database
      const bundle = await paymentService.getPaymentBundle(bundleId)

      if (!bundle) {
        console.error(`Bundle ${bundleId} not found in database`)
        return res.status(404).json({ error: 'Bundle not found' })
      }

      // Check if chat export exists in database
      const chatExportId = bundle.chatExportId
      const isPaid = bundle.paidAt !== null
      let pdfUrl = null

      console.log(
        `Bundle ${bundleId}: chatExportId=${chatExportId}, isPaid=${isPaid}`
      )

      if (isPaid && chatExportId) {
        try {
          // Get chat export to obtain the PDF URL
          let chatExport = await storage.getChatExport(chatExportId)

          if (chatExport) {
            console.log(
              `Found chat export ${chatExportId} for bundle ${bundleId}`
            )

            if (chatExport.pdfUrl) {
              pdfUrl = chatExport.pdfUrl
              console.log(`PDF URL found for bundle ${bundleId}: ${pdfUrl}`)
            } else {
              console.warn(
                `Chat export ${chatExportId} found but no PDF URL available. Attempting robust repair.`
              )

              // Attempt robust repair before searching media files
              try {
                await paymentService.ensurePdfGeneratedAndLinked(bundle)
                // Re-fetch chat export after repair attempt
                chatExport = await storage.getChatExport(chatExportId)
                if (chatExport && chatExport.pdfUrl) {
                  pdfUrl = chatExport.pdfUrl
                  console.log(`PDF URL found after robust repair: ${pdfUrl}`)
                }
              } catch (repairErr) {
                console.error(`Error during robust PDF repair:`, repairErr)
              }

              // If still missing, proceed to search media files
              if (!pdfUrl) {
                // Determine if we have media files for this chat export
                const mediaFiles = await storage.getMediaFilesByChat(
                  chatExportId
                )
                console.log(
                  `Found ${mediaFiles.length} media files for chat export ${chatExportId} in status check`
                )

                // Debug log media files
                mediaFiles.forEach((file, index) => {
                  console.log(`Media file ${index + 1} in status check:`, {
                    id: file.id,
                    type: file.type,
                    contentType: file.contentType,
                    key: file.key,
                  })
                })

                // First try to find the PDF by our special marker
                let pdfFile = mediaFiles.find(
                  (file) =>
                    file.originalName === 'MAIN_GENERATED_PDF' ||
                    (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
                )

                // Fallback to type if our marker isn't found
                if (!pdfFile) {
                  pdfFile = mediaFiles.find((file) => file.type === 'pdf')
                }

                // If not found, try by content type as fallback
                if (!pdfFile) {
                  pdfFile = mediaFiles.find(
                    (file) => file.contentType === 'application/pdf'
                  )
                  if (pdfFile) {
                    console.log(
                      `Found PDF by content type in status check: ${pdfFile.id}`
                    )
                  }
                }

                if (pdfFile) {
                  // We found a PDF file in the media files, let's use its URL
                  pdfUrl = await storage.getMediaUrl(pdfFile.id)
                  console.log(`Using PDF media file URL instead: ${pdfUrl}`)

                  // Update the chat export with this PDF URL for future use
                  await storage.savePdfUrl(chatExportId, pdfUrl)
                } else {
                  console.error(
                    `No PDF file found in media files for chat export ${chatExportId}`
                  )
                }
              }
            }
          } else {
            console.error(
              `Chat export ${chatExportId} not found for bundle ${bundleId}`
            )
          }
        } catch (err) {
          console.error(
            `Error retrieving chat export for paid bundle ${bundleId}:`,
            err
          )
        }
      }

      res.json({
        bundleId: bundle.bundleId,
        chatExportId: bundle.chatExportId, // Include chatExportId in response
        isPaid,
        messageCount: bundle.messageCount || 0,
        mediaSizeBytes: bundle.mediaSizeBytes || 0,
        pdfUrl,
        paidAt: bundle.paidAt,
        expiresAt: bundle.expiresAt,
      })
    } catch (error) {
      console.error('Error getting bundle:', error)
      res.status(500).json({ error: 'Error getting bundle' })
    }
  })

  // Repair bundle PDF URL - for recovering PDF URL when missing
  app.post('/api/payment/:bundleId/repair', async (req, res) => {
    try {
      const { bundleId } = req.params

      console.log(`Repairing PDF URL for bundle ${bundleId}`)

      // Get bundle from database
      const bundle = await paymentService.getPaymentBundle(bundleId)

      if (!bundle) {
        console.error(`Bundle ${bundleId} not found in database`)
        return res.status(404).json({ error: 'Bundle not found' })
      }

      // Verify bundle is paid and has a chat export ID
      if (!bundle.paidAt) {
        return res.status(400).json({ error: 'Bundle is not paid yet' })
      }

      if (!bundle.chatExportId) {
        return res.status(400).json({ error: 'Bundle has no chat export ID' })
      }

      // Try robust PDF generation/linking
      try {
        await paymentService.ensurePdfGeneratedAndLinked(bundle)
      } catch (err) {
        console.error(
          'Error in ensurePdfGeneratedAndLinked during repair:',
          err
        )
      }

      // Get chat export
      const chatExport = await storage.getChatExport(bundle.chatExportId)

      if (!chatExport) {
        return res.status(404).json({ error: 'Chat export not found' })
      }

      // If chat export now has a PDF URL, return it
      if (chatExport.pdfUrl) {
        console.log(
          `Chat export ${bundle.chatExportId} now has PDF URL: ${chatExport.pdfUrl}`
        )
        return res.json({
          success: true,
          message: 'PDF URL repaired or already exists',
          pdfUrl: chatExport.pdfUrl,
          chatExportId: bundle.chatExportId,
        })
      }

      // Fallback: Try to find the PDF in media files
      const mediaFiles = await storage.getMediaFilesByChat(bundle.chatExportId)
      console.log(
        `Found ${mediaFiles.length} media files for chat export ${bundle.chatExportId}`
      )

      // Log all media files for debugging
      mediaFiles.forEach((file, index) => {
        console.log(`Media file ${index + 1}:`, {
          id: file.id,
          type: file.type,
          contentType: file.contentType,
          key: file.key,
        })
      })

      // First try to find the PDF by our special marker
      let pdfFile = mediaFiles.find(
        (file) =>
          file.originalName === 'MAIN_GENERATED_PDF' ||
          (file.fileHash && file.fileHash.startsWith('MAIN_PDF_'))
      )

      // Fallback to type if our marker isn't found
      if (!pdfFile) {
        pdfFile = mediaFiles.find((file) => file.type === 'pdf')
      }

      // If no PDF file found by type, try content type as fallback
      if (!pdfFile) {
        pdfFile = mediaFiles.find(
          (file) => file.contentType === 'application/pdf'
        )
        if (pdfFile) {
          console.log(`Found PDF by content type: ${pdfFile.id}`)
        }
      }

      if (!pdfFile) {
        return res.status(404).json({
          error: 'No PDF file found',
          mediaFiles: mediaFiles.length,
          mediaFileTypes: mediaFiles.map((file) => file.type || 'unknown'),
        })
      }

      console.log(
        `Using PDF file: ${pdfFile.id}, type: ${pdfFile.type}, contentType: ${pdfFile.contentType}`
      )

      // Get a fresh URL for the PDF
      const pdfUrl = await storage.getMediaUrl(pdfFile.id)

      // Save the PDF URL to the chat export
      await storage.savePdfUrl(bundle.chatExportId, pdfUrl)

      console.log(`Repaired PDF URL for bundle ${bundleId}: ${pdfUrl}`)

      return res.json({
        success: true,
        message: 'PDF URL repaired successfully (fallback)',
        pdfUrl,
        chatExportId: bundle.chatExportId, // Include the chatExportId
      })
    } catch (error) {
      console.error('Error repairing PDF URL:', error)
      return res.status(500).json({
        error: 'Error repairing PDF URL',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  const httpServer = createServer(app)

  return httpServer
}
