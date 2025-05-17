import { useState, useRef, useEffect } from 'react'
import { Play, Pause } from 'lucide-react'
import { Progress } from '@/components/ui/progress'

interface AudioPlayerProps {
  audioUrl: string
  duration: number
}

export default function AudioPlayer({ audioUrl, duration }: AudioPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    // Create audio element
    if (!audioRef.current) {
      audioRef.current = new Audio(audioUrl)

      audioRef.current.addEventListener('timeupdate', () => {
        if (audioRef.current) {
          const currentTime = audioRef.current.currentTime
          const duration = audioRef.current.duration || 1
          setProgress((currentTime / duration) * 100)
          setCurrentTime(currentTime)
        }
      })

      audioRef.current.addEventListener('ended', () => {
        setIsPlaying(false)
        setProgress(0)
        setCurrentTime(0)
      })
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
        audioRef.current.src = ''
        audioRef.current = null
      }
    }
  }, [audioUrl])

  const togglePlayback = () => {
    if (!audioRef.current) return

    if (isPlaying) {
      audioRef.current.pause()
    } else {
      audioRef.current.play().catch((err) => {
        console.error('Failed to play audio:', err)
      })
    }

    setIsPlaying(!isPlaying)
  }

  const formatTime = (seconds: number) => {
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = Math.floor(seconds % 60)
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`
  }

  return (
    <div className="flex items-center space-x-2 bg-white p-2 rounded border border-gray-200">
      <button
        className="w-8 h-8 flex items-center justify-center bg-accent hover:bg-accent/90 rounded-full text-white"
        onClick={togglePlayback}
      >
        {isPlaying ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <div className="flex-1">
        <Progress value={progress} className="h-1.5" />
      </div>
      <span className="text-xs text-gray-500">
        {formatTime(duration ? duration : currentTime)}
      </span>
    </div>
  )
}
