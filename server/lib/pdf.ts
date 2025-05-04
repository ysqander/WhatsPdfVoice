import { ChatExport, Message } from "@shared/types";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray, PDFString } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { format } from "date-fns";
import puppeteer from "puppeteer";
import { v4 as uuidv4 } from "uuid";
import { getSignedR2Url } from "./r2Storage";
import { storage } from "../storage";

// Create PDF directory if it doesn't exist
const pdfDir = path.join(os.tmpdir(), "whatspdf", "pdfs");
if (!fs.existsSync(pdfDir)) {
  fs.mkdirSync(pdfDir, { recursive: true });
}

// Generate a PDF from the chat data
export async function generatePdf(chatData: ChatExport): Promise<string> {
  // Always use PDFLib as Puppeteer has system dependency issues
  // Additionally, we're now using hyperlinks for voice messages instead of audio controls
  const { pdfPath } = await generatePdfWithPdfLib(chatData);
  return pdfPath;
}

// Generate a PDF with PDF-lib (no interactive elements)
async function generatePdfWithPdfLib(
  chatData: ChatExport,
): Promise<{ pdfPath: string; pdfId: string }> {
  const pdfDoc = await PDFDocument.create();

  // Add metadata
  pdfDoc.setTitle(`WhatsApp Chat - ${format(new Date(), "yyyy-MM-dd")}`);
  pdfDoc.setAuthor("WhatsPDF Voice");
  pdfDoc.setCreator("WhatsPDF Voice");
  pdfDoc.setProducer("WhatsPDF Voice");
  pdfDoc.setSubject("WhatsApp Chat Export");

  // Get fonts
  const timesRomanFont = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesRomanBoldFont = await pdfDoc.embedFont(
    StandardFonts.TimesRomanBold,
  );

  // Define colors
  const primaryColor = rgb(0.17, 0.24, 0.31); // #2C3E50
  const secondaryColor = rgb(0.2, 0.29, 0.37); // #34495E
  const textColor = rgb(0.2, 0.2, 0.2); // #333333

  // Add first page
  const page = pdfDoc.addPage();
  const { width, height } = page.getSize();
  const margin = 50;

  // Add header - simplified as requested
  page.drawText("WhatsApp Conversation Transcript", {
    x: width / 2 - 120,
    y: height - margin,
    size: 16,
    font: timesRomanBoldFont,
    color: primaryColor,
  });

  // Add minimal metadata - only generated date and participants
  page.drawText(`Generated On: ${format(new Date(), "dd MMM yyyy, HH:mm")}`, {
    x: margin,
    y: height - margin - 40,
    size: 10,
    font: timesRomanFont,
    color: textColor,
  });

  page.drawText(
    `Participants: ${chatData.participants?.join(", ") || "Unknown"}`,
    {
      x: margin,
      y: height - margin - 55,
      size: 10,
      font: timesRomanFont,
      color: textColor,
    },
  );

  // Draw horizontal line
  page.drawLine({
    start: { x: margin, y: height - margin - 80 },
    end: { x: width - margin, y: height - margin - 80 },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });

  // Group messages by date
  const messagesByDate: Record<string, Message[]> = {};
  for (const message of chatData.messages) {
    const date = format(new Date(message.timestamp), "dd MMMM yyyy");
    if (!messagesByDate[date]) {
      messagesByDate[date] = [];
    }
    messagesByDate[date].push(message);
  }

  console.log("Grouped messages by date:", {
    totalDates: Object.keys(messagesByDate).length,
    messagesByDateSample: Object.entries(messagesByDate)
      .slice(0, 2)
      .map(([date, msgs]) => ({
        date,
        messageCount: msgs.length,
      })),
  });

  // Start position for messages
  let y = height - margin - 100;
  let currentPage = page;

  // Process each date group
  for (const [date, messages] of Object.entries(messagesByDate)) {
    // Check if we need a new page
    if (y < margin + 50) {
      currentPage = pdfDoc.addPage();
      y = height - margin;
    }

    // Add date separator
    currentPage.drawText(date, {
      x: width / 2 - 40,
      y,
      size: 10,
      font: timesRomanFont,
      color: rgb(0.5, 0.5, 0.5),
    });

    y -= 20;

    // Add messages
    for (const message of messages) {
      // Check if we need a new page
      if (y < margin + 50) {
        currentPage = pdfDoc.addPage();
        y = height - margin;
      }

      // Format timestamp
      const timestamp = format(new Date(message.timestamp), "HH:mm");

      // Draw timestamp and sender
      currentPage.drawText(timestamp, {
        x: margin,
        y,
        size: 8,
        font: timesRomanFont,
        color: rgb(0.5, 0.5, 0.5),
      });

      currentPage.drawText(message.sender, {
        x: margin + 40,
        y,
        size: 10,
        font: timesRomanBoldFont,
        color:
          message.sender === chatData.participants?.[0]
            ? primaryColor
            : secondaryColor,
      });

      y -= 15;

      // Draw message content
      if (message.type === "text") {
        // Split long messages
        const words = message.content.split(" ");
        let line = "";
        let lineY = y;

        for (const word of words) {
          const testLine = line ? `${line} ${word}` : word;
          const textWidth = timesRomanFont.widthOfTextAtSize(testLine, 10);

          if (textWidth > width - margin * 2 - 20) {
            currentPage.drawText(line, {
              x: margin + 20,
              y: lineY,
              size: 10,
              font: timesRomanFont,
              color: textColor,
            });

            line = word;
            lineY -= 15;

            // Check if we need a new page
            if (lineY < margin + 20) {
              currentPage = pdfDoc.addPage();
              lineY = height - margin;
            }
          } else {
            line = testLine;
          }
        }

        // Draw remaining text
        if (line) {
          currentPage.drawText(line, {
            x: margin + 20,
            y: lineY,
            size: 10,
            font: timesRomanFont,
            color: textColor,
          });
        }

        y = lineY - 20;
      } else if (message.type === "voice") {
        if (message.mediaUrl) {
          const playText = "> Play Voice Message";
          
          // Create button-like appearance with a box around the text
          // Draw a colored background box
          const textWidth = timesRomanBoldFont.widthOfTextAtSize(playText, 10);
          const buttonPadding = 8;
          const buttonX = margin + 20;
          const buttonY = y - 4;
          const buttonWidth = textWidth + (buttonPadding * 2);
          const buttonHeight = 20;
          
          // Draw button border (light blue rectangle)
          currentPage.drawRectangle({
            x: buttonX,
            y: buttonY - buttonHeight,
            width: buttonWidth,
            height: buttonHeight,
            borderWidth: 1,
            borderColor: rgb(0.2, 0.6, 0.86), // #3498DB
            color: rgb(0.96, 0.98, 1), // Light blue background #f5f9ff
            borderOpacity: 0.8,
            opacity: 0.3,
          });
          
          // Draw the link text on top of the background
          currentPage.drawText(playText, {
            x: buttonX + buttonPadding,
            y: buttonY - buttonHeight/2 - 4,
            size: 10,
            font: timesRomanBoldFont,
            color: rgb(0.2, 0.6, 0.86), // #3498DB
          });
          
          // Compute link bounds for the hyperlink area
          const linkHeight = buttonHeight;
          const linkX = buttonX;
          const linkY = buttonY - buttonHeight;
          
          // For voice messages with an R2-stored media, use our proxy endpoint
          let messageId: string | number | undefined;
          let proxyUrl: string;
          
          // Determine the base URL of our application for absolute URLs
          // In Replit, we can use REPLIT_DOMAINS or fallback to localhost
          const appBaseUrl = process.env.REPLIT_DOMAINS 
            ? `https://${process.env.REPLIT_DOMAINS}`
            : 'http://localhost:5000'; // Fallback for local development
          
          console.log(`Using app base URL: ${appBaseUrl}`);
          
          // If this is an R2 URL, extract the mediaId from our storage
          if (message.id) {
            messageId = message.id;
            const mediaFiles = await storage.getMediaFilesByChat(chatData.id!);
            // Find the media file associated with this message
            const mediaFile = mediaFiles.find(file => file.messageId === messageId);
            
            if (mediaFile) {
              // Use our proxy endpoint which will generate fresh signed URLs on demand
              // Using absolute URL that includes the hostname
              proxyUrl = `${appBaseUrl}/api/media/proxy/${mediaFile.id}`;
              console.log(`Generated proxy URL for voice message: ${proxyUrl}`);
            } else {
              // Fallback - try to make the original media URL absolute if it's relative
              if (message.mediaUrl && message.mediaUrl.startsWith('/')) {
                proxyUrl = `${appBaseUrl}${message.mediaUrl}`;
              } else {
                proxyUrl = message.mediaUrl || '';
              }
            }
          } else {
            // Fallback - try to make the original media URL absolute if it's relative
            if (message.mediaUrl && message.mediaUrl.startsWith('/')) {
              proxyUrl = `${appBaseUrl}${message.mediaUrl}`;
            } else {
              proxyUrl = message.mediaUrl || '';
            }
          }

          // Create and register the annotation with correct structure using PDFName and PDFString
          const linkAnnotationRef = pdfDoc.context.register(
            pdfDoc.context.obj({
              Type: PDFName.of('Annot'),
              Subtype: PDFName.of('Link'),
              Rect: [linkX, linkY, linkX + buttonWidth, linkY + linkHeight],
              Border: [0, 0, 0],
              A: {
                Type: PDFName.of('Action'),
                S: PDFName.of('URI'),
                URI: PDFString.of(proxyUrl)
              }
            })
          );

          // Get existing annotations or create new array
          let annots = currentPage.node.lookup(PDFName.of('Annots'));
          
          if (annots instanceof PDFArray) {
            // Push onto existing array
            annots.push(linkAnnotationRef);
          } else {
            // Create new annotations array
            currentPage.node.set(
              PDFName.of('Annots'),
              pdfDoc.context.obj([linkAnnotationRef])
            );
          }

          // For the duration text
          if (message.duration) {
            const formattedDuration = formatDuration(message.duration);
            currentPage.drawText(`Duration: ${formattedDuration}`, {
              x: margin + 20,
              y: buttonY - buttonHeight - 12,  // Position below the button with padding
              size: 8,
              font: timesRomanFont,
              color: rgb(0.5, 0.5, 0.5),
            });
          }
        } else {
          // Fallback for voice messages without a media URL
          currentPage.drawText("[Voice Message]", {
            x: margin + 20,
            y,
            size: 10,
            font: timesRomanBoldFont,
            color: rgb(0.2, 0.6, 0.86), // #3498DB
          });
        }

        y -= 20;
      } else if (message.type === "image") {
        // Draw a placeholder for image
        currentPage.drawText("[Image Attachment]", {
          x: margin + 20,
          y,
          size: 10,
          font: timesRomanBoldFont,
          color: rgb(0.2, 0.6, 0.86), // #3498DB
        });

        y -= 20;
      } else if (message.type === "attachment") {
        // Draw a placeholder for other attachments
        currentPage.drawText("[File Attachment]", {
          x: margin + 20,
          y,
          size: 10,
          font: timesRomanBoldFont,
          color: rgb(0.2, 0.6, 0.86), // #3498DB
        });

        y -= 20;
      }
    }
  }

  // Add page numbers
  const pageCount = pdfDoc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const page = pdfDoc.getPage(i);
    const { width, height } = page.getSize();

    page.drawText(`Page ${i + 1} of ${pageCount}`, {
      x: width / 2 - 30,
      y: margin / 2,
      size: 10,
      font: timesRomanFont,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  // Save PDF
  console.log("Saving PDF document...");
  const pdfBytes = await pdfDoc.save();
  const pdfId = uuidv4();
  const pdfPath = path.join(pdfDir, `${pdfId}.pdf`);
  console.log("Writing PDF to path:", pdfPath);
  fs.writeFileSync(pdfPath, pdfBytes);
  console.log("PDF file written successfully");
  console.log("PDF details:", { pdfId, pdfPath, size: pdfBytes.length });

  return { pdfPath, pdfId };
}

// Generate a PDF with Puppeteer for interactive elements
async function generatePdfWithPuppeteer(chatData: ChatExport): Promise<string> {
  // Create a temporary HTML file for Puppeteer
  const htmlPath = path.join(os.tmpdir(), `${uuidv4()}.html`);
  const pdfPath = path.join(pdfDir, `${uuidv4()}.pdf`);

  try {
    // Generate HTML content
    const htmlContent = generateHTML(chatData);
    fs.writeFileSync(htmlPath, htmlContent);

    // Launch Puppeteer
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const page = await browser.newPage();
      await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle2" });

      // Generate PDF
      await page.pdf({
        path: pdfPath,
        format: "A4",
        printBackground: true,
        margin: {
          top: "50px",
          right: "50px",
          bottom: "50px",
          left: "50px",
        },
      });

      return pdfPath;
    } finally {
      await browser.close();
    }
  } finally {
    // Clean up temporary file
    if (fs.existsSync(htmlPath)) {
      fs.unlinkSync(htmlPath);
    }
  }
}

// Generate HTML content for Puppeteer
function generateHTML(chatData: ChatExport): string {
  // Group messages by date
  const messagesByDate: Record<string, Message[]> = {};
  for (const message of chatData.messages) {
    const date = format(new Date(message.timestamp), "dd MMMM yyyy");
    if (!messagesByDate[date]) {
      messagesByDate[date] = [];
    }
    messagesByDate[date].push(message);
  }

  // HTML header with styles
  let html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>WhatsApp Chat - ${format(new Date(), "yyyy-MM-dd")}</title>
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&family=Source+Sans+Pro:wght@400;600;700&display=swap');

        body {
          font-family: 'Source Sans Pro', sans-serif;
          margin: 0;
          padding: 0;
          color: #333333;
          line-height: 1.5;
        }

        .container {
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
        }

        .header {
          text-align: center;
          margin-bottom: 30px;
          border-bottom: 2px solid #3498DB;
          padding-bottom: 20px;
        }

        .header h1 {
          font-size: 24px;
          color: #2C3E50;
          margin: 0 0 20px;
          font-weight: 600;
        }

        .metadata {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
          font-size: 12px;
        }

        .metadata p {
          margin: 5px 0;
        }

        .metadata .label {
          font-weight: 600;
        }

        .date-separator {
          text-align: center;
          margin: 20px 0;
          color: #888;
          font-size: 14px;
          position: relative;
        }

        .message {
          margin-bottom: 15px;
        }

        .message-header {
          display: flex;
          align-items: center;
          margin-bottom: 4px;
        }

        .message-time {
          font-size: 12px;
          color: #888;
          margin-right: 8px;
        }

        .message-sender {
          font-weight: 600;
          font-size: 14px;
        }

        .sender-1 {
          color: #2C3E50;
        }

        .sender-2 {
          color: #34495E;
        }

        .message-bubble {
          padding: 12px;
          border-radius: 12px;
          margin-left: 20px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.1);
        }

        .sender-1-bubble {
          background-color: #f0f0f0;
          border-left: 3px solid #2C3E50;
        }

        .sender-2-bubble {
          background-color: #e6f3ff;
          border-left: 3px solid #3498DB;
        }

        .message-content {
          font-size: 14px;
          line-height: 1.5;
          white-space: pre-wrap;
        }

        .audio-player {
          display: flex;
          align-items: center;
          background-color: white;
          border: 1px solid #ddd;
          border-radius: 5px;
          padding: 6px;
        }

        .play-button {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background-color: #3498DB;
          color: white;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          margin-right: 8px;
          cursor: pointer;
        }

        .play-button svg {
          width: 14px;
          height: 14px;
          fill: currentColor;
        }

        .audio-progress {
          flex: 1;
          height: 6px;
          background-color: #eee;
          border-radius: 3px;
          overflow: hidden;
        }

        .audio-duration {
          font-size: 12px;
          color: #888;
          margin-left: 8px;
        }

        .page-number {
          text-align: center;
          font-size: 12px;
          color: #888;
          margin-top: 30px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>WhatsApp Conversation Transcript</h1>

          <div class="metadata">
            <p><span class="label">Generated On:</span> ${format(new Date(), "dd MMM yyyy, HH:mm")}</p>
            <p><span class="label">Participants:</span> ${chatData.participants?.join(", ") || "Unknown"}</p>
          </div>
        </div>

        <div class="chat-content">
  `;

  // Add messages grouped by date
  let messageCount = 0;
  Object.entries(messagesByDate).forEach(([date, messages], dateIndex) => {
    html += `
      <div class="date-separator">${date}</div>
    `;

    messages.forEach((message, messageIndex) => {
      messageCount++;
      const senderIndex =
        chatData.participants?.indexOf(message.sender) === 0 ? 1 : 2;
      const timestamp = format(new Date(message.timestamp), "HH:mm");

      html += `
        <div class="message">
          <div class="message-header">
            <span class="message-time">${timestamp}</span>
            <span class="message-sender sender-${senderIndex}">${message.sender}</span>
          </div>
          <div class="message-bubble sender-${senderIndex}-bubble">
      `;

      if (message.type === "text") {
        html += `<div class="message-content">${escapeHtml(message.content)}</div>`;
      } else if (message.type === "voice" && message.mediaUrl) {
        const duration = message.duration || 0;
        const formattedDuration = formatDuration(duration);

        html += `
          <div class="message-content">
            <!-- native audio control; will be clickable in the PDF -->
            <audio controls style="width: 100%; max-width: 400px;">
              <source src="${message.mediaUrl}" type="audio/ogg">
              <!-- fallback link for older viewers -->
              Your browser doesn’t support audio playback.
            </audio>
            <div style="font-size:12px; color:#888; margin-top:4px;">
              Duration: ${formattedDuration}
            </div>
          </div>
        `;
      } else if (message.type === "image" && message.mediaUrl) {
        html += `<div class="message-content">[Image Attachment]</div>`;
      } else if (message.type === "attachment" && message.mediaUrl) {
        html += `<div class="message-content">[File Attachment]</div>`;
      }

      html += `
          </div>
        </div>
      `;

      // Add page breaks approximately every 25 messages
      if (
        messageCount % 25 === 0 &&
        !(
          dateIndex === Object.keys(messagesByDate).length - 1 &&
          messageIndex === messages.length - 1
        )
      ) {
        const pageNum = Math.ceil(messageCount / 25);
        const totalPages = Math.ceil(chatData.messages.length / 25);

        html += `
          <div class="page-number">Page ${pageNum} of ${totalPages}</div>
          <div style="page-break-after: always;"></div>
        `;
      }
    });
  });

  // Add final page number
  const totalPages = Math.ceil(chatData.messages.length / 25);
  html += `
          <div class="page-number">Page ${totalPages} of ${totalPages}</div>
        </div>
      </div>
    </body>
    </html>
  `;

  return html;
}

// Helper function to escape HTML
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Format duration from seconds to MM:SS
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}
