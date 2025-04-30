import { FileUp, Cog, Download } from "lucide-react";

export default function ProcessSteps() {
  return (
    <div className="max-w-4xl mx-auto mb-8">
      <div className="flex flex-wrap justify-between items-start text-center">
        <div className="w-full md:w-1/3 px-2 mb-4 md:mb-0">
          <div className="bg-white rounded-lg p-4 shadow-md h-full">
            <div className="w-12 h-12 flex items-center justify-center rounded-full bg-primary text-white mx-auto mb-3">
              <FileUp className="w-5 h-5" />
            </div>
            <h3 className="font-bold mb-2">Upload</h3>
            <p className="text-sm text-gray-600">Upload your WhatsApp chat export ZIP file containing conversation data and media.</p>
          </div>
        </div>
        <div className="w-full md:w-1/3 px-2 mb-4 md:mb-0">
          <div className="bg-white rounded-lg p-4 shadow-md h-full">
            <div className="w-12 h-12 flex items-center justify-center rounded-full bg-secondary text-white mx-auto mb-3">
              <Cog className="w-5 h-5" />
            </div>
            <h3 className="font-bold mb-2">Process</h3>
            <p className="text-sm text-gray-600">Our system extracts messages and converts voice notes to interactive audio elements.</p>
          </div>
        </div>
        <div className="w-full md:w-1/3 px-2">
          <div className="bg-white rounded-lg p-4 shadow-md h-full">
            <div className="w-12 h-12 flex items-center justify-center rounded-full bg-accent text-white mx-auto mb-3">
              <Download className="w-5 h-5" />
            </div>
            <h3 className="font-bold mb-2">Download</h3>
            <p className="text-sm text-gray-600">Download your court-admissible PDF with timestamps, sender highlighting, and playable voice notes.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
