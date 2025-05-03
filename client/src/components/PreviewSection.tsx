import { useState } from "react";
import { ChevronLeft, ChevronRight, SquareMinus, SearchCode, Download, Archive, Database } from "lucide-react";
import PDFPreview from "./PDFPreview";
import MediaList from "./MediaList";
import { ChatExport } from "@shared/types";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

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
  const [currentTab, setCurrentTab] = useState("pdf");
  const [mediaUpdated, setMediaUpdated] = useState(0);
  
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

  const handleMediaDeleted = () => {
    // Increment counter to trigger refreshes
    setMediaUpdated(prev => prev + 1);
  };
  
  return (
    <div className="lg:col-span-3">
      <div className="bg-white rounded-lg shadow-md overflow-hidden h-full flex flex-col">
        <div className="bg-primary text-white py-3 px-4 flex justify-between items-center">
          <h2 className="text-lg font-semibold">
            {currentTab === "pdf" ? "PDF Preview" : "Media Files"}
          </h2>
          
          {currentTab === "pdf" && (
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
          )}
        </div>
        
        {/* Tabs for PDF and Media */}
        <Tabs 
          value={currentTab} 
          onValueChange={setCurrentTab}
          className="flex-1 flex flex-col"
        >
          <div className="border-b border-gray-200">
            <TabsList className="w-full justify-start bg-white h-10 p-0">
              <TabsTrigger 
                value="pdf" 
                className="data-[state=active]:bg-gray-100 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-10"
              >
                PDF Preview
              </TabsTrigger>
              <TabsTrigger 
                value="media" 
                className="data-[state=active]:bg-gray-100 data-[state=active]:border-b-2 data-[state=active]:border-primary rounded-none h-10"
              >
                Media Files
              </TabsTrigger>
            </TabsList>
          </div>
          
          {/* PDF Content */}
          <TabsContent value="pdf" className="flex-1 overflow-auto p-4 bg-gray-100 m-0">
            <PDFPreview 
              chatData={chatData}
              pdfUrl={pdfUrl}
              currentPage={currentPage}
              totalPages={totalPages}
              setTotalPages={setTotalPages}
              zoomLevel={zoomLevel}
              isFileProcessed={isFileProcessed}
              key={`pdf-preview-${mediaUpdated}`}
            />
          </TabsContent>
          
          {/* Media Content */}
          <TabsContent value="media" className="flex-1 overflow-auto p-4 bg-gray-100 m-0">
            {isFileProcessed && chatData?.id ? (
              <MediaList 
                chatId={chatData.id} 
                onDeleteMedia={handleMediaDeleted}
                key={`media-list-${mediaUpdated}`}
              />
            ) : (
              <div className="p-4 text-center text-gray-500">
                Process a file to see media content.
              </div>
            )}
          </TabsContent>
        </Tabs>
        
        {/* Footer controls */}
        <div className="p-2 bg-gray-50 border-t border-gray-200 flex justify-between items-center">
          {currentTab === "pdf" ? (
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
          ) : (
            <div>
              <Button 
                variant="ghost"
                size="sm"
                onClick={() => setMediaUpdated(prev => prev + 1)}
                className="text-xs"
              >
                <Database className="mr-1 h-3 w-3" />
                Refresh Files
              </Button>
            </div>
          )}
          
          {isFileProcessed && chatData?.id && (
            <div className="flex space-x-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => window.open(pdfUrl || '', '_blank')}
                disabled={!pdfUrl}
              >
                <Download className="mr-1 h-3 w-3" />
                PDF
              </Button>
              
              <Button
                variant="default"
                size="sm"
                className="text-xs bg-accent hover:bg-accent/90"
                onClick={() => window.open(`/api/whatsapp/evidence-zip/${chatData.id}`, '_blank')}
              >
                <Archive className="mr-1 h-3 w-3" />
                Evidence ZIP
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
