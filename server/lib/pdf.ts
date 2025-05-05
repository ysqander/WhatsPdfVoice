import { ChatExport, Message, MediaFile } from '@shared/types'
import {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFName,
  PDFArray,
  PDFString,
  PDFPage,
  PDFFont,
  Color,
  // drawText is not needed if using page.drawText directly
  PageSizes,
} from 'pdf-lib'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { format } from 'date-fns'
import { v4 as uuidv4 } from 'uuid'
import { getFileHash } from './hash'
import { getAppBaseUrl } from './appBaseUrl'
// Removed puppeteer import
// Removed getSignedR2Url as proxy URL generation is handled differently now
import { storage } from '../storage' // Assuming storage can fetch media files

// --- Constants ---
const MARGIN = 50
const PRIMARY_COLOR = rgb(0.17, 0.24, 0.31) // #2C3E50
const SECONDARY_COLOR = rgb(0.2, 0.29, 0.37) // #34495E
const TEXT_COLOR = rgb(0.2, 0.2, 0.2) // #333333
const LINK_COLOR = rgb(0.1, 0.4, 0.7) // Darker blue for links
const META_COLOR = rgb(0.5, 0.5, 0.5) // Grey for less important text
const HEADER_LINE_HEIGHT = 15
const CONTENT_LINE_HEIGHT = 15
const MESSAGE_SPACING = 10 // Vertical space between messages
const CONTENT_INDENT = 15 // Indentation for message content relative to header

// Create PDF directory if it doesn't exist
const pdfDir = path.join(os.tmpdir(), 'whatspdf', 'pdfs')
if (!fs.existsSync(pdfDir)) {
  fs.mkdirSync(pdfDir, { recursive: true })
}

// --- Main Exported Function ---

/**
 * Generates a PDF transcript from WhatsApp chat data using pdf-lib.
 * @param chatData The processed chat export data.
 * @returns The local path to the generated PDF file.
 */
export async function generatePdf(chatData: ChatExport): Promise<string> {
  console.log('Starting PDF generation with pdf-lib...')
  if (!chatData || !chatData.messages) {
    throw new Error('Invalid chat data provided for PDF generation.')
  }
  // Ensure chatData has an ID for fetching media files
  if (!chatData.id) {
    console.error(
      'ChatExport ID is missing, cannot fetch media files for summary page.'
    )
    // Allow proceeding but log warning
    // throw new Error("ChatExport ID is required for generating media proxy links.");
  }

  const { pdfPath } = await generatePdfWithPdfLib(chatData)
  return pdfPath
}

// --- PDF Generation Logic (using pdf-lib) ---

