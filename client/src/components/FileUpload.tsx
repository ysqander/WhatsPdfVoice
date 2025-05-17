import { useState, useRef } from 'react'
import { UploadCloud, X } from 'lucide-react'
import { useToast } from '@/hooks/use-toast'
import { Progress } from '@/components/ui/progress'

interface FileUploadProps {
  file: File | null
  setFile: (file: File | null) => void
  isUploading: boolean
  setIsUploading: (isUploading: boolean) => void
  uploadProgress: number
  setUploadProgress: (progress: number | ((prev: number) => number)) => void
  resetState: () => void
}

export default function FileUpload({
  file,
  setFile,
  isUploading: _isUploading,
  setIsUploading,
  uploadProgress,
  setUploadProgress,
  resetState,
}: FileUploadProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)
  const { toast } = useToast()

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const validateFile = (file: File): boolean => {
    // Check if it's a ZIP file
    if (!file.name.toLowerCase().endsWith('.zip')) {
      toast({
        variant: 'destructive',
        title: 'Invalid File Type',
        description: 'Please upload a WhatsApp export ZIP file.',
      })
      return false
    }

    // Check file size (100MB limit)
    if (file.size > 100 * 1024 * 1024) {
      toast({
        variant: 'destructive',
        title: 'File Too Large',
        description: 'Please upload a file smaller than 100MB.',
      })
      return false
    }

    return true
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFile = e.dataTransfer.files[0]
      if (validateFile(droppedFile)) {
        handleFileSelection(droppedFile)
      }
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0]
      if (validateFile(selectedFile)) {
        handleFileSelection(selectedFile)
      }
    }
  }

  const handleFileSelection = (selectedFile: File) => {
    resetState()
    setFile(selectedFile)
    simulateUpload()
  }

  const simulateUpload = () => {
    setIsUploading(true)
    setUploadProgress(0)

    // Simulate upload progress
    const interval = setInterval(() => {
      setUploadProgress((prev: number) => {
        if (prev >= 100) {
          clearInterval(interval)
          setIsUploading(false)
          return 100
        }
        return prev + 5
      })
    }, 100)
  }

  const handleRemoveFile = () => {
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
    resetState()
  }

  return (
    <div>
      <div
        className={`border-2 border-dashed rounded-lg p-6 text-center hover:border-accent transition-colors cursor-pointer ${
          dragActive ? 'border-accent bg-accent/5' : 'border-gray-300'
        }`}
        onDragEnter={handleDrag}
        onDragOver={handleDrag}
        onDragLeave={handleDrag}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept=".zip"
          onChange={handleFileSelect}
        />
        <UploadCloud className="h-10 w-10 text-gray-400 mx-auto mb-3" />
        <h3 className="font-bold mb-2">Drag & Drop your ZIP file</h3>
        <p className="text-sm text-gray-500 mb-3">or</p>
        <button className="bg-accent hover:bg-accent/90 text-white px-4 py-2 rounded-md font-medium transition-colors">
          Browse Files
        </button>
        <p className="text-xs text-gray-500 mt-3">
          Only WhatsApp export ZIP files are supported (max 100MB)
        </p>
      </div>

      {file && (
        <div className="mt-4">
          <div className="flex items-center mb-2">
            <i className="fas fa-file-archive text-lg text-gray-500 mr-2"></i>
            <span className="mr-auto font-medium text-sm truncate">
              {file.name}
            </span>
            <button
              className="text-red-500 hover:text-red-700 transition-colors"
              onClick={(e) => {
                e.stopPropagation()
                handleRemoveFile()
              }}
            >
              <X size={16} />
            </button>
          </div>

          <Progress value={uploadProgress} className="h-2.5 mb-4" />
        </div>
      )}
    </div>
  )
}
