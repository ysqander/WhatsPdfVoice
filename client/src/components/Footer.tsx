import { FileText } from 'lucide-react'

export default function Footer() {
  return (
    <footer className="bg-primary text-white mt-12 py-6">
      <div className="container mx-auto px-4">
        <div className="flex flex-col md:flex-row justify-between items-center">
          <div className="mb-4 md:mb-0">
            <h2 className="text-xl font-bold flex items-center">
              <FileText className="w-6 h-6 mr-2" />
              WhatsPDF Voice
            </h2>
            <p className="text-sm text-gray-300 mt-1">
              Convert WhatsApp chats to court-admissible PDFs
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-300">
              © {new Date().getFullYear()} WhatsPDF Voice. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  )
}