async function generatePdfWithPdfLib(
  chatData: ChatExport
): Promise<{ pdfPath: string; pdfId: string }> {
  console.log(
    `[PDF DEBUG] generatePdfWithPdfLib called for chatData.id: ${chatData.id}`
  )
  if (!chatData.id) {
    console.warn(
      '[PDF DEBUG] chatData.id is MISSING or invalid when entering generatePdfWithPdfLib! Summary page might be incomplete.'
    )
    // Allow proceeding without ID, but summary might be affected
  }

  const pdfDoc = await PDFDocument.create()

  // Add metadata
  pdfDoc.setTitle(`WhatsApp Chat - ${format(new Date(), 'yyyy-MM-dd')}`)
  pdfDoc.setAuthor('WhatsPDF Voice')
  pdfDoc.setCreator('WhatsPDF Voice')
  pdfDoc.setProducer('WhatsPDF Voice')
  pdfDoc.setSubject(
    `WhatsApp Chat Export: ${chatData.originalFilename || 'Unknown File'}`
  )

  // Embed fonts
  const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman)
  const timesRomanBoldFont = await pdfDoc.embedFont(
    StandardFonts.TimesRomanBold
  )

  // --- Fetch Media File Data (Still Needed for Summary Page) ---
  let mediaFilesMap = new Map<string, MediaFile>() // Map media file ID -> MediaFile
  let messageToMediaMap = new Map<string, MediaFile>() // Map message ID -> MediaFile

  if (chatData.id) {
    try {
      console.log(
        `[PDF DEBUG] Attempting storage.getMediaFilesByChat with ID: ${chatData.id}`
      )
      const mediaFiles = await storage.getMediaFilesByChat(chatData.id)
      console.log(
        `[PDF DEBUG] storage.getMediaFilesByChat returned ${mediaFiles.length} files.`
      )

      mediaFiles.forEach((file) => {
        if (file.id) {
          mediaFilesMap.set(file.id, file) // Map by MediaFile ID
        }
        if (file.messageId !== undefined && file.messageId !== null) {
          const messageIdStr = String(file.messageId)
          // Check if another file is already mapped to this messageId (rare, but possible)
          if (!messageToMediaMap.has(messageIdStr)) {
            messageToMediaMap.set(messageIdStr, file) // Map by Message ID
            console.log(
              `PDF: Mapped messageId ${messageIdStr} to file ${file.id}`
            )
          } else {
            console.warn(
              `PDF: Message ID ${messageIdStr} already mapped to file ${
                messageToMediaMap.get(messageIdStr)?.id
              }. Skipping mapping for file ${file.id}`
            )
          }
        }
      })

      console.log(
        `PDF: Mapped ${mediaFilesMap.size} media file records by Media ID and ${messageToMediaMap.size} by Message ID for chat ${chatData.id}`
      )
    } catch (error) {
      console.error(
        `PDF: Failed to fetch media files for chat ${chatData.id}. Summary page may be incomplete.`,
        error
      )
    }
  } else {
    console.warn(
      'PDF: ChatExport ID missing, skipping media file fetch. Summary page will be incomplete.'
    )
  }

  // --- Page Setup ---
  let currentPage = pdfDoc.addPage(PageSizes.A4)
  const { width, height } = currentPage.getSize()
  let y = height - MARGIN // Current Y position, starts at top margin
  let currentPageNumber = 1 // Track current page number

  // --- Draw Header on First Page ---
  y = drawPdfHeader(
    currentPage,
    chatData,
    timesRomanFont,
    timesRomanBoldFont,
    width,
    y,
    pdfDoc
  )

  // --- Group Messages by Date ---
  const messagesByDate: Record<string, Message[]> = {}
  chatData.messages.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  for (const message of chatData.messages) {
    // Ensure timestamp is valid before formatting
    try {
      // Timestamps might be strings (ISO) or Date objects, handle both
      const dateObj =
        typeof message.timestamp === 'string'
          ? new Date(message.timestamp)
          : message.timestamp
      if (isNaN(dateObj.getTime())) {
        throw new Error('Invalid Date object')
      }
      const date = format(dateObj, 'dd MMMM yyyy')
      if (!messagesByDate[date]) {
        messagesByDate[date] = []
      }
      messagesByDate[date].push(message)
    } catch (e) {
      console.warn(
        `PDF: Skipping message due to invalid timestamp: ${message.timestamp}`,
        message,
        e
      )
    }
  }

  // --- Process and Draw Messages ---
  const dateEntries = Object.entries(messagesByDate)
  for (let dateIndex = 0; dateIndex < dateEntries.length; dateIndex++) {
    const [date, messages] = dateEntries[dateIndex]

    // --- Draw Date Separator ---
    const dateSeparatorHeight = 30
    if (y < MARGIN + dateSeparatorHeight) {
      // Add page number to the previous page before creating a new one
      addPageNumber(
        currentPage,
        currentPageNumber,
        pdfDoc.getPageCount() + 1,
        timesRomanFont,
        MARGIN
      ) // Estimate total pages (+1 for the new one)
      currentPage = pdfDoc.addPage(PageSizes.A4)
      currentPageNumber++
      y = height - MARGIN
    }

    currentPage.drawText(date, {
      x: width / 2 - timesRomanFont.widthOfTextAtSize(date, 10) / 2,
      y: y,
      size: 10,
      font: timesRomanFont,
      color: META_COLOR,
    })
    y -= dateSeparatorHeight

    // --- Draw Messages for the Current Date ---
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
      const message = messages[messageIndex]

      // Ensure timestamp is valid before formatting time
      let timestamp = '[Invalid Time]'
      try {
        const dateObj =
          typeof message.timestamp === 'string'
            ? new Date(message.timestamp)
            : message.timestamp
        if (isNaN(dateObj.getTime())) {
          throw new Error('Invalid Date object')
        }
        timestamp = format(dateObj, 'HH:mm:ss')
      } catch (e) {
        console.warn(
          `PDF: Using placeholder time due to invalid timestamp: ${message.timestamp}`,
          message,
          e
        )
      }

      // --- Estimate Height Needed for the Message ---
      const estimatedHeight = estimateMessageHeight(
        message,
        timesRomanFont,
        timesRomanBoldFont,
        10,
        width - MARGIN * 2
      )

      // --- Check for Page Break ---
      if (y < MARGIN + estimatedHeight) {
        // Add page number to the previous page before creating a new one
        addPageNumber(
          currentPage,
          currentPageNumber,
          pdfDoc.getPageCount() + 1,
          timesRomanFont,
          MARGIN
        ) // Estimate total pages (+1 for the new one)
        currentPage = pdfDoc.addPage(PageSizes.A4)
        currentPageNumber++
        y = height - MARGIN
      }

      // --- Draw Message Header (Timestamp, Sender) ---
      const sender = message.sender || 'Unknown Sender'
      const senderColor =
        message.sender === chatData.participants?.[0] // Use optional chaining
          ? PRIMARY_COLOR
          : SECONDARY_COLOR
      const headerText = `[${timestamp}] ${sender}:`

      currentPage.drawText(headerText, {
        x: MARGIN,
        y: y,
        size: 10,
        font: timesRomanBoldFont,
        color: senderColor,
        lineHeight: HEADER_LINE_HEIGHT,
      })
      y -= HEADER_LINE_HEIGHT

      // --- Draw Message Content (Text, Links, Placeholders) ---
      const contentX = MARGIN + CONTENT_INDENT
      const contentMaxWidth = width - contentX - MARGIN
      let contentEndY = y

      // Find associated media file (primarily for link fallback and summary page)
      let mediaFile: MediaFile | undefined
      if (message.id) {
        mediaFile = messageToMediaMap.get(String(message.id))
      }

      if (message.type === 'text') {
        const { finalY } = drawWrappedText(
          currentPage,
          message.content || '',
          timesRomanFont,
          10,
          contentX,
          y,
          contentMaxWidth,
          CONTENT_LINE_HEIGHT,
          TEXT_COLOR
        )
        contentEndY = finalY
      } else if (message.type === 'voice' && message.mediaUrl) {
        contentEndY = await drawVoiceMessageLink(
          currentPage,
          pdfDoc,
          message,
          mediaFile, // Pass potentially found mediaFile for fallback URL generation
          timesRomanFont,
          timesRomanBoldFont,
          contentX,
          y,
          LINK_COLOR,
          chatData.id
        )
      } else if (message.type === 'image' && message.mediaUrl) {
        contentEndY = await drawMediaLink(
          currentPage,
          pdfDoc,
          message,
          mediaFile, // Pass potentially found mediaFile for fallback URL generation
          timesRomanFont,
          timesRomanBoldFont,
          contentX,
          y,
          LINK_COLOR,
          chatData.id
        )
      } else if (message.type === 'attachment' && message.mediaUrl) {
        contentEndY = await drawMediaLink(
          currentPage,
          pdfDoc,
          message,
          mediaFile, // Pass potentially found mediaFile for fallback URL generation
          timesRomanFont,
          timesRomanBoldFont,
          contentX,
          y,
          LINK_COLOR,
          chatData.id
        )
      } else {
        // Handle unknown or unsupported types, or media messages without a URL
        const typeLabel = message.type || 'Media'
        const unknownText = message.mediaUrl
          ? `[Unsupported Message Type: ${typeLabel}]`
          : `[${typeLabel} message - content omitted or unavailable]`

        currentPage.drawText(unknownText, {
          x: contentX,
          y: y,
          size: 9,
          font: timesRomanFont,
          color: rgb(0.6, 0, 0), // Use a distinct color for warnings/errors
          lineHeight: CONTENT_LINE_HEIGHT,
        })
        contentEndY = y - CONTENT_LINE_HEIGHT
      }

      y = contentEndY - MESSAGE_SPACING
    }
  }

  // --- Add Media Files Summary Page ---
  // Add page number to the last content page
  addPageNumber(
    currentPage,
    currentPageNumber,
    pdfDoc.getPageCount() + 1,
    timesRomanFont,
    MARGIN
  ) // Estimate total pages

  const summaryPage = pdfDoc.addPage(PageSizes.A4)
  const summaryPageNumber = pdfDoc.getPageCount() // Get the actual page number for the summary
  let summaryY = height - MARGIN

  summaryPage.drawText('MEDIA FILES AND AUTHENTICATION SUMMARY', {
    x:
      width / 2 -
      timesRomanBoldFont.widthOfTextAtSize(
        'MEDIA FILES AND AUTHENTICATION SUMMARY',
        14
      ) /
        2,
    y: summaryY,
    size: 14,
    font: timesRomanBoldFont,
    color: PRIMARY_COLOR,
  })
  summaryY -= 30

  summaryPage.drawText(
    'This page provides a summary of all media files referenced in this transcript for Rule 902(14) compliance.',
    {
      x: MARGIN,
      y: summaryY,
      size: 10,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )
  summaryY -= 20
  summaryPage.drawText(
    'Media files are referenced by their unique identifier in the transcript links. These identifiers',
    {
      x: MARGIN,
      y: summaryY,
      size: 10,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )
  summaryY -= 15
  summaryPage.drawText(
    'correspond to filenames in the attachments directory of the evidence package.',
    {
      x: MARGIN,
      y: summaryY,
      size: 10,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )
  summaryY -= 30

  // Draw table headers
  const colWidths = [200, 200, 70, 0] // Adjust widths as needed
  const colX = [
    MARGIN,
    MARGIN + colWidths[0],
    MARGIN + colWidths[0] + colWidths[1],
  ]
  summaryPage.drawText('MEDIA ID', {
    x: colX[0],
    y: summaryY,
    size: 10,
    font: timesRomanBoldFont,
    color: PRIMARY_COLOR,
  })
  summaryPage.drawText('ORIGINAL FILENAME', {
    x: colX[1],
    y: summaryY,
    size: 10,
    font: timesRomanBoldFont,
    color: PRIMARY_COLOR,
  })
  summaryPage.drawText('TYPE', {
    x: colX[2],
    y: summaryY,
    size: 10,
    font: timesRomanBoldFont,
    color: PRIMARY_COLOR,
  })
  summaryY -= 15
  summaryPage.drawLine({
    start: { x: MARGIN, y: summaryY + 5 },
    end: { x: width - MARGIN, y: summaryY + 5 },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  })
  summaryY -= 15

  // Draw media file entries
  // Use the mediaFilesMap which is keyed by MediaFile.id
  const displayMediaFiles = Array.from(mediaFilesMap.values())
  const entriesPerPage = 25 // Approximate, adjust based on actual space needs
  console.log(
    `[PDF DEBUG] Summary Page: displayMediaFiles count: ${displayMediaFiles.length} (from mediaFilesMap)`
  )

  if (displayMediaFiles.length === 0) {
    console.log('PDF: No media files to display in summary table')
    summaryPage.drawText('No media files are present in this transcript.', {
      x: MARGIN,
      y: summaryY,
      size: 10,
      font: timesRomanFont,
      color: TEXT_COLOR,
    })
    summaryY -= 20
  } else {
    console.log(
      `PDF: Displaying ${displayMediaFiles.length} media files in summary table`
    )
    for (
      let i = 0;
      i < Math.min(displayMediaFiles.length, entriesPerPage);
      i++
    ) {
      if (summaryY < MARGIN + 30) {
        // Check if space is left for entry + hash + separator
        console.log('PDF Summary: Adding new page for media entries')
        addPageNumber(
          summaryPage,
          summaryPageNumber,
          pdfDoc.getPageCount() + 1,
          timesRomanFont,
          MARGIN
        )
        // Create new summary page
        // TODO: Need to handle adding multiple summary pages if needed
        console.error(
          'PDF Summary: More media files than fit on one summary page - not implemented!'
        )
        break // Stop adding entries if out of space (simplification)
      }

      const file = displayMediaFiles[i]
      if (!file || !file.id) continue

      const origFilename =
        file.originalName || path.basename(file.key || 'unknown')
      const truncatedFilename =
        origFilename.length > 40
          ? origFilename.substring(0, 37) + '...'
          : origFilename
      const mediaId = file.id
      let displayType = file.type || 'unknown'
      if (file.type === 'attachment') {
        const fileExtension = path
          .extname(file.key || origFilename)
          .toLowerCase()
        displayType = fileExtension === '.pdf' ? 'pdf' : 'other'
      }

      summaryPage.drawText(mediaId, {
        x: colX[0],
        y: summaryY,
        size: 8,
        font: timesRomanFont,
        color: TEXT_COLOR,
      })
      summaryPage.drawText(truncatedFilename, {
        x: colX[1],
        y: summaryY,
        size: 9,
        font: timesRomanFont,
        color: TEXT_COLOR,
      })
      summaryPage.drawText(displayType, {
        x: colX[2],
        y: summaryY,
        size: 9,
        font: timesRomanFont,
        color: TEXT_COLOR,
      })
      summaryY -= 15

      const hashLabel = 'SHA-256: '
      let fileHash =
        file.fileHash || '[Available in evidence package manifest.json]' // Prefer stored hash
      if (!file.fileHash && chatData.id) {
        // Only calculate if ID exists
        const calculatedHash = getFileHash(file, chatData.id) // Try calculating if not stored
        if (calculatedHash) fileHash = calculatedHash
      }

      summaryPage.drawText(hashLabel, {
        x: MARGIN + 20,
        y: summaryY,
        size: 7,
        font: timesRomanBoldFont,
        color: TEXT_COLOR,
      })
      summaryPage.drawText(fileHash, {
        x: MARGIN + 20 + timesRomanBoldFont.widthOfTextAtSize(hashLabel, 7),
        y: summaryY,
        size: 7,
        font: timesRomanFont,
        color: TEXT_COLOR,
      })
      summaryY -= 10

      if (i < Math.min(displayMediaFiles.length, entriesPerPage) - 1) {
        summaryPage.drawLine({
          start: { x: MARGIN, y: summaryY + 7 },
          end: { x: width - MARGIN, y: summaryY + 7 },
          thickness: 0.5,
          color: rgb(0.9, 0.9, 0.9),
        })
        summaryY -= 5
      }
    }
  }

  // Add legal text at bottom
  summaryY = Math.min(summaryY, 150) // Ensure enough space at bottom
  if (summaryY < MARGIN + 75) {
    // Check space for legal text
    // Potentially add another page just for legal text if needed
    console.warn(
      'PDF Summary: Not enough space for legal text on summary page.'
    )
  }

  summaryPage.drawText('LEGAL AUTHENTICATION', {
    x: MARGIN,
    y: summaryY,
    size: 12,
    font: timesRomanBoldFont,
    color: PRIMARY_COLOR,
  })
  summaryY -= 20
  summaryPage.drawText(
    'This transcript and its associated media files have been prepared in accordance with',
    {
      x: MARGIN,
      y: summaryY,
      size: 9,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )
  summaryY -= 15
  summaryPage.drawText(
    'Federal Rule of Evidence 902(14), which provides for self-authentication of electronic evidence.',
    {
      x: MARGIN,
      y: summaryY,
      size: 9,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )
  summaryY -= 15
  summaryPage.drawText(
    'The included manifest.json file contains SHA-256 cryptographic hashes of all files in this package.',
    {
      x: MARGIN,
      y: summaryY,
      size: 9,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )
  summaryY -= 15
  summaryPage.drawText(
    'These hashes can be independently verified to confirm file integrity without expert testimony.',
    {
      x: MARGIN,
      y: summaryY,
      size: 9,
      font: timesRomanFont,
      color: TEXT_COLOR,
    }
  )

  // --- Add Page Number to Summary Page ---
  addPageNumber(
    summaryPage,
    summaryPageNumber,
    summaryPageNumber,
    timesRomanFont,
    MARGIN
  ) // Use actual total pages

  // --- Save PDF ---
  console.log('Saving PDF document...')
  const pdfBytes = await pdfDoc.save()
  const pdfId = uuidv4()
  const pdfPath = path.join(pdfDir, `${pdfId}.pdf`)

  try {
    fs.writeFileSync(pdfPath, pdfBytes)
    console.log('PDF file written successfully to:', pdfPath)
    console.log('PDF details:', { pdfId, size: pdfBytes.length })
  } catch (error: any) {
    console.error('Error writing PDF file:', error)
    throw new Error(
      `Failed to write PDF file: ${error.message || String(error)}`
    )
  }

  return { pdfPath, pdfId }
}

// --- Helper Functions (Implementations) ---

/** Draws the main header on the first page of the PDF. */
function drawPdfHeader(
  page: PDFPage,
  chatData: ChatExport,
  textFont: PDFFont,
  boldFont: PDFFont,
  pageWidth: number,
  startY: number,
  pdfDoc?: PDFDocument // Optional pdfDoc for future enhancements
): number {
  let y = startY
  const title = 'WhatsApp Conversation Transcript'
  const titleWidth = boldFont.widthOfTextAtSize(title, 18)

  // Main Title (Centered)
  page.drawText(title, {
    x: pageWidth / 2 - titleWidth / 2,
    y: y,
    size: 18,
    font: boldFont,
    color: PRIMARY_COLOR,
  })
  y -= 30 // Space after title

  // Metadata Section
  const labelX = MARGIN
  const valueX = MARGIN + 130 // Indent values for alignment
  const metaLineHeight = 15

  // Function to draw a metadata line
  const drawMetaLine = (
    label: string,
    value: string,
    valueSize = 10,
    valueFont = textFont
  ) => {
    if (y < MARGIN + metaLineHeight) return // Prevent drawing off page
    page.drawText(label, {
      x: labelX,
      y: y,
      size: 10,
      font: boldFont,
      color: TEXT_COLOR,
    })

    // Wrap value if too long (simple width check)
    const maxValueWidth = pageWidth - valueX - MARGIN
    let linesToDraw = [value] // Default to single line
    if (valueFont.widthOfTextAtSize(value, valueSize) > maxValueWidth) {
      linesToDraw = []
      let currentLine = ''
      const words = value.split(' ')
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word
        if (valueFont.widthOfTextAtSize(testLine, valueSize) <= maxValueWidth) {
          currentLine = testLine
        } else {
          linesToDraw.push(currentLine) // Push the completed line
          currentLine = word // Start new line with the current word
        }
      }
      linesToDraw.push(currentLine) // Push the last line
    }

    linesToDraw.forEach((line, index) => {
      if (y - index * metaLineHeight < MARGIN) return // Check vertical space per line
      page.drawText(line, {
        x: valueX,
        y: y - index * metaLineHeight,
        size: valueSize,
        font: valueFont,
        color: TEXT_COLOR,
      })
    })
    y -= linesToDraw.length * metaLineHeight
  }

  drawMetaLine(
    'Participants:',
    chatData.participants?.join(', ') || 'Unknown',
    10,
    textFont
  )
  drawMetaLine(
    'Generated On:',
    format(new Date(), 'dd MMM yyyy, HH:mm:ss zzz'),
    10,
    textFont
  )
  drawMetaLine(
    'Original Filename:',
    chatData.originalFilename || 'N/A',
    10,
    textFont
  )
  drawMetaLine('File Hash (SHA256):', chatData.fileHash || 'N/A', 8, textFont) // Smaller font for hash

  // Processing Options Summary
  let optionsSummary = 'Default Processing'
  if (chatData.processingOptions) {
    try {
      const opts =
        typeof chatData.processingOptions === 'string'
          ? JSON.parse(chatData.processingOptions)
          : chatData.processingOptions
      const included = []
      if (opts.includeVoiceMessages !== false) included.push('Voice')
      if (opts.includeImages !== false) included.push('Images')
      if (opts.includeAttachments !== false) included.push('Files')
      optionsSummary =
        included.length > 0
          ? `Included: ${included.join(', ')}`
          : 'Text Messages Only'
    } catch (e) {
      console.error('Failed to parse options string for PDF header:', e)
    }
  }
  drawMetaLine('Processing Options:', optionsSummary, 10, textFont)

  y -= 10 // Extra space

  // Add text about media summary page
  const summaryText =
    'See Media Files and Authentication Summary on the Last Page'
  const textY = y - 15 // Position it slightly lower
  page.drawText(summaryText, {
    x: pageWidth - MARGIN - textFont.widthOfTextAtSize(summaryText, 9),
    y: textY,
    size: 9,
    font: textFont,
    color: META_COLOR,
  })
  y -= 25 // Extra space before separator line

  // Draw horizontal line separator
  page.drawLine({
    start: { x: MARGIN, y: y },
    end: { x: pageWidth - MARGIN, y: y },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  })
  y -= 20 // Space before first message/date

  return y // Return the updated Y position
}

/** Draws wrapped text within a bounding box. Returns the final Y position. */
function drawWrappedText(
  page: PDFPage,
  text: string,
  font: PDFFont,
  size: number,
  x: number,
  startY: number,
  maxWidth: number,
  lineHeight: number,
  color: Color
): { lines: string[]; finalY: number } {
  const lines: string[] = []
  let currentY = startY
  text = sanitizeTextForPdf(text)
  const paragraphs = text.split('\n')

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      currentY -= lineHeight
      continue
    } // Handle empty lines
    let remainingText = paragraph
    while (remainingText.length > 0) {
      let line = ''
      let words = remainingText.split(' ')
      let currentLine = ''
      let consumedLength = 0 // Track consumed length for accurate substring

      for (let i = 0; i < words.length; i++) {
        const word = words[i]
        if (!word) {
          consumedLength++
          continue
        } // Handle multiple spaces

        const testLine = currentLine ? `${currentLine} ${word}` : word
        const testWidth = font.widthOfTextAtSize(testLine, size)

        if (testWidth <= maxWidth) {
          currentLine = testLine
          // Update consumed length: length of the line + 1 for the space (if not the first word)
          consumedLength = currentLine.length + (currentLine === word ? 0 : 1)
        } else {
          // Word itself is too long or doesn't fit
          if (!currentLine && word.length > 0) {
            // Word is longer than the line width
            let partialWord = ''
            for (let j = 0; j < word.length; j++) {
              const char = word[j]
              const partialTest = partialWord + char
              if (font.widthOfTextAtSize(partialTest, size) <= maxWidth) {
                partialWord = partialTest
              } else {
                break
              }
            }
            // Ensure progress even if single char is too wide
            if (partialWord.length === 0 && word.length > 0)
              partialWord = word[0]
            currentLine = partialWord
            consumedLength = partialWord.length // Only consumed the partial word length
          }
          // If currentLine has content OR the long word was broken, break inner loop
          break // Stop adding words to this line
        }
      }
      // If after checking all words, currentLine is still empty, it means the first word was too long.
      // We need to handle the case where the loop finished because the line was filled exactly.
      if (currentLine.length === 0 && remainingText.length > 0) {
        //This means the first word itself was too long
        let partialWord = ''
        for (let j = 0; j < remainingText.length; j++) {
          // Check against remainingText directly
          const char = remainingText[j]
          const partialTest = partialWord + char
          if (font.widthOfTextAtSize(partialTest, size) <= maxWidth) {
            partialWord = partialTest
          } else {
            break
          }
        }
        if (partialWord.length === 0 && remainingText.length > 0)
          partialWord = remainingText[0]
        currentLine = partialWord
        consumedLength = partialWord.length
      }

      line = currentLine // The line to draw
      lines.push(line)

      if (currentY - lineHeight < MARGIN) {
        console.warn(
          'PDF Wrap: Page break needed within wrapped text - stopping draw.'
        )
        return { lines, finalY: currentY } // Stop drawing to avoid errors
      }

      page.drawText(line, {
        x,
        y: currentY,
        font,
        size,
        color,
        lineHeight,
      })
      currentY -= lineHeight

      // Update remaining text accurately using consumedLength
      remainingText = remainingText.substring(consumedLength) // Get the rest of the text
    }
  }
  return { lines, finalY: currentY }
}

/** Estimates the vertical height needed for a message. */
function estimateMessageHeight(
  message: Message,
  textFont: PDFFont,
  boldFont: PDFFont,
  size: number,
  maxWidth: number
): number {
  let height = HEADER_LINE_HEIGHT // For timestamp/sender line
  const contentMaxWidth = maxWidth - CONTENT_INDENT

  if (message.type === 'text') {
    const lines = estimateLines(
      message.content || '',
      textFont,
      size,
      contentMaxWidth
    )
    height += lines * CONTENT_LINE_HEIGHT
  } else if (message.type === 'voice') {
    height += CONTENT_LINE_HEIGHT * 1.5 // Link text + padding
  } else if (message.type === 'image' || message.type === 'attachment') {
    height += CONTENT_LINE_HEIGHT // Link text
  } else {
    height += CONTENT_LINE_HEIGHT // Default placeholder
  }
  height += MESSAGE_SPACING // Padding below message
  return height
}

/** Sanitizes text for PDF compatibility. */
function sanitizeTextForPdf(text: string): string {
  const emojiMap: { [key: string]: string } = {
    /* ... (as before) ... */
  }
  let sanitized = text
  for (const [emoji, replacement] of Object.entries(emojiMap)) {
    sanitized = sanitized.replace(new RegExp(emoji, 'g'), replacement)
  }
  // Replace non-WinAnsi characters (basic Latin, Latin-1 Supplement, some symbols)
  // This is a simplified filter, a more robust one might be needed for full WinAnsi compliance
  sanitized = sanitized.replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, '?')
  return sanitized
}

/** Estimates the number of lines required for text wrapping. */
function estimateLines(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number
): number {
  if (!text) return 1 // Assume at least one line
  text = sanitizeTextForPdf(text)
  let totalLines = 0
  const paragraphs = text.split('\n')

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      totalLines++
      continue
    } // Count empty lines
    let remainingText = paragraph
    while (remainingText.length > 0) {
      totalLines++ // Count this line
      let currentLine = ''
      let words = remainingText.split(' ')
      let consumedLength = 0

      for (let i = 0; i < words.length; i++) {
        const word = words[i]
        if (!word) {
          consumedLength++
          continue
        }

        const testLine = currentLine ? `${currentLine} ${word}` : word
        const testWidth = font.widthOfTextAtSize(testLine, size)

        if (testWidth <= maxWidth) {
          currentLine = testLine
          consumedLength = currentLine.length + (currentLine === word ? 0 : 1)
        } else {
          if (!currentLine && word.length > 0) {
            // Word is longer than the line width
            let partialWord = ''
            for (let j = 0; j < word.length; j++) {
              const char = word[j]
              const partialTest = partialWord + char
              if (font.widthOfTextAtSize(partialTest, size) <= maxWidth)
                partialWord = partialTest
              else break
            }
            if (partialWord.length === 0 && word.length > 0)
              partialWord = word[0]
            currentLine = partialWord
            consumedLength = partialWord.length
          }
          break // Stop adding words
        }
      }

      if (currentLine.length === 0 && remainingText.length > 0) {
        // First word was too long
        let partialWord = ''
        for (let j = 0; j < remainingText.length; j++) {
          const char = remainingText[j]
          const partialTest = partialWord + char
          if (font.widthOfTextAtSize(partialTest, size) <= maxWidth)
            partialWord = partialTest
          else break
        }
        if (partialWord.length === 0 && remainingText.length > 0)
          partialWord = remainingText[0]
        consumedLength = partialWord.length
      }

      remainingText = remainingText.substring(consumedLength)
    }
  }
  return Math.max(1, totalLines) // Ensure at least 1 line
}

