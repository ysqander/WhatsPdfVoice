import { useState } from "react";
import { ChevronLeft, ChevronRight, SquareMinus, SearchCode } from "lucide-react";
import PDFPreview from "./PDFPreview";
import { ChatExport } from "@shared/types";

interface PreviewSectionProps {
  chatData: ChatExport | null;
  pdfUrl: string | null;
  isFileProcessed: boolean;
}

export default function PreviewSection({ 
  chatData, 
  pdfUrl,
  isFileProcessed 
}: PreviewSectionProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [zoomLevel, setZoomLevel] = useState(100);
  
  const handlePreviousPage = () => {
    if (currentPage > 1) {
      setCurrentPage(currentPage - 1);
    }
  };
  
  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(currentPage + 1);
    }
  };
  
  const handleZoomIn = () => {
    setZoomLevel(prev => Math.min(prev + 10, 200));
  };
  
  const handleZoomOut = () => {
    setZoomLevel(prev => Math.max(prev - 10, 50));
  };
  
  return (
    <div className="lg:col-span-3">
      <div className="bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
        <div className="bg-primary text-white py-3 px-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">PDF Preview</h2>
          <div className="flex space-x-2">
            <button 
              className="text-white hover:text-accent transition-colors" 
              title="Previous Page"
              onClick={handlePreviousPage}
              disabled={currentPage <= 1}
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm">
              Page <span>{currentPage}</span> of <span>{totalPages}</span>
            </span>
            <button 
              className="text-white hover:text-accent transition-colors" 
              title="Next Page"
              onClick={handleNextPage}
              disabled={currentPage >= totalPages}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
        
        {/* PDF Preview Area */}
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
        
        {/* Zoom controls */}
        <div className="p-2 bg-gray-50 border-t border-gray-200 flex justify-center items-center space-x-4">
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
      </div>
    </div>
  );
}
