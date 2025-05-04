import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProcessSteps from "@/components/ProcessSteps";
import UploadSection from "@/components/UploadSection";
import PreviewSection from "@/components/PreviewSection";
import PaymentRequired from "@/components/PaymentRequired";
import { useState, useEffect } from "react";
import { ChatExport, ProcessingOptions, ProcessingStep } from "@shared/types";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const { toast } = useToast();
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
    { done: false, text: "Payment required..." }
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
  
  // Payment-related state
  const [requiresPayment, setRequiresPayment] = useState(false);
  const [messageCount, setMessageCount] = useState(0);
  const [mediaSizeBytes, setMediaSizeBytes] = useState(0);
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [currentStep, setCurrentStep] = useState<ProcessingStep | null>(null);
  
  // Check if we have success or cancelled params in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const cancelled = params.get('cancelled');
    const bundleUrl = params.get('bundleUrl');
    
    if (success === 'true' && bundleUrl) {
      toast({
        title: "Payment Successful!",
        description: "Thank you for your purchase. Your download is ready.",
      });
      
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Set the PDF URL and mark as processed
      setPdfUrl(decodeURIComponent(bundleUrl));
      setIsFileProcessed(true);
      setRequiresPayment(false);
    }
    
    if (cancelled === 'true') {
      toast({
        variant: "destructive",
        title: "Payment Cancelled",
        description: "Your payment was cancelled. You can try again when ready.",
      });
      
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

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
