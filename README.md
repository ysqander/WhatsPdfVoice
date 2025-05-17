# WhatsPdfVoice

## Overview

WhatsPdfVoice is a web application designed to convert WhatsApp chat exports (including media) into court-admissible PDF transcripts. It provides features like linked media within the transcript and the ability to download an offline evidence bundle containing the PDF and all associated media files.

## Key Functionality

*   **WhatsApp Chat Upload:** Users can upload exported `.zip` files from WhatsApp chats.
*   **Transcript Generation:** The application processes the chat file (`_chat.txt`) and associated media.
*   **PDF Creation:** Generates a PDF transcript of the chat, preserving the order and content.
*   **Media Linking:** Media files (images, videos, audio) mentioned in the chat are linked within the PDF.
*   **Offline Bundle:** Users can download a `.zip` archive containing the generated PDF transcript and all media files referenced in the chat for offline evidence preservation.

## Tech Stack

*   **Frontend:** React, TypeScript, Vite, Tailwind CSS, shadcn/ui
*   **Backend:** Node.js, TypeScript, Express (likely), Drizzle ORM
*   **Database:** SQL (inferred from Drizzle ORM)
*   **Shared:** TypeScript types and schemas (`shared/`)

## Project Structure

*   `client/`: Frontend React application source code.
*   `server/`: Backend Node.js application source code.
    *   `controllers/`: Request handlers.
    *   `lib/`: Utility functions and core logic.
    *   `migrations/`: Database migration files (Drizzle).
    *   `routes.ts`: API route definitions.
*   `shared/`: TypeScript code shared between client and server (types, schemas).
*   `test_zips/`: Contains example WhatsApp chat export `.zip` files for testing.

## Current Status & Known Issues

*   **Payment Path Broken:** The functionality requiring user payment is currently not working and needs investigation and fixing.

---

## ⚠️ Payment Flow Issue: Guidance for Developers

### Background
For large WhatsApp chats (over 50 messages or 20MB media), the app requires user payment before generating the final PDF transcript and evidence bundle. The payment flow is designed to:
- Save the chat and media metadata to the database.
- Upload all media to R2 and generate proxy URLs (to avoid 7-day signed URL expiry).
- Pause processing and prompt the user for payment.
- After payment, generate the final PDF (with correct media links) and make it available for download (PDF and evidence bundle).

### Current Problem
After payment is completed, the post-payment processing (PDF generation and evidence bundle creation) is **not working as intended**. The breakdown appears to occur in the following areas:
- The system may not correctly retrieve or use the saved proxy URLs for media files when generating the PDF after payment.
- The PDF may not be generated at all, or the generated PDF may have broken/missing media links.
- The final PDF URL may not be saved or returned to the client, so the user cannot access their paid download.
- The client polling for the PDF after payment may never receive a valid URL.

### Where to Investigate
- `server/controllers/uploadController.ts` (payment-required path, post-payment logic)
- `server/lib/paymentService.ts` (especially `ensurePdfGeneratedAndLinked`)
- `server/lib/pdf.ts` (PDF generation, media link logic)
- `server/storage.ts` and `server/databaseStorage.ts` (data retrieval, media URL saving)
- Client polling logic in `client/src/pages/Home.tsx`

### Objectives for a Successful Fix
A developer fixing this should ensure:
- After payment, the system generates the PDF transcript using the correct proxy URLs for all media (voice, images, attachments).
- The generated PDF is uploaded to R2, and a proxy URL is created for it.
- The final PDF proxy URL is saved to the `ChatExport` record and is accessible to the client.
- The client, after payment, can poll and receive the correct PDF URL and download the evidence bundle.
- All links in the PDF (and evidence bundle) work for the full 30-day retention period.

**A successful fix means:**
- Paid users always receive a working PDF and evidence bundle with all media links functional.
- No broken or missing links in the PDF.
- The client UI updates to show the download is ready after payment.

---


## Investigation Notes

### Documents involved in the paid processing path
- `server/controllers/uploadController.ts` – handles the upload flow and creates payment bundles when limits are exceeded.
- `server/lib/paymentService.ts` – contains the `ensurePdfGeneratedAndLinked` method which performs post‑payment PDF generation and linking.
- `server/lib/pdf.ts` – builds the PDF and determines media links.
- `server/storage.ts` and `server/databaseStorage.ts` – persist chat exports, messages and media URLs.
- `server/mediaProxyStorage.ts` – creates proxy records for R2 files.
- `server/routes.ts` – exposes payment and repair endpoints.
- `client/src/pages/Home.tsx` – polls for the PDF after checkout.

### Hypotheses for why the paid flow fails
1. Proxy URLs stored before payment are not used when generating the final PDF.
2. `ensurePdfGeneratedAndLinked` fails to save the generated PDF URL back to the `ChatExport` record.
3. Messages are not properly retrieved from the database after payment so the PDF generation step runs with incomplete data.
4. The status endpoint `/api/payment/:bundleId` may return before the PDF URL is saved, causing the client polling loop to never see it.

### Test Suite
Tests were added under `server/__tests__/paymentService.test.ts` to validate the service logic:
- **saves a PDF URL after generation** – ensures that `ensurePdfGeneratedAndLinked` writes a proxy URL to the database.
- **uses proxy URLs in messages when generating PDF** – verifies that messages passed to `generatePdf` already contain proxy URLs.

Run all tests with:
```bash
npx vitest
```

