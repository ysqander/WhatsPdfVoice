import Header from '@/components/Header'
import Footer from '@/components/Footer'
import ProcessSteps from '@/components/ProcessSteps'
import UploadSection from '@/components/UploadSection'
import PreviewSection from '@/components/PreviewSection'
import PaymentRequired from '@/components/PaymentRequired'
import ProcessingStatus from '@/components/ProcessingStatus'
import { useState, useEffect, useRef } from 'react'
import {
  ChatExport,
  ProcessingOptions,
  ProcessingStep,
  FREE_TIER_MESSAGE_LIMIT,
  FREE_TIER_MEDIA_SIZE_LIMIT,
} from '@shared/types'
import { useToast } from '@/hooks/use-toast'

export default function Home() {
  const { toast } = useToast()
  const [file, setFile] = useState<File | null>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingProgress, setProcessingProgress] = useState(0)
  const [processingSteps, setProcessingSteps] = useState<
    Array<{ done: boolean; text: string; name?: string }>
  >([
    { done: false, text: 'Extracting ZIP contents...' },
    { done: false, text: 'Parsing chat messages...' },
    { done: false, text: 'Converting voice messages...' },
    { done: false, text: 'Generating PDF document...' },
    { done: false, text: 'Payment required...', name: 'Payment Required' },
  ])
  const [isFileProcessed, setIsFileProcessed] = useState(false)
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [chatData, setChatData] = useState<ChatExport | null>(null)
  const [processingOptions, setProcessingOptions] = useState<ProcessingOptions>(
    {
      includeVoiceMessages: true,
      includeTimestamps: true,
      highlightSenders: true,
      includeImages: false,
      includeAttachments: false,
    },
  )

  // Payment-related state
  const [requiresPayment, setRequiresPayment] = useState(false)
  const [messageCount, setMessageCount] = useState(0)
  const [mediaSizeBytes, setMediaSizeBytes] = useState(0)
  const [bundleId, setBundleId] = useState<string | null>(null)
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState<ProcessingStep | null>(null)

  // Check if we have success or cancelled params in URL or a pending checkout
  const [pollingAttempts, setPollingAttempts] = useState(0)
  const [isPolling, setIsPolling] = useState(false)
  const [pollingError, setPollingError] = useState<string | null>(null)
  const [showRepair, setShowRepair] = useState(false)
  const pollingTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Helper: Poll for payment status and PDF URL
  const pollForPdfUrl = async (bundleId: string, maxAttempts = 3) => {
    setIsPolling(true)
    setPollingError(null)
    setShowRepair(false)
    let attempts = 0
    const intervals = [3000, 7000, 15000]

    const poll = async () => {
      attempts++
      try {
        const response = await fetch(`/api/payment/${bundleId}`)
        if (!response.ok) throw new Error('Failed to fetch payment details')
        const data = await response.json()
        if (data.isPaid && data.pdfUrl) {
          setPdfUrl(data.pdfUrl)
          setIsFileProcessed(true)
          setRequiresPayment(false)
          setPollingError(null)
          setIsPolling(false)
          setShowRepair(false)
          // Optionally fetch chat data
          if (data.chatExportId) {
            try {
              const chatResponse = await fetch(
                `/api/whatsapp/chat/${data.chatExportId}`,
              )
              if (chatResponse.ok) {
                const chatData = await chatResponse.json()
                setChatData(chatData)
              }
            } catch {}
          }
          toast({
            title: 'Download Ready',
            description:
              'Your payment was successful and your download is ready.',
          })
          return
        }
        if (attempts < maxAttempts) {
          setPollingAttempts(attempts)
          pollingTimeoutRef.current = setTimeout(
            poll,
            intervals[attempts - 1] || 15000,
          )
        } else {
          setIsPolling(false)
          setShowRepair(true)
          setPollingError(
            'Your payment was successful, but the download is not ready yet. You can retry repair below or contact support.',
          )
        }
      } catch (err) {
        setIsPolling(false)
        setShowRepair(true)
        setPollingError(
          'Error checking payment status. Please try again or use the repair option below.',
        )
      }
    }
    poll()
  }

  // Manual repair handler
  const handleManualRepair = async () => {
    if (!bundleId) return
    setPollingError(null)
    setIsPolling(true)
    setShowRepair(false)
    try {
      const repairResponse = await fetch(`/api/payment/${bundleId}/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      if (repairResponse.ok) {
        const repairData = await repairResponse.json()
        if (repairData.success && repairData.pdfUrl) {
          setPdfUrl(repairData.pdfUrl)
          setIsFileProcessed(true)
          setRequiresPayment(false)
          setShowRepair(false)
          setPollingError(null)
          // Optionally fetch chat data
          if (repairData.chatExportId) {
            try {
              const chatResponse = await fetch(
                `/api/whatsapp/chat/${repairData.chatExportId}`,
              )
              if (chatResponse.ok) {
                const chatData = await chatResponse.json()
                setChatData(chatData)
              }
            } catch {}
          }
          toast({
            title: 'Download Ready',
            description:
              'Your payment was successful and your download is ready.',
          })
          return
        } else {
          setPollingError(
            'Repair did not succeed. Please try again or contact support.',
          )
          setShowRepair(true)
        }
      } else {
        setPollingError(
          'Repair request failed. Please try again or contact support.',
        )
        setShowRepair(true)
      }
    } catch (err) {
      setPollingError(
        'Repair request failed. Please try again or contact support.',
      )
      setShowRepair(true)
    }
    setIsPolling(false)
  }

  // Main effect for post-payment polling
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const success = params.get('success')
    const cancelled = params.get('cancelled')
    const urlBundleId = params.get('bundleId')
    const pendingCheckout = localStorage.getItem('whats_pdf_checkout_started')
    const storedBundleId = localStorage.getItem('whats_pdf_bundle_id')

    if (success === 'true' && urlBundleId) {
      if (pendingCheckout && storedBundleId === urlBundleId) {
        localStorage.removeItem('whats_pdf_checkout_started')
        localStorage.removeItem('whats_pdf_bundle_id')
      }
      toast({
        title: 'Payment Successful!',
        description: 'Thank you for your purchase. Your download is ready.',
      })
      window.history.replaceState({}, document.title, window.location.pathname)
      setBundleId(urlBundleId)
      setIsFileProcessed(false)
      setPdfUrl(null)
      setChatData(null)
      setPollingAttempts(0)
      pollForPdfUrl(urlBundleId)
    }
    if (cancelled === 'true') {
      localStorage.removeItem('whats_pdf_checkout_started')
      localStorage.removeItem('whats_pdf_bundle_id')
      toast({
        variant: 'destructive',
        title: 'Payment Cancelled',
        description:
          'Your payment was cancelled. You can try again when ready.',
      })
      window.history.replaceState({}, document.title, window.location.pathname)
    }
    if (pendingCheckout && storedBundleId && !success && !cancelled) {
      setBundleId(storedBundleId)
      setIsFileProcessed(false)
      setPdfUrl(null)
      setChatData(null)
      setPollingAttempts(0)
      pollForPdfUrl(storedBundleId)
    }
    return () => {
      if (pollingTimeoutRef.current) clearTimeout(pollingTimeoutRef.current)
    }
  }, [toast])

  const resetState = () => {
    setFile(null)
    setIsUploading(false)
    setUploadProgress(0)
    setIsProcessing(false)
    setProcessingProgress(0)
    setIsFileProcessed(false)
    setPdfUrl(null)
    setChatData(null)
    setProcessingSteps(
      processingSteps.map((step) => ({ ...step, done: false })),
    )
  }

  return (
    <div className="bg-gray-100 font-roboto text-text min-h-screen flex flex-col">
      <Header />

      <main className="container mx-auto px-4 py-8 flex-grow">
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold text-primary mb-2">
            Convert WhatsApp Chats to Court-Admissible PDFs
          </h2>
          <p className="text-gray-600 max-w-3xl mx-auto">
            Upload your WhatsApp chat export (ZIP) and generate a professional
            PDF document with preserved voice messages as interactive audio
            elements.
          </p>
          <p className="text-sm text-gray-500 mt-2">
            Free tier: Up to {FREE_TIER_MESSAGE_LIMIT} messages and{' '}
            {FREE_TIER_MEDIA_SIZE_LIMIT / (1024 * 1024)}MB of media files
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

            {requiresPayment &&
              currentStep === ProcessingStep.PAYMENT_REQUIRED && (
                <PaymentRequired
                  messageCount={messageCount}
                  mediaSizeBytes={mediaSizeBytes}
                  bundleId={bundleId || ''}
                  onPaymentComplete={() => {
                    setRequiresPayment(false)
                    setIsFileProcessed(true)
                  }}
                />
              )}

            {isProcessing && !requiresPayment && (
              <ProcessingStatus
                progress={processingProgress}
                steps={processingSteps}
              />
            )}

            {isPolling && (
              <div className="my-4 text-center text-blue-600">
                Preparing your download... (Attempt {pollingAttempts + 1})
              </div>
            )}
            {pollingError && (
              <div className="my-4 text-center text-red-600">
                {pollingError}
              </div>
            )}
            {showRepair && (
              <div className="my-4 text-center">
                <button
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                  onClick={handleManualRepair}
                  disabled={isPolling}
                >
                  Retry Repair
                </button>
              </div>
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
  )
}
