import { useEffect, useState } from 'react'
import AudioPlayer from './AudioPlayer'
import { Message, ChatExport } from '@shared/types'
import { format } from 'date-fns'

interface PDFPreviewProps {
  chatData: ChatExport | null
  pdfUrl: string | null
  currentPage: number
  totalPages: number
  setTotalPages: (pages: number) => void
  zoomLevel: number
  isFileProcessed: boolean
}

export default function PDFPreview({
  chatData,
  pdfUrl,
  currentPage,
  totalPages,
  setTotalPages,
  zoomLevel,
  isFileProcessed,
}: PDFPreviewProps) {
  const [groupedMessages, setGroupedMessages] = useState<{
    [date: string]: Message[]
  }>({})

  // Group messages by date when chatData changes
  useEffect(() => {
    if (chatData && chatData.messages) {
      const grouped = chatData.messages.reduce<{ [date: string]: Message[] }>(
        (acc, message) => {
          const date = format(new Date(message.timestamp), 'dd MMMM yyyy')
          if (!acc[date]) {
            acc[date] = []
          }
          acc[date].push(message)
          return acc
        },
        {},
      )

      setGroupedMessages(grouped)

      // Set total pages based on number of messages (roughly 10 messages per page)
      const totalMsgs = chatData.messages.length
      setTotalPages(Math.max(1, Math.ceil(totalMsgs / 10)))
    }
  }, [chatData, setTotalPages])

  // If we have the PDF URL, embed it directly
  if (pdfUrl && isFileProcessed) {
    return (
      <iframe
        src={pdfUrl}
        className="w-full h-full"
        style={{
          height: '800px',
          transform: `scale(${zoomLevel / 100})`,
          transformOrigin: 'top center',
        }}
        title="PDF Preview"
      />
    )
  }

  // Otherwise show a document preview of the chat data
  return (
    <div
      className="bg-white shadow-md mx-auto max-w-3xl min-h-[800px] p-8 font-source"
      style={{
        transform: `scale(${zoomLevel / 100})`,
        transformOrigin: 'top center',
      }}
    >
      {/* Document Header */}
      <div className="border-b-2 border-gray-200 pb-4 mb-6">
        <h1 className="text-xl font-bold text-center uppercase mb-1">
          CHAT TRANSCRIPT EVIDENCE
        </h1>
        <h2 className="text-lg text-center mb-4">WhatsApp Conversation</h2>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p>
              <span className="font-semibold">Case Reference:</span> WA-
              {format(new Date(), 'yyyyMMdd-HHmm')}
            </p>
            <p>
              <span className="font-semibold">Generated On:</span>{' '}
              {format(new Date(), 'dd MMM yyyy, HH:mm')}
            </p>
          </div>
          <div>
            <p>
              <span className="font-semibold">File SHA-256:</span>{' '}
              {chatData?.fileHash
                ? chatData.fileHash.substring(0, 6) + '...'
                : '---'}
            </p>
            <p>
              <span className="font-semibold">Participants:</span>{' '}
              {chatData?.participants?.join(', ') || '---'}
            </p>
          </div>
        </div>
      </div>

      {/* Chat Messages */}
      <div className="space-y-4">
        {Object.entries(groupedMessages).map(([date, messages], dateIndex) => (
          <div key={date}>
            {/* Date Separator */}
            <div className="flex justify-center mb-4">
              <div className="bg-gray-100 text-gray-500 text-sm py-1 px-3 rounded-full">
                {date}
              </div>
            </div>

            {messages.map((message, msgIndex) => (
              <div className="flex flex-col" key={`${dateIndex}-${msgIndex}`}>
                <div className="flex items-start mb-1">
                  <span className="text-xs text-gray-500 mr-2">
                    {format(new Date(message.timestamp), 'HH:mm')}
                  </span>
                  <span
                    className={`font-semibold text-sm ${
                      message.sender === chatData?.participants?.[0]
                        ? 'text-primary'
                        : 'text-secondary'
                    }`}
                  >
                    {message.sender}
                  </span>
                </div>
                <div
                  className={`rounded-lg p-3 ml-6 ${
                    message.sender === chatData?.participants?.[0]
                      ? 'bg-gray-100'
                      : 'bg-blue-50'
                  }`}
                >
                  {message.type === 'voice' ? (
                    <AudioPlayer
                      audioUrl={message.content}
                      duration={message.duration || 0}
                    />
                  ) : (
                    <p className="text-sm">{message.content}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}

        {/* Page number */}
        <div className="text-center text-xs text-gray-500 mt-8">
          Page {currentPage} of {totalPages}
        </div>
      </div>
    </div>
  )
}
