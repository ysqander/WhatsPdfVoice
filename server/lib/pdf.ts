import { ChatExport, Message, MediaFile } from "@shared/types";
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
    drawText, // Keep this if used by helpers, though pdf-lib v1.17+ uses page.drawText
    PageSizes,
} from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { format } from "date-fns";
import { v4 as uuidv4 } from "uuid";
// Removed puppeteer import
// Removed getSignedR2Url as proxy URL generation is handled differently now
import { storage } from "../storage"; // Assuming storage can fetch media files

// --- Constants ---
const MARGIN = 50;
const PRIMARY_COLOR = rgb(0.17, 0.24, 0.31); // #2C3E50
const SECONDARY_COLOR = rgb(0.2, 0.29, 0.37); // #34495E
const TEXT_COLOR = rgb(0.2, 0.2, 0.2); // #333333
const LINK_COLOR = rgb(0.1, 0.4, 0.7); // Darker blue for links
const META_COLOR = rgb(0.5, 0.5, 0.5); // Grey for less important text
const HEADER_LINE_HEIGHT = 15;
const CONTENT_LINE_HEIGHT = 15;
const MESSAGE_SPACING = 10; // Vertical space between messages
const CONTENT_INDENT = 15; // Indentation for message content relative to header

// Create PDF directory if it doesn't exist
const pdfDir = path.join(os.tmpdir(), "whatspdf", "pdfs");
if (!fs.existsSync(pdfDir)) {
    fs.mkdirSync(pdfDir, { recursive: true });
}

// --- Main Exported Function ---

/**
 * Generates a PDF transcript from WhatsApp chat data using pdf-lib.
 * @param chatData The processed chat export data.
 * @returns The local path to the generated PDF file.
 */
export async function generatePdf(chatData: ChatExport): Promise<string> {
    console.log("Starting PDF generation with pdf-lib...");
    if (!chatData || !chatData.messages) {
        throw new Error("Invalid chat data provided for PDF generation.");
    }
    // Ensure chatData has an ID for fetching media files
    if (!chatData.id) {
        console.error(
            "ChatExport ID is missing, cannot fetch media files for proxy links.",
        );
        // Decide if you want to throw an error or proceed without proxy links
        // throw new Error("ChatExport ID is required for generating media proxy links.");
    }

    const { pdfPath } = await generatePdfWithPdfLib(chatData);
    return pdfPath;
}

// --- PDF Generation Logic (using pdf-lib) ---

