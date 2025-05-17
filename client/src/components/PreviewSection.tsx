import { useState } from 'react'
import {
  SquareMinus,
  SearchCode,
  Download,
  Archive,
  FileDown,
} from 'lucide-react'
import PDFPreview from './PDFPreview'
import { ChatExport } from '@shared/types'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

interface PreviewSectionProps {
  chatData: ChatExport | null
  pdfUrl: string | null
  isFileProcessed: boolean
}

export default function PreviewSection({
  chatData,
  pdfUrl,
  isFileProcessed,
}: PreviewSectionProps) {
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [zoomLevel, setZoomLevel] = useState(100)

  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1)
    }
  }

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1)
    }
  }

  const handleZoomIn = () => {
    setZoomLevel((prev) => Math.min(prev + 10, 200))
  }

  const handleZoomOut = () => {
    setZoomLevel((prev) => Math.max(prev - 10, 50))
  }

  const handleDownloadOfflinePackage = () => {
    // Only proceed if we have a chat ID
    if (chatData?.id) {
      // Open the evidence zip download URL in a new tab
      window.open(`/api/whatsapp/evidence-zip/${chatData.id}`, '_blank')
    }
  }

  return (
    <div className="lg:col-span-3">
      <div className="bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
        <div className="bg-primary text-white py-3 px-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">PDF Preview</h2>
        </div>

        {/* PDF Content */}
        <div className="flex-1 overflow-auto p-4 bg-gray-100">
          <PDFPreview
            chatData={chatData}
            pdfUrl={pdfUrl}
            currentPage={currentPage}
            totalPages={totalPages}
            setTotalPages={setTotalPages}
            zoomLevel={zoomLevel}
            isFileProcessed={isFileProcessed}
          />
        </div>

        {/* Footer controls */}
        <div className="p-2 bg-gray-50 border-t border-gray-200 flex justify-between items-center">
          <div className="flex items-center space-x-4">
            <button
              className="text-gray-600 hover:text-primary transition-colors"
              title="Zoom Out"
              onClick={handleZoomOut}
            >
              <SquareMinus size={16} />
            </button>
            <span className="text-sm">{zoomLevel}%</span>
            <button
              className="text-gray-600 hover:text-primary transition-colors"
              title="Zoom In"
              onClick={handleZoomIn}
            >
              <SearchCode size={16} />
            </button>
          </div>

          {isFileProcessed && pdfUrl && (
            <div className="flex gap-2">
              {/* PDF Download button */}
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => window.open(pdfUrl, '_blank')}
              >
                <FileDown className="mr-1 h-3 w-3" />
                View PDF
              </Button>

              {/* Evidence Package Download button */}
              <Button
                variant="default"
                size="sm"
                className="text-xs"
                onClick={handleDownloadOfflinePackage}
                disabled={!chatData?.id}
              >
                <Archive className="mr-1 h-3 w-3" />
                Download Evidence Package
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
