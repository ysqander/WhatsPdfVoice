import { FileText } from 'lucide-react'

export default function Header() {
  return (
    <header className="bg-primary text-white shadow-md">
      <div className="container mx-auto px-4 py-4 flex justify-between items-center">
        <div className="flex items-center">
          <FileText className="w-8 h-8 mr-3" />
          <h1 className="text-2xl font-bold">WhatsPDF Voice</h1>
        </div>
        <div>
          <a
            href="#"
            className="text-white hover:text-accent transition-colors"
          >
            <i className="fas fa-question-circle mr-1"></i> Help
          </a>
        </div>
      </div>
    </header>
  )
}