async function generatePdfWithPdfLib(
    chatData: ChatExport,
): Promise<{ pdfPath: string; pdfId: string }> {
    console.log(
        `[PDF DEBUG] generatePdfWithPdfLib called for chatData.id: ${chatData.id}`,
    );
    if (!chatData.id) {
        console.error(
            "[PDF DEBUG] chatData.id is MISSING or invalid when entering generatePdfWithPdfLib!",
        );
        // Consider throwing an error here if an ID is mandatory for the summary
        throw new Error(
            "Cannot generate PDF summary without a valid chatData.id",
        );
    }

    const pdfDoc = await PDFDocument.create();

    // Add metadata
    pdfDoc.setTitle(`WhatsApp Chat - ${format(new Date(), "yyyy-MM-dd")}`);
    pdfDoc.setAuthor("WhatsPDF Voice");
    pdfDoc.setCreator("WhatsPDF Voice");
    pdfDoc.setProducer("WhatsPDF Voice");
    pdfDoc.setSubject(
        `WhatsApp Chat Export: ${chatData.originalFilename || "Unknown File"}`,
    );

    // Embed fonts
    const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
    const timesRomanBoldFont = await pdfDoc.embedFont(
        StandardFonts.TimesRomanBold,
    );
    // const helveticaFont = await pdfDoc.embedFont(StandardFonts.Helvetica); // Example alternative

    // --- Fetch Media File Data (Crucial for Proxy Links) ---
    let mediaFilesMap = new Map<string, MediaFile>(); // Map ID string -> MediaFile
    let messageToMediaMap = new Map<string, MediaFile>(); // Map to help find files by message ID

    if (chatData.id) {
        try {
            console.log(
                `[PDF DEBUG] Attempting storage.getMediaFilesByChat with ID: ${chatData.id}`,
            );
            const mediaFiles = await storage.getMediaFilesByChat(chatData.id);
            console.log(
                `[PDF DEBUG] storage.getMediaFilesByChat returned ${mediaFiles.length} files.`,
            );
            if (mediaFiles.length > 0) {
                console.log(
                    `[PDF DEBUG] First media file sample: ID=${mediaFiles[0]?.id}, type=${mediaFiles[0]?.type}, messageId=${mediaFiles[0]?.messageId}, chatExportId=${mediaFiles[0]?.chatExportId}`,
                ); // Log chatExportId if available on MediaFile type
            }

            // First log all media files for debugging
            mediaFiles.forEach((file, index) => {
                console.log(
                    `PDF: Media file ${index + 1}/${mediaFiles.length}: ID=${file.id}, type=${file.type}, messageId=${file.messageId}`,
                );
            });

            // Store media files both by messageId and by their own id for complete access
            // Also maintain a separate map strictly by message ID
            mediaFiles.forEach((file) => {
                // Always store by the file's own ID
                if (file.id) {
                    mediaFilesMap.set(file.id, file);
                }

                // Also store by message ID (if present) in both maps
                if (file.messageId !== undefined && file.messageId !== null) {
                    // Store in main map with messageId as string key
                    const messageIdStr = String(file.messageId);
                    mediaFilesMap.set(`msg_${messageIdStr}`, file);

                    // Store in dedicated message->media lookup map
                    messageToMediaMap.set(messageIdStr, file);

                    console.log(
                        `PDF: Mapped messageId ${messageIdStr} to file ${file.id}`,
                    );
                }
            });

            console.log(
                `PDF: Mapped ${mediaFilesMap.size} media file records (${messageToMediaMap.size} by message ID) for chat ${chatData.id}`,
            );
        } catch (error) {
            console.error(
                `PDF: Failed to fetch media files for chat ${chatData.id}. Proxy links may not work.`,
                error,
            );
        }
    } else {
        console.warn(
            "PDF: ChatExport ID missing, skipping media file fetch. Proxy links will use original URLs.",
        );
    }

    // --- Page Setup ---
    let currentPage = pdfDoc.addPage(PageSizes.A4);
    const { width, height } = currentPage.getSize();
    let y = height - MARGIN; // Current Y position, starts at top margin
    let currentPageNumber = 1; // Track current page number

    // --- Draw Header on First Page ---
    y = drawPdfHeader(
        currentPage,
        chatData,
        timesRomanFont,
        timesRomanBoldFont,
        width,
        y,
        pdfDoc, // Pass the pdfDoc for link annotations
    );

    // --- Group Messages by Date ---
    const messagesByDate: Record<string, Message[]> = {};
    // Ensure messages are sorted by timestamp (should be done by parser, but double-check)
    chatData.messages.sort(
        (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    for (const message of chatData.messages) {
        const date = format(new Date(message.timestamp), "dd MMMM yyyy"); // e.g., 21 October 2023
        if (!messagesByDate[date]) {
            messagesByDate[date] = [];
        }
        messagesByDate[date].push(message);
    }

    // --- Process and Draw Messages ---
    const dateEntries = Object.entries(messagesByDate);
    for (let dateIndex = 0; dateIndex < dateEntries.length; dateIndex++) {
        const [date, messages] = dateEntries[dateIndex];

        // --- Draw Date Separator ---
        const dateSeparatorHeight = 30; // Height needed for date text + padding
        if (y < MARGIN + dateSeparatorHeight) {
            // Not enough space for the date separator, add new page
            currentPage = pdfDoc.addPage(PageSizes.A4);
            currentPageNumber++;
            y = height - MARGIN; // Reset Y
        }

        currentPage.drawText(date, {
            x: width / 2 - timesRomanFont.widthOfTextAtSize(date, 10) / 2, // Center align
            y: y,
            size: 10,
            font: timesRomanFont,
            color: META_COLOR,
        });
        y -= dateSeparatorHeight; // Move down after drawing date

        // --- Draw Messages for the Current Date ---
        for (
            let messageIndex = 0;
            messageIndex < messages.length;
            messageIndex++
        ) {
            const message = messages[messageIndex];

            // --- Estimate Height Needed for the Message ---
            const estimatedHeight = estimateMessageHeight(
                message,
                timesRomanFont,
                timesRomanBoldFont,
                10,
                width - MARGIN * 2,
            );

            // --- Check for Page Break ---
            if (y < MARGIN + estimatedHeight) {
                currentPage = pdfDoc.addPage(PageSizes.A4);
                currentPageNumber++;
                y = height - MARGIN; // Reset Y for new page
            }

            // --- Draw Message Header (Timestamp, Sender) ---
            const timestamp = format(new Date(message.timestamp), "HH:mm:ss"); // Precise time
            const sender = message.sender || "Unknown Sender";
            const senderColor =
                message.sender === chatData.participants?.[0]
                    ? PRIMARY_COLOR
                    : SECONDARY_COLOR;
            const headerText = `[${timestamp}] ${sender}:`;

            currentPage.drawText(headerText, {
                x: MARGIN,
                y: y,
                size: 10,
                font: timesRomanBoldFont,
                color: senderColor,
                lineHeight: HEADER_LINE_HEIGHT,
            });
            y -= HEADER_LINE_HEIGHT; // Move down after header

            // --- Draw Message Content (Text, Links, Placeholders) ---
            const contentX = MARGIN + CONTENT_INDENT;
            const contentMaxWidth = width - contentX - MARGIN;

            let contentEndY = y; // Keep track of where content drawing ends

            if (message.type === "text") {
                const { finalY } = drawWrappedText(
                    currentPage,
                    message.content || "", // Handle potentially empty content
                    timesRomanFont,
                    10,
                    contentX,
                    y,
                    contentMaxWidth,
                    CONTENT_LINE_HEIGHT,
                    TEXT_COLOR,
                );
                contentEndY = finalY;
            } else if (message.type === "voice" && message.mediaUrl) {
                // Try multiple ways to find the media file for this message
                let mediaFile;

                // 1. Try by direct message ID if available
                if (message.id) {
                    const messageIdStr = String(message.id);
                    // Try direct ID match
                    mediaFile = mediaFilesMap.get(messageIdStr);
                    // Try with msg_ prefix
                    if (!mediaFile)
                        mediaFile = mediaFilesMap.get(`msg_${messageIdStr}`);
                    // Try from dedicated message map
                    if (!mediaFile)
                        mediaFile = messageToMediaMap.get(messageIdStr);
                }

                // 2. Log what we found for debugging
                if (mediaFile) {
                    console.log(
                        `PDF: Found media file ${mediaFile.id} for voice message ${message.id}`,
                    );
                } else {
                    console.log(
                        `PDF: No media file found for voice message ${message.id}`,
                    );
                }

                contentEndY = await drawVoiceMessageLink(
                    currentPage,
                    pdfDoc,
                    message,
                    mediaFile,
                    timesRomanFont,
                    timesRomanBoldFont,
                    contentX,
                    y,
                    LINK_COLOR,
                    chatData.id,
                );
            } else if (message.type === "image" && message.mediaUrl) {
                // Try multiple ways to find the media file for this message
                let mediaFile;

                // 1. Try by direct message ID if available
                if (message.id) {
                    const messageIdStr = String(message.id);
                    // Try direct ID match
                    mediaFile = mediaFilesMap.get(messageIdStr);
                    // Try with msg_ prefix
                    if (!mediaFile)
                        mediaFile = mediaFilesMap.get(`msg_${messageIdStr}`);
                    // Try from dedicated message map
                    if (!mediaFile)
                        mediaFile = messageToMediaMap.get(messageIdStr);
                }

                // 2. Log what we found for debugging
                if (mediaFile) {
                    console.log(
                        `PDF: Found media file ${mediaFile.id} for image message ${message.id}`,
                    );
                } else {
                    console.log(
                        `PDF: No media file found for image message ${message.id}`,
                    );
                }

                contentEndY = await drawMediaLink(
                    currentPage,
                    pdfDoc,
                    message,
                    mediaFile,
                    timesRomanFont,
                    timesRomanBoldFont,
                    contentX,
                    y,
                    LINK_COLOR,
                    chatData.id,
                );
            } else if (message.type === "attachment" && message.mediaUrl) {
                // Try multiple ways to find the media file for this message
                let mediaFile;

                // 1. Try by direct message ID if available
                if (message.id) {
                    const messageIdStr = String(message.id);
                    // Try direct ID match
                    mediaFile = mediaFilesMap.get(messageIdStr);
                    // Try with msg_ prefix
                    if (!mediaFile)
                        mediaFile = mediaFilesMap.get(`msg_${messageIdStr}`);
                    // Try from dedicated message map
                    if (!mediaFile)
                        mediaFile = messageToMediaMap.get(messageIdStr);
                }

                // 2. Log what we found for debugging
                if (mediaFile) {
                    console.log(
                        `PDF: Found media file ${mediaFile.id} for attachment message ${message.id}`,
                    );
                } else {
                    console.log(
                        `PDF: No media file found for attachment message ${message.id}`,
                    );
                }

                contentEndY = await drawMediaLink(
                    currentPage,
                    pdfDoc,
                    message,
                    mediaFile,
                    timesRomanFont,
                    timesRomanBoldFont,
                    contentX,
                    y,
                    LINK_COLOR,
                    chatData.id,
                );
            } else {
                // Handle unknown or unsupported types
                const unknownText = `[Unsupported Message Type: ${message.type || "Unknown"}]`;
                currentPage.drawText(unknownText, {
                    x: contentX,
                    y: y,
                    size: 9,
                    font: timesRomanFont,
                    color: rgb(0.6, 0, 0),
                    lineHeight: CONTENT_LINE_HEIGHT,
                });
                contentEndY = y - CONTENT_LINE_HEIGHT;
            }

            // Update Y position to be below the drawn content + spacing
            y = contentEndY - MESSAGE_SPACING;
        } // End loop through messages for the date
    } // End loop through dates

    // --- Add Media Files Summary Page ---
    // Add a page at the end with file hash information
    const summaryPage = pdfDoc.addPage(PageSizes.A4);
    let summaryY = height - MARGIN;

    // Draw heading
    summaryPage.drawText("MEDIA FILES AND AUTHENTICATION SUMMARY", {
        x:
            width / 2 -
            timesRomanBoldFont.widthOfTextAtSize(
                "MEDIA FILES AND AUTHENTICATION SUMMARY",
                14,
            ) /
                2,
        y: summaryY,
        size: 14,
        font: timesRomanBoldFont,
        color: PRIMARY_COLOR,
    });
    summaryY -= 30;

    // Draw explanatory text
    summaryPage.drawText(
        "This page provides a summary of all media files referenced in this transcript for Rule 902(14) compliance.",
        {
            x: MARGIN,
            y: summaryY,
            size: 10,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );
    summaryY -= 20;

    summaryPage.drawText(
        "Media files are referenced by their unique identifier in the transcript links. These identifiers",
        {
            x: MARGIN,
            y: summaryY,
            size: 10,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );
    summaryY -= 15;

    summaryPage.drawText(
        "correspond to filenames in the attachments directory of the evidence package.",
        {
            x: MARGIN,
            y: summaryY,
            size: 10,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );
    summaryY -= 30;

    // Draw table headers - added column for hash value
    const colWidths = [200, 200, 70, 0]; // Last column (hash) will be on next line
    const colX = [
        MARGIN,
        MARGIN + colWidths[0],
        MARGIN + colWidths[0] + colWidths[1],
    ];

    summaryPage.drawText("MEDIA ID", {
        x: colX[0],
        y: summaryY,
        size: 10,
        font: timesRomanBoldFont,
        color: PRIMARY_COLOR,
    });

    summaryPage.drawText("ORIGINAL FILENAME", {
        x: colX[1],
        y: summaryY,
        size: 10,
        font: timesRomanBoldFont,
        color: PRIMARY_COLOR,
    });

    summaryPage.drawText("TYPE", {
        x: colX[2],
        y: summaryY,
        size: 10,
        font: timesRomanBoldFont,
        color: PRIMARY_COLOR,
    });

    summaryY -= 15;

    // Draw horizontal line
    summaryPage.drawLine({
        start: { x: MARGIN, y: summaryY + 5 },
        end: { x: width - MARGIN, y: summaryY + 5 },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
    });

    summaryY -= 15;

    // Draw media file entries (up to what fits on the page)
    const mediaFilesArray = Array.from(mediaFilesMap.values());

    // Log detailed information about the media files map for debugging
    console.log(`PDF: Media files map size: ${mediaFilesMap.size}`);
    console.log(`PDF: Media files array length: ${mediaFilesArray.length}`);

    // Count unique files to avoid duplicates
    const uniqueMediaFiles = new Map<string, MediaFile>();
    mediaFilesArray.forEach((file) => {
        if (file && file.id) {
            uniqueMediaFiles.set(file.id, file);
        }
    });
    console.log(`PDF: Unique media files count: ${uniqueMediaFiles.size}`);

    // Use the deduplicated list for display
    const displayMediaFiles = Array.from(uniqueMediaFiles.values());
    const entriesPerPage = 25; // Approximate, adjust based on actual space needs
    console.log(
        `[PDF DEBUG] Summary Page: displayMediaFiles count: ${displayMediaFiles.length}`,
    );
    if (displayMediaFiles.length > 0) {
        console.log(
            `[PDF DEBUG] Summary Page: First display file sample: ID=${displayMediaFiles[0]?.id}, Name=${displayMediaFiles[0]?.originalName}, Type=${displayMediaFiles[0]?.type}`,
        );
    } else {
        console.log(
            `[PDF DEBUG] Summary Page: displayMediaFiles is empty. mediaFilesMap size was ${mediaFilesMap.size}. uniqueMediaFiles size was ${uniqueMediaFiles.size}`,
        );
    }
    // If we have no media files, show a message
    if (displayMediaFiles.length === 0) {
        console.log("PDF: No media files to display in summary table");
        summaryPage.drawText("No media files are present in this transcript.", {
            x: MARGIN,
            y: summaryY,
            size: 10,
            font: timesRomanFont,
            color: TEXT_COLOR,
        });
        summaryY -= 20;
    } else {
        console.log(
            `PDF: Displaying ${displayMediaFiles.length} media files in summary table`,
        );
        // Draw media file entries
        for (
            let i = 0;
            i < Math.min(displayMediaFiles.length, entriesPerPage);
            i++
        ) {
            const file = displayMediaFiles[i];
            if (!file || !file.id) continue;

            // Truncate filename if too long
            const origFilename =
                file.originalName || path.basename(file.key || "unknown");
            const truncatedFilename =
                origFilename.length > 40
                    ? origFilename.substring(0, 37) + "..."
                    : origFilename;

            // Use full media ID as requested (no truncation)
            const mediaId = file.id;
            
            // Determine more descriptive media type
            let displayType = file.type || "unknown";
            
            // If it's an attachment with a PDF extension, show "pdf" instead
            if (file.type === "attachment") {
                const fileExtension = path.extname(file.key || origFilename).toLowerCase();
                if (fileExtension === ".pdf") {
                    displayType = "pdf";
                } else {
                    displayType = "other";
                }
            }
            
            // Draw media ID
            summaryPage.drawText(mediaId, {
                x: colX[0],
                y: summaryY,
                size: 8,  // Smaller font size to fit full ID
                font: timesRomanFont,
                color: TEXT_COLOR,
            });

            // Draw original filename
            summaryPage.drawText(truncatedFilename, {
                x: colX[1],
                y: summaryY,
                size: 9,
                font: timesRomanFont,
                color: TEXT_COLOR,
            });

            // Draw media type
            summaryPage.drawText(displayType, {
                x: colX[2],
                y: summaryY,
                size: 9,
                font: timesRomanFont,
                color: TEXT_COLOR,
            });

            summaryY -= 15;
            
            // Add SHA-256 hash on the next line with some indentation
            const hashLabel = "SHA-256: ";
            
            // Calculate hash for the file if possible or use existing
            let fileHash = "Not available offline. See manifest.json in the evidence package.";
            
            // If we have a hash already in the file object, use it
            if (file.fileHash) {
                fileHash = file.fileHash;
            } 
            // Try to calculate the hash from the actual file if it exists
            else {
                try {
                    // First determine where the file might be
                    // Options: 
                    // 1. Media dir with chat ID: /tmp/whatspdf/media/{chatId}/{filename}
                    // 2. Media dir directly: /tmp/whatspdf/media/{filename}
                    let mediaFilePath = '';
                    let fileExists = false;
                    
                    // Try the most likely paths for the file
                    if (file.key) {
                        // If there's a file.key with path info
                        const baseName = path.basename(file.key);
                        
                        // Try with chatId subdirectory
                        if (chatData.id) {
                            const pathWithChatId = path.join(os.tmpdir(), 'whatspdf', 'media', 
                                chatData.id.toString(), baseName);
                            if (fs.existsSync(pathWithChatId)) {
                                mediaFilePath = pathWithChatId;
                                fileExists = true;
                            }
                        }
                        
                        // If not found, try main media directory
                        if (!fileExists) {
                            const pathWithoutChatId = path.join(os.tmpdir(), 'whatspdf', 'media', baseName);
                            if (fs.existsSync(pathWithoutChatId)) {
                                mediaFilePath = pathWithoutChatId;
                                fileExists = true;
                            }
                        }
                        
                        // If file exists, calculate its hash
                        if (fileExists) {
                            const fileBuffer = fs.readFileSync(mediaFilePath);
                            const hash = crypto.createHash('sha256');
                            hash.update(fileBuffer);
                            fileHash = hash.digest('hex');
                            
                            // Save hash to the file object for future reference
                            file.fileHash = fileHash;
                            
                            console.log(`PDF: Calculated SHA-256 hash for ${path.basename(mediaFilePath)}: ${fileHash.substring(0, 8)}...`);
                        } else {
                            fileHash = `[Available in evidence package manifest.json]`;
                        }
                    } else if (file.originalName) {
                        // If key isn't available but original name is
                        // Try with chatId subdirectory
                        if (chatData.id) {
                            const pathWithChatId = path.join(os.tmpdir(), 'whatspdf', 'media', 
                                chatData.id.toString(), file.originalName);
                            if (fs.existsSync(pathWithChatId)) {
                                mediaFilePath = pathWithChatId;
                                fileExists = true;
                            }
                        }
                        
                        // If not found, try main media directory
                        if (!fileExists) {
                            const pathWithoutChatId = path.join(os.tmpdir(), 'whatspdf', 'media', file.originalName);
                            if (fs.existsSync(pathWithoutChatId)) {
                                mediaFilePath = pathWithoutChatId;
                                fileExists = true;
                            }
                        }
                        
                        // If file exists, calculate its hash
                        if (fileExists) {
                            const fileBuffer = fs.readFileSync(mediaFilePath);
                            const hash = crypto.createHash('sha256');
                            hash.update(fileBuffer);
                            fileHash = hash.digest('hex');
                            
                            // Save hash to the file object for future reference
                            file.fileHash = fileHash;
                            
                            console.log(`PDF: Calculated SHA-256 hash for ${file.originalName}: ${fileHash.substring(0, 8)}...`);
                        } else {
                            fileHash = `[Available in evidence package manifest.json]`;
                        }
                    }
                } catch (err) {
                    console.error('Error calculating file hash:', err);
                    fileHash = `[Available in evidence package manifest.json]`;
                }
            }
            
            summaryPage.drawText(hashLabel, {
                x: MARGIN + 20, // Indent the hash line
                y: summaryY,
                size: 7,
                font: timesRomanBoldFont,
                color: TEXT_COLOR,
            });
            
            // Draw actual hash value in a smaller font
            summaryPage.drawText(fileHash, {
                x: MARGIN + 20 + timesRomanBoldFont.widthOfTextAtSize(hashLabel, 7),
                y: summaryY,
                size: 7,
                font: timesRomanFont,
                color: TEXT_COLOR,
            });
            
            summaryY -= 10; // Add extra space after the hash

            // Add a thin separator line
            if (i < Math.min(displayMediaFiles.length, entriesPerPage) - 1) {
                summaryPage.drawLine({
                    start: { x: MARGIN, y: summaryY + 7 },
                    end: { x: width - MARGIN, y: summaryY + 7 },
                    thickness: 0.5,
                    color: rgb(0.9, 0.9, 0.9),
                });
                summaryY -= 5;
            }
        }
    }

    // Add legal text at bottom
    summaryY = Math.min(summaryY, 150); // Ensure enough space at bottom

    summaryPage.drawText("LEGAL AUTHENTICATION", {
        x: MARGIN,
        y: summaryY,
        size: 12,
        font: timesRomanBoldFont,
        color: PRIMARY_COLOR,
    });
    summaryY -= 20;

    summaryPage.drawText(
        "This transcript and its associated media files have been prepared in accordance with",
        {
            x: MARGIN,
            y: summaryY,
            size: 9,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );
    summaryY -= 15;

    summaryPage.drawText(
        "Federal Rule of Evidence 902(14), which provides for self-authentication of electronic evidence.",
        {
            x: MARGIN,
            y: summaryY,
            size: 9,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );
    summaryY -= 15;

    summaryPage.drawText(
        "The included manifest.json file contains SHA-256 cryptographic hashes of all files in this package.",
        {
            x: MARGIN,
            y: summaryY,
            size: 9,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );
    summaryY -= 15;

    summaryPage.drawText(
        "These hashes can be independently verified to confirm file integrity without expert testimony.",
        {
            x: MARGIN,
            y: summaryY,
            size: 9,
            font: timesRomanFont,
            color: TEXT_COLOR,
        },
    );

    // --- Add Page Numbers to All Pages ---
    const totalPages = pdfDoc.getPageCount();
    for (let i = 0; i < totalPages; i++) {
        const page = pdfDoc.getPage(i);
        addPageNumber(page, i + 1, totalPages, timesRomanFont, MARGIN);
    }

    // --- Save PDF ---
    console.log("Saving PDF document...");
    const pdfBytes = await pdfDoc.save();
    const pdfId = uuidv4();
    const pdfPath = path.join(pdfDir, `${pdfId}.pdf`);

    try {
        fs.writeFileSync(pdfPath, pdfBytes);
        console.log("PDF file written successfully to:", pdfPath);
        console.log("PDF details:", { pdfId, size: pdfBytes.length });
    } catch (error: any) {
        console.error("Error writing PDF file:", error);
        throw new Error(
            `Failed to write PDF file: ${error.message || String(error)}`,
        );
    }

    return { pdfPath, pdfId };
}

// --- Helper Functions ---

/**
 * Draws the main header on the first page of the PDF.
 */
function drawPdfHeader(
    page: PDFPage,
    chatData: ChatExport,
    textFont: PDFFont,
    boldFont: PDFFont,
    pageWidth: number,
    startY: number,
    pdfDoc?: PDFDocument, // Make pdfDoc optional for backward compatibility
): number {
    let y = startY;
    const title = "WhatsApp Conversation Transcript";
    const titleWidth = boldFont.widthOfTextAtSize(title, 18);

    // Main Title (Centered)
    page.drawText(title, {
        x: pageWidth / 2 - titleWidth / 2,
        y: y,
        size: 18,
        font: boldFont,
        color: PRIMARY_COLOR,
    });
    y -= 30; // Space after title

    // Metadata Section
    const metaStartY = y;
    const labelX = MARGIN;
    const valueX = MARGIN + 130; // Indent values for alignment
    const metaLineHeight = 15;

    // Function to draw a metadata line
    const drawMetaLine = (
        label: string,
        value: string,
        valueSize = 10,
        valueFont = textFont,
    ) => {
        if (y < MARGIN + metaLineHeight) return; // Prevent drawing off page (shouldn't happen here, but good practice)
        page.drawText(label, {
            x: labelX,
            y: y,
            size: 10,
            font: boldFont,
            color: TEXT_COLOR,
        });
        // Wrap value if too long (basic check)
        const maxValueWidth = pageWidth - valueX - MARGIN;
        let lines = [value];
        if (valueFont.widthOfTextAtSize(value, valueSize) > maxValueWidth) {
            // Simple split logic (improve if needed)
            const approxCharsPerLine = Math.floor(
                maxValueWidth /
                    (valueFont.widthOfTextAtSize("m", valueSize) * 0.8),
            );
            const wrappedLines = [];
            let currentLine = "";
            value.split("").forEach((char) => {
                if (currentLine.length < approxCharsPerLine) {
                    currentLine += char;
                } else {
                    wrappedLines.push(currentLine);
                    currentLine = char;
                }
            });
            wrappedLines.push(currentLine);
            lines = wrappedLines;
        }

        lines.forEach((line, index) => {
            page.drawText(line, {
                x: valueX,
                y: y - index * metaLineHeight,
                size: valueSize,
                font: valueFont,
                color: TEXT_COLOR,
            });
        });
        y -= lines.length * metaLineHeight;
    };

    drawMetaLine(
        "Participants:",
        chatData.participants?.join(", ") || "Unknown",
    );
    drawMetaLine(
        "Generated On:",
        format(new Date(), "dd MMM yyyy, HH:mm:ss zzz"),
    ); // More precise timestamp
    drawMetaLine("Original Filename:", chatData.originalFilename || "N/A");
    drawMetaLine("File Hash (SHA256):", chatData.fileHash || "N/A", 8); // Smaller font for hash

    // Processing Options Summary
    let optionsSummary = "Default Processing";
    if (chatData.processingOptions) {
        try {
            // Type assertion if processingOptions is stored as string
            const opts =
                typeof chatData.processingOptions === "string"
                    ? JSON.parse(chatData.processingOptions)
                    : chatData.processingOptions;
            const included = [];
            if (opts.includeVoiceMessages !== false) included.push("Voice"); // Assume included unless explicitly false
            if (opts.includeImages !== false) included.push("Images");
            if (opts.includeAttachments !== false) included.push("Files");

            if (included.length > 0 && included.length < 3) {
                optionsSummary = `Included: ${included.join(", ")}`;
            } else if (included.length === 3) {
                optionsSummary = `Included: Voice, Images, Files`;
            } else {
                optionsSummary = "Text Messages Only";
            }
        } catch (e) {
            console.error("Failed to parse options string for PDF header:", e);
        }
    }
    drawMetaLine("Processing Options:", optionsSummary);

    y -= 10; // Extra space before separator line

    // Add link to media summary page
    const mediaLinkText =
        ">> See Media Files and Authentication Summary on the Last Page";
    const linkY = y - 15;
    page.drawText(mediaLinkText, {
        x: pageWidth - MARGIN - textFont.widthOfTextAtSize(mediaLinkText, 9),
        y: linkY,
        size: 9,
        font: textFont,
        color: LINK_COLOR,
    });

    // Only create PDF annotations if we have the pdfDoc
    if (pdfDoc) {
        try {
            // Create annotation for the link to the last page
            const textWidth = textFont.widthOfTextAtSize(mediaLinkText, 9);
            const linkAnnotationRef = pdfDoc?.context.register(
                pdfDoc?.context.obj({
                    Type: PDFName.of("Annot"),
                    Subtype: PDFName.of("Link"),
                    Rect: [
                        pageWidth - MARGIN - textWidth,
                        linkY - 2,
                        pageWidth - MARGIN,
                        linkY + 10,
                    ],
                    Border: [0, 0, 0],
                    Dest: [
                        pdfDoc?.getPageCount() || 1,
                        PDFName.of("XYZ"),
                        null,
                        null,
                        null,
                    ],
                }),
            );

            // Add annotation to the page's annotations array
            let annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
            if (!annots) {
                annots = pdfDoc?.context.obj([]);
                page.node.set(PDFName.of("Annots"), annots);
            }

            // Add the annotation only if both linkAnnotationRef and annots exist
            if (linkAnnotationRef && annots) {
                annots.push(linkAnnotationRef);
            }
        } catch (error) {
            // Silently fail on annotation creation - annotations are not critical
            console.error(
                "Failed to create summary page link annotation:",
                error,
            );
        }
    }

    y -= 25; // Extra space before separator line

    // Draw horizontal line separator
    page.drawLine({
        start: { x: MARGIN, y: y },
        end: { x: pageWidth - MARGIN, y: y },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
    });
    y -= 20; // Space before first message/date

    return y; // Return the updated Y position
}

/**
 * Draws wrapped text within a bounding box. Returns the final Y position.
 */
function drawWrappedText(
    page: PDFPage,
    text: string,
    font: PDFFont,
    size: number,
    x: number,
    startY: number,
    maxWidth: number,
    lineHeight: number,
    color: Color,
): { lines: string[]; finalY: number } {
    const lines: string[] = [];
    let currentY = startY;

    const paragraphs = text.split("\n");

    for (const paragraph of paragraphs) {
        if (!paragraph) {
            // Handle empty lines resulting from split
            currentY -= lineHeight; // Just move down for an empty line
            continue;
        }
        let remainingText = paragraph;
        while (remainingText.length > 0) {
            let line = "";
            let words = remainingText.split(" ");
            let currentLine = "";

            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                // Handle potential empty strings from multiple spaces
                if (!word) continue;

                const testLine = currentLine ? `${currentLine} ${word}` : word;
                const testWidth = font.widthOfTextAtSize(testLine, size);

                if (testWidth <= maxWidth) {
                    currentLine = testLine;
                } else {
                    // Word itself is too long for the line, break it
                    if (!currentLine && word.length > 0) {
                        let partialWord = "";
                        for (let j = 0; j < word.length; j++) {
                            const char = word[j];
                            const partialTest = partialWord + char;
                            if (
                                font.widthOfTextAtSize(partialTest, size) <=
                                maxWidth
                            ) {
                                partialWord = partialTest;
                            } else {
                                break; // Stop adding chars to this line's partial word
                            }
                        }
                        // Ensure we make progress even if a single char is too wide
                        if (partialWord.length === 0 && word.length > 0) {
                            partialWord = word[0]; // Take at least one char
                        }
                        currentLine = partialWord;
                        // Put the remaining part of the broken word back at the front of the words array
                        words.splice(i, 1, word.substring(partialWord.length));
                        i--; // Re-evaluate the remaining part in the next loop iteration
                    }
                    // If currentLine has content, or the long word was broken, break the inner loop
                    break;
                }
            }

            // If after checking all words, currentLine is still empty, it means the first word was too long
            // and was broken, so we should use the broken part.
            line = currentLine;
            lines.push(line);

            // Check if drawing this line would go below the margin
            if (currentY - lineHeight < MARGIN) {
                console.warn(
                    "Page break required within wrapped text - not fully implemented, text might get cut.",
                );
                // Ideally, you would add a new page here and continue drawing
                // For now, we just stop drawing this message part to avoid errors
                return { lines, finalY: currentY };
            }

            page.drawText(line, {
                x,
                y: currentY,
                font,
                size,
                color,
                lineHeight,
            });
            currentY -= lineHeight;

            // Update remaining text for the next iteration
            // Need to accurately determine how much text was consumed
            let consumedLength = line.length;
            // If the line ends exactly where a space was, add 1 to consumedLength
            if (
                remainingText.length > consumedLength &&
                remainingText[consumedLength] === " " &&
                line === currentLine
            ) {
                consumedLength++;
            }
            remainingText = remainingText.substring(consumedLength); // No trim here, preserve leading spaces if any for next line start
        } // End while(remainingText)
    } // End for(paragraph)
    return { lines, finalY: currentY };
}

/**
 * Estimates the vertical height needed for a message, including header and content.
 */
function estimateMessageHeight(
    message: Message,
    textFont: PDFFont,
    boldFont: PDFFont,
    size: number,
    maxWidth: number,
): number {
    let height = HEADER_LINE_HEIGHT; // For timestamp/sender line

    const contentMaxWidth = maxWidth - CONTENT_INDENT;

    if (message.type === "text") {
        const lines = estimateLines(
            message.content || "",
            textFont,
            size,
            contentMaxWidth,
        );
        height += lines * CONTENT_LINE_HEIGHT;
    } else if (message.type === "voice") {
        height += CONTENT_LINE_HEIGHT * 1.5; // Estimate height for link text + padding
    } else if (message.type === "image" || message.type === "attachment") {
        height += CONTENT_LINE_HEIGHT; // Height for placeholder text
    } else {
        height += CONTENT_LINE_HEIGHT; // Default for unknown types
    }

    height += MESSAGE_SPACING; // Add padding below message
    return height;
}

/**
 * Estimates the number of lines required for text wrapping.
 */
function estimateLines(
    text: string,
    font: PDFFont,
    size: number,
    maxWidth: number,
): number {
    if (!text) return 1; // Assume at least one line even if empty content

    let totalLines = 0;
    const paragraphs = text.split("\n");

    for (const paragraph of paragraphs) {
        if (!paragraph) {
            totalLines++; // Count empty lines
            continue;
        }
        let remainingText = paragraph;
        while (remainingText.length > 0) {
            totalLines++; // Count this line
            let line = "";
            let words = remainingText.split(" ");
            let currentLine = "";
            let consumedLength = 0;

            for (let i = 0; i < words.length; i++) {
                const word = words[i];
                if (!word) {
                    consumedLength++;
                    continue;
                } // Skip empty strings from multiple spaces

                const testLine = currentLine ? `${currentLine} ${word}` : word;
                const testWidth = font.widthOfTextAtSize(testLine, size);

                if (testWidth <= maxWidth) {
                    currentLine = testLine;
                    consumedLength =
                        testLine.length + (currentLine === word ? 0 : 1); // +1 for space
                } else {
                    if (!currentLine && word.length > 0) {
                        // Word itself is too long
                        let partialWord = "";
                        for (let j = 0; j < word.length; j++) {
                            const char = word[j];
                            const partialTest = partialWord + char;
                            if (
                                font.widthOfTextAtSize(partialTest, size) <=
                                maxWidth
                            ) {
                                partialWord = partialTest;
                            } else {
                                break;
                            }
                        }
                        if (partialWord.length === 0 && word.length > 0)
                            partialWord = word[0];
                        currentLine = partialWord;
                        consumedLength = partialWord.length;
                        // No +1 for space here as the word broke
                    }
                    // If word wasn't too long or we broke it, stop adding words to this line
                    break;
                }
            }
            // If line is empty after loop, it means first word was broken
            if (currentLine.length === 0 && remainingText.length > 0) {
                // Recalculate consumedLength for the single broken word part
                let partialWord = "";
                for (let j = 0; j < remainingText.length; j++) {
                    const char = remainingText[j];
                    const partialTest = partialWord + char;
                    if (font.widthOfTextAtSize(partialTest, size) <= maxWidth) {
                        partialWord = partialTest;
                    } else {
                        break;
                    }
                }
                if (partialWord.length === 0 && remainingText.length > 0)
                    partialWord = remainingText[0];
                consumedLength = partialWord.length;
            }

            remainingText = remainingText.substring(consumedLength).trimStart(); // Use trimStart
        } // End while
    } // End for

    return Math.max(1, totalLines); // Ensure at least 1 line is counted
}

/**
 * Draws a placeholder for media messages (Image, Attachment).
 * This function is kept for backward compatibility but new code should use drawMediaLink.
 */
function drawMediaPlaceholder(
    page: PDFPage,
    message: Message,
    mediaTypeLabel: string, // e.g., "Image", "File"
    font: PDFFont,
    x: number,
    y: number,
    color: Color,
): number {
    // Returns the Y position below the drawn text
    const mediaFilename = message.mediaUrl
        ? path.basename(message.mediaUrl)
        : `attached_${mediaTypeLabel.toLowerCase()}`;
    const placeholderText = `[${mediaTypeLabel}: ${mediaFilename}] (Included in evidence package)`;

    page.drawText(placeholderText, {
        x: x,
        y: y,
        font: font, // Consider italics: await pdfDoc.embedFont(StandardFonts.TimesRomanItalic)
        size: 9, // Slightly smaller
        color: color,
        lineHeight: CONTENT_LINE_HEIGHT,
    });
    return y - CONTENT_LINE_HEIGHT;
}

/**
 * Draws a clickable link for media attachments (images, PDFs, and other files).
 */
async function drawMediaLink(
    page: PDFPage,
    pdfDoc: PDFDocument,
    message: Message,
    mediaFile: MediaFile | undefined, // Associated media file from DB/R2
    textFont: PDFFont,
    boldFont: PDFFont,
    x: number,
    y: number,
    color: Color,
    chatId?: number, // Optional: For context in logging
): Promise<number> {
    // Returns the Y position below the link

    // Determine the media type display label
    let mediaTypeLabel = "File";
    let icon = "📄";

    if (message.type === "image") {
        mediaTypeLabel = "Image";
        icon = "🖼️";
    } else if (message.type === "attachment") {
        // Check common file extensions for better labels
        const ext = message.mediaUrl
            ? path.extname(message.mediaUrl).toLowerCase()
            : "";
        if (ext === ".pdf") {
            mediaTypeLabel = "PDF";
            icon = "📄";
        } else if ([".doc", ".docx"].includes(ext)) {
            mediaTypeLabel = "Document";
            icon = "📝";
        } else if ([".xls", ".xlsx"].includes(ext)) {
            mediaTypeLabel = "Spreadsheet";
            icon = "📊";
        } else if ([".zip", ".rar", ".7z"].includes(ext)) {
            mediaTypeLabel = "Archive";
            icon = "🗜️";
        } else if ([".mp4", ".avi", ".mov"].includes(ext)) {
            mediaTypeLabel = "Video";
            icon = "🎬";
        }
    }

    const mediaFilename = message.mediaUrl
        ? path.basename(message.mediaUrl)
        : `attached_${mediaTypeLabel.toLowerCase()}`;

    // Non-unicode fallback icons if needed
    const safeIcon = ""; // Use empty string as PDF may not support Unicode emojis

    // Compose link text
    const linkText = `${safeIcon} View ${mediaTypeLabel}: ${mediaFilename}`;
    const linkFontSize = 10;
    const linkLineHeight = CONTENT_LINE_HEIGHT * 1.2; // Slightly more height for link

    // --- Generate Target URL ---
    let targetUrl = "";
    // Determine base URL robustly
    const appDomain = process.env.REPLIT_DOMAINS
        ? process.env.REPLIT_DOMAINS.split(",")[0]
        : null;
    const appBaseUrl = appDomain
        ? `https://${appDomain}`
        : "http://localhost:5000"; // Default to localhost if not on Replit

    if (mediaFile && mediaFile.id) {
        // Use the proxy URL if we have the mediaFile ID
        targetUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`;
        console.log(
            `PDF (Chat ${chatId || "N/A"}): Using proxy URL for ${message.type} message ${message.id || "N/A"} -> ${targetUrl}`,
        );
    } else if (message.mediaUrl) {
        // Fallback: Use original URL, making it absolute if it's relative
        if (message.mediaUrl.startsWith("/")) {
            targetUrl = `${appBaseUrl}${message.mediaUrl}`;
        } else {
            targetUrl = message.mediaUrl; // Assume it's already absolute or handle other cases
        }
        console.warn(
            `PDF (Chat ${chatId || "N/A"}): Using original/fallback URL for ${message.type} message ${message.id || "N/A"} -> ${targetUrl}`,
        );
    } else {
        console.error(
            `PDF (Chat ${chatId || "N/A"}): Cannot generate URL for ${message.type} message ${message.id || "N/A"} - No mediaUrl and no MediaFile found.`,
        );
        targetUrl = "#"; // Placeholder URL
    }

    // --- Draw Link Text ---
    page.drawText(linkText, {
        x: x,
        y: y,
        font: boldFont, // Make link text bold
        size: linkFontSize,
        color: color, // Use link-specific color
        lineHeight: linkLineHeight,
    });

    // --- Create Clickable Link Annotation ---
    if (targetUrl && targetUrl !== "#") {
        const textWidth = boldFont.widthOfTextAtSize(linkText, linkFontSize);
        const linkRectHeight = linkLineHeight * 0.8; // Make clickable area slightly shorter than line height

        try {
            const linkAnnotationRef = pdfDoc.context.register(
                pdfDoc.context.obj({
                    Type: PDFName.of("Annot"),
                    Subtype: PDFName.of("Link"),
                    Rect: [x, y, x + textWidth, y + linkRectHeight], // Simpler Rect based on text draw position
                    Border: [0, 0, 0], // Underline style [horizontal_corner_radius, vertical_corner_radius, width]
                    A: {
                        Type: PDFName.of("Action"),
                        S: PDFName.of("URI"),
                        URI: PDFString.of(targetUrl), // Use the generated URL
                    },
                }),
            );

            // Add annotation to the page's annotations array
            let annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
            if (!annots) {
                annots = pdfDoc.context.obj([]);
                page.node.set(PDFName.of("Annots"), annots);
            }
            annots.push(linkAnnotationRef);
        } catch (linkError) {
            console.error(
                `PDF (Chat ${chatId || "N/A"}): Failed to create link annotation for ${message.type} message ${message.id || "N/A"}`,
                linkError,
            );
            // Continue without the link if annotation fails
        }
    }

    return y - linkLineHeight; // Return Y position below the link
}

/**
 * Draws a clickable link for voice messages.
 */
async function drawVoiceMessageLink(
    page: PDFPage,
    pdfDoc: PDFDocument,
    message: Message,
    mediaFile: MediaFile | undefined, // Associated media file from DB/R2
    textFont: PDFFont,
    boldFont: PDFFont,
    x: number,
    y: number,
    color: Color,
    chatId?: number, // Optional: For context in logging
): Promise<number> {
    // Returns the Y position below the link

    const duration = message.duration || 0;
    const formattedDuration = formatDuration(duration);
    const mediaFilename = message.mediaUrl
        ? path.basename(message.mediaUrl)
        : "voice_message.opus"; // Assume opus if unknown
    const playSymbol = ">"; // Replaced ▶ (U+25B6) which is not in standard PDF fonts (WinAnsiEncoding)
    const linkText = `${playSymbol} Play Voice Message (${mediaFilename}, ${formattedDuration})`;
    const linkFontSize = 10;
    const linkLineHeight = CONTENT_LINE_HEIGHT * 1.2; // Slightly more height for link

    // --- Generate Target URL ---
    let targetUrl = "";
    // Determine base URL robustly
    const appDomain = process.env.REPLIT_DOMAINS
        ? process.env.REPLIT_DOMAINS.split(",")[0]
        : null;
    const appBaseUrl = appDomain
        ? `https://${appDomain}`
        : "http://localhost:5000"; // Default to localhost if not on Replit

    if (mediaFile && mediaFile.id) {
        // Use the proxy URL if we have the mediaFile ID
        targetUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`;
        console.log(
            `PDF (Chat ${chatId || "N/A"}): Using proxy URL for message ${message.id || "N/A"} -> ${targetUrl}`,
        );
    } else if (message.mediaUrl) {
        // Fallback: Use original URL, making it absolute if it's relative
        if (message.mediaUrl.startsWith("/")) {
            targetUrl = `${appBaseUrl}${message.mediaUrl}`;
        } else {
            targetUrl = message.mediaUrl; // Assume it's already absolute or handle other cases
        }
        console.warn(
            `PDF (Chat ${chatId || "N/A"}): Using original/fallback URL for message ${message.id || "N/A"} -> ${targetUrl}`,
        );
    } else {
        console.error(
            `PDF (Chat ${chatId || "N/A"}): Cannot generate URL for voice message ${message.id || "N/A"} - No mediaUrl and no MediaFile found.`,
        );
        targetUrl = "#"; // Placeholder URL
    }

    // --- Draw Link Text ---
    page.drawText(linkText, {
        x: x,
        y: y,
        font: boldFont, // Make link text bold
        size: linkFontSize,
        color: color, // Use link-specific color
        lineHeight: linkLineHeight,
    });

    // --- Create Clickable Link Annotation ---
    if (targetUrl && targetUrl !== "#") {
        const textWidth = boldFont.widthOfTextAtSize(linkText, linkFontSize);
        const linkRectHeight = linkLineHeight * 0.8; // Make clickable area slightly shorter than line height

        try {
            const linkAnnotationRef = pdfDoc.context.register(
                pdfDoc.context.obj({
                    Type: PDFName.of("Annot"),
                    Subtype: PDFName.of("Link"),
                    // Rect: [x, y - 2, x + textWidth, y + linkRectHeight - 2], // Rectangle slightly offset for better alignment
                    Rect: [x, y, x + textWidth, y + linkRectHeight], // Simpler Rect based on text draw position
                    Border: [0, 0, 0], // Underline style [horizontal_corner_radius, vertical_corner_radius, width]
                    // C: [0, 0, 1], // Border color (irrelevant if Border width is 0)
                    A: {
                        Type: PDFName.of("Action"),
                        S: PDFName.of("URI"),
                        URI: PDFString.of(targetUrl), // Use the generated URL
                    },
                }),
            );

            // Add annotation to the page's annotations array
            let annots = page.node.lookup(PDFName.of("Annots"), PDFArray);
            if (!annots) {
                annots = pdfDoc.context.obj([]);
                page.node.set(PDFName.of("Annots"), annots);
            }
            annots.push(linkAnnotationRef);
        } catch (linkError) {
            console.error(
                `PDF (Chat ${chatId || "N/A"}): Failed to create link annotation for message ${message.id || "N/A"}`,
                linkError,
            );
            // Continue without the link if annotation fails
        }
    }

    return y - linkLineHeight; // Return Y position below the link
}

/**
 * Adds page number (e.g., "Page 1 of 5") to the bottom center of a page.
 */
function addPageNumber(
    page: PDFPage,
    currentPageNum: number,
    totalPages: number,
    font: PDFFont,
    margin: number,
) {
    const { width } = page.getSize();
    const text = `Page ${currentPageNum} of ${totalPages}`;
    const textSize = 8;
    const textWidth = font.widthOfTextAtSize(text, textSize);
    const textHeight = font.heightAtSize(textSize);

    page.drawText(text, {
        x: width / 2 - textWidth / 2, // Center horizontally
        y: margin / 2 - textHeight / 2, // Center vertically in bottom margin area
        size: textSize,
        font: font,
        color: META_COLOR, // Use grey color for page numbers
    });
}

/**
 * Formats duration from seconds to MM:SS format.
 */
function formatDuration(seconds: number): string {
    if (isNaN(seconds) || seconds < 0) {
        return "0:00";
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

// --- Removed Puppeteer/HTML related code ---
// Removed generatePdfWithPuppeteer function
// Removed generateHTML function
// Removed escapeHtml function (no longer needed)
