import { useState } from 'react'
import { useToast } from '@/hooks/use-toast'
import FileUpload from './FileUpload'
import ProcessingOptions from './ProcessingOptions'
import ProcessingStatus from './ProcessingStatus'
import { Cog, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { apiRequest } from '@/lib/queryClient'
import {
  ChatExport,
  ProcessingOptions as ProcessingOptionsType,
  ProcessingStep,
} from '@shared/types'

interface UploadSectionProps {
  file: File | null
  setFile: (file: File | null) => void
  isUploading: boolean
  setIsUploading: (isUploading: boolean) => void
  uploadProgress: number
  setUploadProgress: (progress: number) => void
  isProcessing: boolean
  setIsProcessing: (isProcessing: boolean) => void
  processingProgress: number
  setProcessingProgress: (progress: number) => void
  processingSteps: Array<{ done: boolean; text: string; name?: string }>
  setProcessingSteps: React.Dispatch<
    React.SetStateAction<Array<{ done: boolean; text: string; name?: string }>>
  >
  isFileProcessed: boolean
  setIsFileProcessed: (isProcessed: boolean) => void
  setPdfUrl: (url: string | null) => void
  setChatData: (data: ChatExport | null) => void
  processingOptions: ProcessingOptionsType
  setProcessingOptions: (options: ProcessingOptionsType) => void
  resetState: () => void
  // Payment-related props
  setRequiresPayment?: (requires: boolean) => void
  setMessageCount?: (count: number) => void
  setMediaSizeBytes?: (size: number) => void
  setBundleId?: (id: string | null) => void
  setCheckoutUrl?: (url: string | null) => void
  setCurrentStep?: (step: ProcessingStep | null) => void
}

export default function UploadSection({
  file,
  setFile,
  isUploading,
  setIsUploading,
  uploadProgress,
  setUploadProgress,
  isProcessing,
  setIsProcessing,
  processingProgress,
  setProcessingProgress,
  processingSteps,
  setProcessingSteps,
  isFileProcessed,
  setIsFileProcessed,
  setPdfUrl,
  setChatData,
  processingOptions,
  setProcessingOptions,
  resetState,
  // Payment-related props
  setRequiresPayment,
  setMessageCount,
  setMediaSizeBytes,
  setBundleId,
  setCheckoutUrl,
  setCurrentStep,
}: UploadSectionProps) {
  const { toast } = useToast()

  const handleProcessFile = async () => {
    if (!file || isProcessing) return

    setIsProcessing(true)

    try {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('options', JSON.stringify(processingOptions))

      // Make request with correct headers
      const response = await fetch('/api/whatsapp/process', {
        method: 'POST',
        body: formData,
        // Don't set Content-Type header - browser will set it with boundary
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.message || 'Error processing file')
      }

      const data = await response.json()

      // Update processing steps
      const updateStep = (index: number, done: boolean) => {
        setProcessingSteps((prevSteps) => {
          const steps = prevSteps as Array<{
            done: boolean
            text: string
            name?: string
          }>
          return steps.map((step, i) =>
            i === index ? { ...step, done } : step,
          )
        })
      }

      // Track processing with progress events
      const source = new EventSource(
        `/api/whatsapp/process-status?clientId=${data.clientId}`,
      )
      source.onmessage = (event) => {
        const data = JSON.parse(event.data)
        setProcessingProgress(data.progress)

        if (data.step !== undefined) {
          // Mark previous steps as done
          for (let i = 0; i < data.step; i++) {
            updateStep(i, true)
          }

          // Mark current step as in progress
          if (data.step < processingSteps.length) {
            updateStep(data.step, false)
          }

          // Check if we're at the payment required step
          if (data.step === ProcessingStep.PAYMENT_REQUIRED && setCurrentStep) {
            setCurrentStep(ProcessingStep.PAYMENT_REQUIRED)

            // Mark the payment step as done
            const paymentStepIndex = processingSteps.findIndex(
              (step) => step.name === 'Payment Required',
            )
            if (paymentStepIndex !== -1) {
              updateStep(paymentStepIndex, true)
            }
          }
        }

        // Check if payment is required
        if (data.requiresPayment && setRequiresPayment) {
          setRequiresPayment(true)

          // Set payment-related information
          if (setMessageCount && data.messageCount) {
            setMessageCount(data.messageCount)
          }

          if (setMediaSizeBytes && data.mediaSizeBytes) {
            setMediaSizeBytes(data.mediaSizeBytes)
          }

          if (setBundleId && data.bundleId) {
            setBundleId(data.bundleId)
          }

          if (setCheckoutUrl && data.checkoutUrl) {
            setCheckoutUrl(data.checkoutUrl)
          }
        }

        if (data.done) {
          source.close()

          // Only mark as processed if no payment is required or we have a PDF URL
          if (!data.requiresPayment || data.pdfUrl) {
            setIsFileProcessed(true)
            setIsProcessing(false)

            // Mark all steps as done
            processingSteps.forEach((_, index) => {
              updateStep(index, true)
            })

            setPdfUrl(data.pdfUrl)
            setChatData(data.chatData)
          } else {
            // Stop processing but don't mark as done
            setIsProcessing(false)
          }
        }
      }

      source.onerror = () => {
        source.close()

        // If we are at the payment required step, this is actually expected
        // We don't want to show an error toast
        if (
          processingSteps.find((step) => step.name === 'Payment Required')?.done
        ) {
          console.log(
            'EventSource connection closed after payment requirement detected',
          )
          setIsProcessing(false)
        } else {
          setIsProcessing(false)
          toast({
            variant: 'destructive',
            title: 'Error processing file',
            description: 'Connection to server lost',
          })
        }
      }
    } catch (error) {
      setIsProcessing(false)
      toast({
        variant: 'destructive',
        title: 'Error processing file',
        description:
          error instanceof Error ? error.message : 'An unknown error occurred',
      })
    }
  }

  const handleDownloadPdf = () => {
    if (!isFileProcessed) return

    // Create a link to download the PDF
    const link = document.createElement('a')
    link.href = `/api/whatsapp/download`
    link.download = `WhatsApp_Chat_Export_${new Date()
      .toISOString()
      .slice(0, 10)}.pdf`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  return (
    <div className="lg:col-span-2">
      <div className="bg-white rounded-lg shadow-md overflow-hidden">
        <div className="bg-primary text-white py-3 px-4">
          <h2 className="text-lg font-semibold">Upload WhatsApp Chat</h2>
        </div>

        <div className="p-4">
          <FileUpload
            file={file}
            setFile={setFile}
            isUploading={isUploading}
            setIsUploading={setIsUploading}
            uploadProgress={uploadProgress}
            setUploadProgress={
              setUploadProgress as (
                progress: number | ((prev: number) => number),
              ) => void
            }
            resetState={resetState}
          />

          <ProcessingOptions
            options={processingOptions}
            setOptions={setProcessingOptions}
          />

          <div className="mt-6">
            <Button
              className="w-full mb-3 flex justify-center items-center"
              variant="default"
              disabled={!file || isProcessing}
              onClick={handleProcessFile}
            >
              {isProcessing ? (
                <>
                  <Cog className="mr-2 h-4 w-4 animate-spin" />
                  <span>Processing...</span>
                </>
              ) : (
                <>
                  <Cog className="mr-2 h-4 w-4" />
                  <span>Process File</span>
                </>
              )}
            </Button>

            {isFileProcessed && (
              <Button
                className="w-full bg-success hover:bg-success/90 flex justify-center items-center"
                onClick={handleDownloadPdf}
              >
                <Download className="mr-2 h-4 w-4" />
                <span>Download PDF</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
