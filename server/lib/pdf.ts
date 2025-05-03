import { ChatExport, Message } from "@shared/types";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFArray } from "pdf-lib";
import fs from "fs";
import path from "path";
import os from "os";
import { format } from "date-fns";
import puppeteer from "puppeteer";
import { v4 as uuidv4 } from "uuid";

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

  // Add header
  page.drawText("CHAT TRANSCRIPT EVIDENCE", {
    x: width / 2 - 120,
    y: height - margin,
    size: 16,
    font: timesRomanBoldFont,
    color: primaryColor,
  });

  page.drawText("WhatsApp Conversation", {
    x: width / 2 - 80,
    y: height - margin - 20,
    size: 14,
    font: timesRomanFont,
    color: secondaryColor,
  });

  // Add metadata
  page.drawText(`Case Reference: WA-${format(new Date(), "yyyyMMdd-HHmm")}`, {
    x: margin,
    y: height - margin - 50,
    size: 10,
    font: timesRomanFont,
    color: textColor,
  });

  page.drawText(`Generated On: ${format(new Date(), "dd MMM yyyy, HH:mm")}`, {
    x: margin,
    y: height - margin - 65,
    size: 10,
    font: timesRomanFont,
    color: textColor,
  });

  page.drawText(`File SHA-256: ${chatData.fileHash.substring(0, 10)}...`, {
    x: width - margin - 200,
    y: height - margin - 50,
    size: 10,
    font: timesRomanFont,
    color: textColor,
  });

  page.drawText(
    `Participants: ${chatData.participants?.join(", ") || "Unknown"}`,
    {
      x: width - margin - 200,
      y: height - margin - 65,
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
          
          // Draw the link text
          currentPage.drawText(playText, {
            x: margin + 20,
            y,
            size: 10,
            font: timesRomanBoldFont,
            color: rgb(0.2, 0.6, 0.86), // #3498DB
          });
          
          // Compute link bounds
          const textWidth = timesRomanBoldFont.widthOfTextAtSize(playText, 10);
          const linkHeight = 12;
          const linkX = margin + 20;
          const linkY = y - 2;
          
          // Create and register the annotation with correct structure
          const linkAnnotationRef = pdfDoc.context.register(
            pdfDoc.context.obj({
              Type: 'Annot',
              Subtype: 'Link',
              Rect: [linkX, linkY, linkX + textWidth, linkY + linkHeight],
              Border: [0, 0, 0],
              A: {
                Type: 'Action',
                S: 'URI',
                URI: pdfDoc.context.obj(message.mediaUrl)
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

          // Add reference text for evidence ZIP
          const mediaFileId = path.basename(message.mediaUrl);
          const mediaUrl = `/media/${chatData.id}/${mediaFileId}`;
          currentPage.drawText("(See voice note at: " + mediaUrl + ")", {
            x: margin + 20,
            y: y - 15,
            size: 8,
            font: timesRomanFont,
            color: rgb(0.5, 0.5, 0.5),
          });
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
        }

        .container {
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
        }

        .header {
          text-align: center;
          margin-bottom: 30px;
          border-bottom: 2px solid #f0f0f0;
          padding-bottom: 20px;
        }

        .header h1 {
          font-size: 20px;
          color: #2C3E50;
          margin: 0 0 5px;
          text-transform: uppercase;
        }

        .header h2 {
          font-size: 18px;
          color: #34495E;
          margin: 0 0 20px;
          font-weight: normal;
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
          padding: 10px;
          border-radius: 10px;
          margin-left: 20px;
        }

        .sender-1-bubble {
          background-color: #f0f0f0;
        }

        .sender-2-bubble {
          background-color: #e6f3ff;
        }

        .message-content {
          font-size: 14px;
          line-height: 1.4;
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
          <h1>CHAT TRANSCRIPT EVIDENCE</h1>
          <h2>WhatsApp Conversation</h2>

          <div class="metadata">
            <p><span class="label">Case Reference:</span> WA-${format(new Date(), "yyyyMMdd-HHmm")}</p>
            <p><span class="label">File SHA-256:</span> ${chatData.fileHash.substring(0, 10)}...</p>
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
