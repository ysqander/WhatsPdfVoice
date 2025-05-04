import Header from "@/components/Header";
import Footer from "@/components/Footer";
import ProcessSteps from "@/components/ProcessSteps";
import UploadSection from "@/components/UploadSection";
import PreviewSection from "@/components/PreviewSection";
import PaymentRequired from "@/components/PaymentRequired";
import ProcessingStatus from "@/components/ProcessingStatus";
import { useState, useEffect } from "react";
import { ChatExport, ProcessingOptions, ProcessingStep, FREE_TIER_MESSAGE_LIMIT, FREE_TIER_MEDIA_SIZE_LIMIT } from "@shared/types";
import { useToast } from "@/hooks/use-toast";

export default function Home() {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);
  const [processingSteps, setProcessingSteps] = useState<Array<{ done: boolean; text: string; name?: string }>>([
    { done: false, text: "Extracting ZIP contents..." },
    { done: false, text: "Parsing chat messages..." },
    { done: false, text: "Converting voice messages..." },
    { done: false, text: "Generating PDF document..." },
    { done: false, text: "Payment required...", name: "Payment Required" }
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
  
  // Check if we have success or cancelled params in URL or a pending checkout
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const success = params.get('success');
    const cancelled = params.get('cancelled');
    const bundleId = params.get('bundleId');
    
    // Check for stored checkout from localStorage
    const pendingCheckout = localStorage.getItem('whats_pdf_checkout_started');
    const storedBundleId = localStorage.getItem('whats_pdf_bundle_id');
    
    // If we return from successful payment
    if (success === 'true' && bundleId) {
      // Clear stored checkout if it matches
      if (pendingCheckout && storedBundleId === bundleId) {
        localStorage.removeItem('whats_pdf_checkout_started');
        localStorage.removeItem('whats_pdf_bundle_id');
      }
      toast({
        title: "Payment Successful!",
        description: "Thank you for your purchase. Your download is ready.",
      });
      
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
      
      // Fetch payment status and download URL
      const fetchPaymentDetails = async () => {
        try {
          console.log(`Fetching payment details for bundle ${bundleId}`);
          const response = await fetch(`/api/payment/${bundleId}`);
          
          if (!response.ok) {
            console.error(`Failed to fetch payment details, status: ${response.status}`);
            throw new Error('Failed to fetch payment details');
          }
          
          const data = await response.json();
          console.log(`Payment details retrieved:`, data);
          
          if (data.isPaid) {
            // Set bundle data for reference
            setBundleId(data.bundleId);
            setMessageCount(data.messageCount);
            setMediaSizeBytes(data.mediaSizeBytes);
            
            // Set the PDF URL and mark as processed
            if (data.pdfUrl) {
              console.log(`PDF URL found: ${data.pdfUrl}`);
              setPdfUrl(data.pdfUrl);
              setIsFileProcessed(true);
              setRequiresPayment(false);
              
              // Try to fetch chat data for preview
              if (data.chatExportId) {
                try {
                  console.log(`Fetching chat data for chat export ${data.chatExportId}`);
                  const chatResponse = await fetch(`/api/whatsapp/chat/${data.chatExportId}`);
                  if (chatResponse.ok) {
                    const chatData = await chatResponse.json();
                    console.log(`Chat data fetched successfully with ${chatData.messages?.length} messages`);
                    setChatData(chatData);
                  } else {
                    console.error(`Failed to fetch chat data, status: ${chatResponse.status}`);
                  }
                } catch (chatError) {
                  console.error('Error fetching chat data:', chatError);
                }
              } else {
                console.error('No chatExportId found in bundle data');
              }
            } else {
              console.error('Payment success but no PDF URL available');
              
              // Try to repair the PDF URL first
              console.log(`Attempting to repair PDF URL for bundle ${bundleId}`);
              try {
                const repairResponse = await fetch(`/api/payment/${bundleId}/repair`, {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                  },
                });
                
                if (repairResponse.ok) {
                  const repairData = await repairResponse.json();
                  
                  if (repairData.success && repairData.pdfUrl) {
                    console.log(`PDF URL repaired successfully: ${repairData.pdfUrl}`);
                    setPdfUrl(repairData.pdfUrl);
                    setIsFileProcessed(true);
                    setRequiresPayment(false);
                    
                    // Try to fetch the chat export data to display correctly
                    if (data.chatExportId) {
                      try {
                        const chatResponse = await fetch(`/api/whatsapp/chat/${data.chatExportId}`);
                        if (chatResponse.ok) {
                          const chatData = await chatResponse.json();
                          console.log('Fetched chat data:', chatData);
                          setChatData(chatData);
                        } else {
                          console.error('Failed to fetch chat data after payment');
                        }
                      } catch (chatError) {
                        console.error('Error fetching chat data after payment:', chatError);
                      }
                    }
                    
                    toast({
                      title: "Download Ready",
                      description: "Your payment was successful and your download is ready.",
                    });
                    
                    // Also clear pending checkout data
                    localStorage.removeItem('whats_pdf_checkout_started');
                    localStorage.removeItem('whats_pdf_bundle_id');
                    
                    // Clear URL parameters
                    window.history.replaceState({}, document.title, window.location.pathname);
                    
                    return; // Skip the retry since we fixed it
                  } else {
                    console.warn('Repair response OK but no PDF URL returned:', repairData);
                  }
                } else {
                  console.error(`Failed to repair PDF URL, status: ${repairResponse.status}`);
                  if (repairResponse.status === 404) {
                    const errorData = await repairResponse.json();
                    console.error('Repair error details:', errorData);
                  }
                }
              } catch (repairError) {
                console.error('Error repairing PDF URL:', repairError);
              }
              
              // Set a retry timer to check again in 3 seconds if repair failed
              setTimeout(() => {
                console.log('Retrying payment details fetch');
                fetchPaymentDetails();
              }, 3000);
              
              toast({
                title: "Processing Payment",
                description: "Your payment was successful. Preparing your download...",
              });
            }
          } else {
            console.warn('Bundle exists but is not marked as paid yet');
            
            // Set a retry timer in case the payment is being processed
            setTimeout(() => {
              console.log('Retrying payment status check');
              fetchPaymentDetails();
            }, 3000);
          }
        } catch (error) {
          console.error('Error fetching payment details:', error);
          toast({
            variant: "destructive",
            title: "Error",
            description: "Could not retrieve payment details. Please try again.",
          });
        }
      };
      
      fetchPaymentDetails();
    }
    
    if (cancelled === 'true') {
      // Clear any pending checkout data
      localStorage.removeItem('whats_pdf_checkout_started');
      localStorage.removeItem('whats_pdf_bundle_id');
      
      toast({
        variant: "destructive",
        title: "Payment Cancelled",
        description: "Your payment was cancelled. You can try again when ready.",
      });
      
      // Clear URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Check if we have a pending checkout but no success/cancel URL params
    // This happens if user refreshes page during checkout process
    if (pendingCheckout && storedBundleId && !success && !cancelled) {
      console.log(`Found pending checkout for bundle ${storedBundleId}`);
      
      // Try to fetch the payment status
      (async () => {
        try {
          console.log(`Checking payment status for pending checkout bundle ${storedBundleId}`);
          const response = await fetch(`/api/payment/${storedBundleId}`);
          
          if (!response.ok) {
            throw new Error(`Failed to fetch payment details, status: ${response.status}`);
          }
          
          const data = await response.json();
          console.log(`Payment status for pending checkout bundle:`, data);
          
          if (data.isPaid) {
            // Payment completed, show download
            console.log(`Bundle ${storedBundleId} is already paid, showing download`);
            setBundleId(data.bundleId);
            setMessageCount(data.messageCount);
            setMediaSizeBytes(data.mediaSizeBytes);
            
            if (data.pdfUrl) {
              setPdfUrl(data.pdfUrl);
              setIsFileProcessed(true);
              setRequiresPayment(false);
              
              // Try to fetch chat data for preview
              if (data.chatExportId) {
                try {
                  console.log(`Fetching chat data for chat export ${data.chatExportId}`);
                  const chatResponse = await fetch(`/api/whatsapp/chat/${data.chatExportId}`);
                  if (chatResponse.ok) {
                    const chatData = await chatResponse.json();
                    console.log(`Chat data fetched successfully with ${chatData.messages?.length} messages`);
                    setChatData(chatData);
                  } else {
                    console.error(`Failed to fetch chat data for pending resume, status: ${chatResponse.status}`);
                  }
                } catch (chatError) {
                  console.error('Error fetching chat data for pending resume:', chatError);
                }
              }
              
              toast({
                title: "Download Ready",
                description: "Your payment was successful and your download is ready.",
              });
              
              // Clear pending checkout
              localStorage.removeItem('whats_pdf_checkout_started');
              localStorage.removeItem('whats_pdf_bundle_id');
              
              // Clear URL parameters
              window.history.replaceState({}, document.title, window.location.pathname);
            } else {
              // Try the repair endpoint
              const repairResponse = await fetch(`/api/payment/${storedBundleId}/repair`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
              });
              
              if (repairResponse.ok) {
                const repairData = await repairResponse.json();
                
                if (repairData.success && repairData.pdfUrl) {
                  setPdfUrl(repairData.pdfUrl);
                  setIsFileProcessed(true);
                  setRequiresPayment(false);
                  
                  // Try to fetch chat data for preview
                  if (repairData.chatExportId) {
                    try {
                      console.log(`Fetching chat data for chat export ${repairData.chatExportId}`);
                      const chatResponse = await fetch(`/api/whatsapp/chat/${repairData.chatExportId}`);
                      if (chatResponse.ok) {
                        const chatData = await chatResponse.json();
                        console.log(`Chat data fetched successfully with ${chatData.messages?.length} messages`);
                        setChatData(chatData);
                      } else {
                        console.error(`Failed to fetch chat data, status: ${chatResponse.status}`);
                      }
                    } catch (chatError) {
                      console.error('Error fetching chat data:', chatError);
                    }
                  }
                  
                  // Clear pending checkout
                  localStorage.removeItem('whats_pdf_checkout_started');
                  localStorage.removeItem('whats_pdf_bundle_id');
                  
                  // Clear URL parameters
                  window.history.replaceState({}, document.title, window.location.pathname);
                  
                  toast({
                    title: "Download Ready",
                    description: "Your payment was successful and your download is ready.",
                  });
                }
              }
            }
          } else {
            // Payment still pending or failed, keep localStorage values for now
            console.log(`Bundle ${storedBundleId} pending payment`);
          }
        } catch (error) {
          console.error(`Error checking pending checkout:`, error);
        }
      })();
    }
  }, [toast]);

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
          <p className="text-sm text-gray-500 mt-2">
            Free tier: Up to {FREE_TIER_MESSAGE_LIMIT} messages and {FREE_TIER_MEDIA_SIZE_LIMIT / (1024 * 1024)}MB of media files
          </p>
        </div>

        <ProcessSteps />

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 max-w-6xl mx-auto">
          <div className="lg:col-span-2">
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
              setRequiresPayment={setRequiresPayment}
              setMessageCount={setMessageCount}
              setMediaSizeBytes={setMediaSizeBytes}
              setBundleId={setBundleId}
              setCheckoutUrl={setCheckoutUrl}
              setCurrentStep={setCurrentStep}
            />
            
            {requiresPayment && currentStep === ProcessingStep.PAYMENT_REQUIRED && (
              <PaymentRequired 
                messageCount={messageCount}
                mediaSizeBytes={mediaSizeBytes}
                bundleId={bundleId || ''}
                checkoutUrl={checkoutUrl}
                onPaymentComplete={() => {
                  setRequiresPayment(false);
                  setIsFileProcessed(true);
                }}
              />
            )}

            {isProcessing && !requiresPayment && (
              <ProcessingStatus 
                progress={processingProgress}
                steps={processingSteps}
              />
            )}
          </div>
          
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
