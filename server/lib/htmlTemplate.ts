import { format } from "date-fns";
import { ChatExport, Message } from "@shared/types";

// Escapes HTML special characters to prevent XSS attacks
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Formats duration from seconds to minutes:seconds format
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Generate HTML content for the PDF
export function generateHTML(chatData: ChatExport): string {
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
          line-height: 1.4;
          white-space: pre-wrap;
        }
        
        .voice-link {
          display: inline-flex;
          align-items: center;
          background-color: #f5f9ff;
          border: 1px solid #3498DB;
          border-radius: 8px;
          color: #3498DB;
          text-decoration: none;
          font-weight: 600;
          padding: 8px 12px;
          margin: 8px 0 12px 0;
          box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        
        .voice-link-icon {
          display: flex;
          justify-content: center;
          align-items: center;
          background-color: #3498DB;
          color: white;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          margin-right: 10px;
          font-size: 14px;
        }
        
        .duration-info {
          font-size: 12px;
          color: #888;
          margin-top: 4px;
          display: block;
          margin-left: 2px;
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

        // Use clickable link for voice messages instead of audio element
        html += `
          <div class="message-content">
            <a href="${message.mediaUrl}" class="voice-link" target="_blank">
              <span class="voice-link-icon">&gt;</span>
              Play Voice Message
            </a>
            <div class="duration-info">
              Duration: ${formattedDuration}
            </div>
          </div>
        `;
      } else if (message.type === "image" && message.mediaUrl) {
        html += `
          <div class="message-content">
            <a href="${message.mediaUrl}" target="_blank">[Image Attachment]</a>
          </div>
        `;
      } else if (message.type === "attachment" && message.mediaUrl) {
        html += `
          <div class="message-content">
            <a href="${message.mediaUrl}" target="_blank">[File Attachment]</a>
          </div>
        `;
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