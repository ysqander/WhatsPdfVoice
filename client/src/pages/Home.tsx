import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProcessSteps from "@/components/ProcessSteps";
import UploadSection from "@/components/UploadSection";
import PreviewSection from "@/components/PreviewSection";
import { useState } from "react";
import { ChatExport, ProcessingOptions } from "@shared/types";

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingSteps, setProcessingSteps] = useState<Array<{ done: boolean; text: string }>>([
    { done: false, text: "Extracting ZIP contents..." },
    { done: false, text: "Parsing chat messages..." },
    { done: false, text: "Converting voice messages..." },
    { done: false, text: "Generating PDF document..." },
  ]);
  const [isFileProcessed, setIsFileProcessed] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [chatData, setChatData] = useState<ChatExport | null>(null);
  const [processingOptions, setProcessingOptions] = useState<ProcessingOptions>({
    includeVoiceMessages: true,
    includeTimestamps: true,
    highlightSenders: true,
    includeImages: false,
    includeAttachments: false,
  });

  const resetState = () => {
    setFile(null);
    setIsUploading(false);
    setUploadProgress(0);
    setIsProcessing(false);
    setProcessingProgress(0);
    setIsFileProcessed(false);
    setPdfUrl(null);
    setChatData(null);
    setProcessingSteps(processingSteps.map(step => ({ ...step, done: false })));
  };

  return (
    <div className="bg-gray-100 font-roboto text-text min-h-screen flex flex-col">
      <Header />
      
      <main className="container mx-auto px-4 py-8 flex-grow">
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold text-primary mb-2">
            Convert WhatsApp Chats to Court-Admissible PDFs
          </h2>
          <p className="text-gray-600 max-w-3xl mx-auto">
            Upload your WhatsApp chat export (ZIP) and generate a professional PDF document 
            with preserved voice messages as interactive audio elements.
          </p>
        </div>

        <ProcessSteps />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 max-w-6xl mx-auto">
          <UploadSection 
            file={file}
            setFile={setFile}
            isUploading={isUploading}
            setIsUploading={setIsUploading}
            uploadProgress={uploadProgress}
            setUploadProgress={setUploadProgress}
            isProcessing={isProcessing}
            setIsProcessing={setIsProcessing}
            processingProgress={processingProgress}
            setProcessingProgress={setProcessingProgress}
            processingSteps={processingSteps}
            setProcessingSteps={setProcessingSteps}
            isFileProcessed={isFileProcessed}
            setIsFileProcessed={setIsFileProcessed}
            setPdfUrl={setPdfUrl}
            setChatData={setChatData}
            processingOptions={processingOptions}
            setProcessingOptions={setProcessingOptions}
            resetState={resetState}
          />
          
          <PreviewSection 
            chatData={chatData}
            pdfUrl={pdfUrl}
            isFileProcessed={isFileProcessed}
          />
        </div>
      </main>

      <Footer />
    </div>
  );
}