/** Adds page number to the bottom center of a page. */
function addPageNumber(
  page: PDFPage,
  currentPageNum: number,
  totalPages: number,
  font: PDFFont,
  margin: number
) {
  const { width } = page.getSize()
  const text = `Page ${currentPageNum} of ${totalPages}`
  const textSize = 8
  const textWidth = font.widthOfTextAtSize(text, textSize)
  const textHeight = font.heightAtSize(textSize)

  page.drawText(text, {
    x: width / 2 - textWidth / 2,
    y: margin / 2 - textHeight / 2, // Position in bottom margin
    size: textSize,
    font: font,
    color: META_COLOR,
  })
}

/** Formats duration from seconds to MM:SS format. */
function formatDuration(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '0:00'
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.floor(seconds % 60)
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
}

/**
 * Draws a clickable link for media attachments (images, PDFs, and other files).
 * MODIFIED TO PRIORITIZE message.mediaUrl if it's a proxy URL.
 */
async function drawMediaLink(
  page: PDFPage,
  pdfDoc: PDFDocument,
  message: Message,
  mediaFile: MediaFile | undefined, // Associated media file from DB/R2 (for fallback/summary)
  textFont: PDFFont,
  boldFont: PDFFont,
  x: number,
  y: number,
  color: Color,
  chatId?: number // Optional: For context in logging
): Promise<number> {
  // Determine the media type display label
  let mediaTypeLabel = 'File'
  let icon = '' // Safe fallback, emojis unreliable

  if (message.type === 'image') {
    mediaTypeLabel = 'Image'
  } else if (message.type === 'attachment') {
    const ext = message.mediaUrl
      ? path.extname(message.mediaUrl).toLowerCase()
      : ''
    if (ext === '.pdf') mediaTypeLabel = 'PDF'
    else if (['.doc', '.docx'].includes(ext)) mediaTypeLabel = 'Document'
    else if (['.xls', '.xlsx'].includes(ext)) mediaTypeLabel = 'Spreadsheet'
    else if (['.zip', '.rar', '.7z'].includes(ext)) mediaTypeLabel = 'Archive'
    else if (['.mp4', '.avi', '.mov'].includes(ext)) mediaTypeLabel = 'Video'
  }

  // Determine filename safely
  let mediaFilename = 'unknown_file'
  if (mediaFile?.originalName) {
    // Prefer original name from MediaFile if available
    mediaFilename = mediaFile.originalName
  } else if (message.mediaUrl) {
    try {
      // Fallback to parsing URL
      const urlParts = message.mediaUrl.split('/')
      // Get last part, remove query params if any
      mediaFilename = (urlParts[urlParts.length - 1] || 'unknown_file').split(
        '?'
      )[0]
      // Basic decode
      mediaFilename = decodeURIComponent(mediaFilename)
    } catch (e) {
      console.warn('Error parsing mediaFilename from URL:', message.mediaUrl, e)
      mediaFilename = `attached_${mediaTypeLabel.toLowerCase()}`
    }
  }

  const safeIcon = '' // Use empty string as PDF may not support Unicode emojis well
  const linkText = `${safeIcon} View ${mediaTypeLabel}: ${mediaFilename}`
  const linkFontSize = 10
  const linkLineHeight = CONTENT_LINE_HEIGHT * 1.2

  // --- Generate Target URL ---
  const appBaseUrl = getAppBaseUrl()
  let targetUrl = ''

  // **MODIFIED LOGIC**: Prioritize message.mediaUrl if it's already a proxy URL
  if (message.mediaUrl && message.mediaUrl.includes('/api/media/proxy/')) {
    targetUrl = message.mediaUrl // Assume it's the correct, absolute proxy URL
    console.log(
      `PDF (Chat ${chatId ?? 'N/A'}): Using proxy URL from message ${
        message.id ?? 'N/A'
      } -> ${targetUrl}`
    )
  } else if (mediaFile && mediaFile.id) {
    // Fallback: Construct proxy URL from mediaFile ID if message.mediaUrl wasn't a proxy URL
    targetUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`
    console.warn(
      `PDF (Chat ${chatId ?? 'N/A'}): Message ${
        message.id ?? 'N/A'
      } mediaUrl (${
        message.mediaUrl
      }) was not a proxy URL. Using constructed proxy URL: ${targetUrl}`
    )
  } else {
    console.error(
      `PDF (Chat ${chatId ?? 'N/A'}): Cannot generate URL for ${
        message.type
      } message ${message.id ?? 'N/A'} - No valid mediaUrl or MediaFile found.`
    )
    targetUrl = '#' // Placeholder URL
  }

  // --- Draw Link Text ---
  page.drawText(linkText, {
    x: x,
    y: y,
    font: boldFont,
    size: linkFontSize,
    color: color,
    lineHeight: linkLineHeight,
  })

  // --- Create Clickable Link Annotation ---
  if (targetUrl && targetUrl !== '#') {
    const textWidth = boldFont.widthOfTextAtSize(linkText, linkFontSize)
    const linkRectHeight = linkLineHeight * 0.8 // Clickable area height

    try {
      const linkAnnotationRef = pdfDoc.context.register(
        pdfDoc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Link'),
          Rect: [x, y, x + textWidth, y + linkRectHeight], // x, y, x+width, y+height
          Border: [0, 0, 0], // No visible border
          A: {
            Type: PDFName.of('Action'),
            S: PDFName.of('URI'),
            URI: PDFString.of(targetUrl),
          },
        })
      )
      let annots = page.node.lookup(PDFName.of('Annots'), PDFArray)
      if (!annots) {
        annots = pdfDoc.context.obj([])
        page.node.set(PDFName.of('Annots'), annots)
      }
      annots.push(linkAnnotationRef)
    } catch (linkError) {
      console.error(
        `PDF: Failed to create link annotation for message ${
          message.id ?? 'N/A'
        }`,
        linkError
      )
    }
  }

  return y - linkLineHeight
}

/**
 * Draws a clickable link for voice messages.
 * MODIFIED TO PRIORITIZE message.mediaUrl if it's a proxy URL.
 */
async function drawVoiceMessageLink(
  page: PDFPage,
  pdfDoc: PDFDocument,
  message: Message,
  mediaFile: MediaFile | undefined, // Associated media file from DB/R2 (for fallback/summary)
  textFont: PDFFont,
  boldFont: PDFFont,
  x: number,
  y: number,
  color: Color,
  chatId?: number // Optional: For context in logging
): Promise<number> {
  const duration = message.duration || 0
  const formattedDuration = formatDuration(duration)
  // Determine filename safely
  let mediaFilename = 'voice_message.opus'
  if (mediaFile?.originalName) {
    // Prefer original name
    mediaFilename = mediaFile.originalName
  } else if (message.mediaUrl) {
    try {
      // Fallback to parsing URL
      const urlParts = message.mediaUrl.split('/')
      mediaFilename = (
        urlParts[urlParts.length - 1] || 'voice_message.opus'
      ).split('?')[0]
      mediaFilename = decodeURIComponent(mediaFilename)
    } catch (e) {
      console.warn(
        'Error parsing mediaFilename from voice URL:',
        message.mediaUrl,
        e
      )
    }
  }

  const playSymbol = '>' // Safe symbol for PDF standard fonts
  const linkText = `${playSymbol} Play Voice Message (${mediaFilename}, ${formattedDuration})`
  const linkFontSize = 10
  const linkLineHeight = CONTENT_LINE_HEIGHT * 1.2

  // --- Generate Target URL ---
  const appBaseUrl = getAppBaseUrl()
  let targetUrl = ''

  // **MODIFIED LOGIC**: Prioritize message.mediaUrl if it's already a proxy URL
  if (message.mediaUrl && message.mediaUrl.includes('/api/media/proxy/')) {
    targetUrl = message.mediaUrl
    console.log(
      `PDF (Chat ${chatId ?? 'N/A'}): Using proxy URL from voice message ${
        message.id ?? 'N/A'
      } -> ${targetUrl}`
    )
  } else if (mediaFile && mediaFile.id) {
    // Fallback: Construct proxy URL from mediaFile ID
    targetUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`
    console.warn(
      `PDF (Chat ${chatId ?? 'N/A'}): Voice message ${
        message.id ?? 'N/A'
      } mediaUrl (${
        message.mediaUrl
      }) was not a proxy URL. Using constructed proxy URL: ${targetUrl}`
    )
  } else {
    console.error(
      `PDF (Chat ${chatId ?? 'N/A'}): Cannot generate URL for voice message ${
        message.id ?? 'N/A'
      } - No valid mediaUrl or MediaFile found.`
    )
    targetUrl = '#'
  }

  // --- Draw Link Text ---
  page.drawText(linkText, {
    x: x,
    y: y,
    font: boldFont,
    size: linkFontSize,
    color: color,
    lineHeight: linkLineHeight,
  })

  // --- Create Clickable Link Annotation ---
  if (targetUrl && targetUrl !== '#') {
    const textWidth = boldFont.widthOfTextAtSize(linkText, linkFontSize)
    const linkRectHeight = linkLineHeight * 0.8

    try {
      const linkAnnotationRef = pdfDoc.context.register(
        pdfDoc.context.obj({
          Type: PDFName.of('Annot'),
          Subtype: PDFName.of('Link'),
          Rect: [x, y, x + textWidth, y + linkRectHeight],
          Border: [0, 0, 0],
          A: {
            Type: PDFName.of('Action'),
            S: PDFName.of('URI'),
            URI: PDFString.of(targetUrl),
          },
        })
      )
      let annots = page.node.lookup(PDFName.of('Annots'), PDFArray)
      if (!annots) {
        annots = pdfDoc.context.obj([])
        page.node.set(PDFName.of('Annots'), annots)
      }
      annots.push(linkAnnotationRef)
    } catch (linkError) {
      console.error(
        `PDF: Failed to create link annotation for voice message ${
          message.id ?? 'N/A'
        }`,
        linkError
      )
    }
  }

  return y - linkLineHeight
}
