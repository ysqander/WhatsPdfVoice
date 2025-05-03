import { useState, useEffect } from "react";
import {
  Trash,
  FileAudio,
  FileImage,
  File,
  FileText,
  ExternalLink,
  AlertTriangle
} from "lucide-react";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "./ui/alert";
import { Badge } from "./ui/badge";
import { apiRequest } from "@/lib/queryClient";
import { formatDistanceToNow } from "date-fns";

interface MediaFile {
  id: string;
  key: string;
  originalName: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  expiresAt?: string;
  url?: string;
  type: 'voice' | 'image' | 'attachment' | 'pdf';
}

interface MediaListProps {
  sessionId?: number; // Just a reference ID, not storing actual chat data anymore
  onDeleteMedia?: () => void;
}

export default function MediaList({ sessionId, onDeleteMedia }: MediaListProps) {
  const [mediaFiles, setMediaFiles] = useState<MediaFile[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Record<string, boolean>>({});

  // Fetch media files for the session
  const fetchMediaFiles = async () => {
    if (!sessionId) return;
    
    try {
      setLoading(true);
      setError(null);
      
      const response = await apiRequest({
        url: `/api/media/session/${sessionId}`,
        method: "GET",
      });
      
      if (response && typeof response === 'object' && 'media' in response) {
        setMediaFiles(response.media as MediaFile[] || []);
      } else {
        setMediaFiles([]);
        setError("Invalid response format from server");
      }
    } catch (err) {
      console.error("Error fetching media files:", err);
      setError("Failed to load media files. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Delete a media file
  const deleteMediaFile = async (mediaId: string) => {
    try {
      setDeleting(prev => ({ ...prev, [mediaId]: true }));
      
      await apiRequest({
        url: `/api/media/${mediaId}`,
        method: "DELETE",
      });
      
      // Remove the deleted file from the state
      setMediaFiles(prev => prev.filter(file => file.id !== mediaId));
      
      // Notify parent component
      if (onDeleteMedia) {
        onDeleteMedia();
      }
    } catch (err) {
      console.error("Error deleting media file:", err);
      setError("Failed to delete media file. Please try again.");
    } finally {
      setDeleting(prev => ({ ...prev, [mediaId]: false }));
    }
  };

  // Get file size in readable format
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
  };

  // Get icon for file type
  const getFileIcon = (type: MediaFile['type']) => {
    switch (type) {
      case 'voice':
        return <FileAudio className="w-4 h-4" />;
      case 'image':
        return <FileImage className="w-4 h-4" />;
      case 'pdf':
        return <FileText className="w-4 h-4" />;
      default:
        return <File className="w-4 h-4" />;
    }
  };

  // Get badge color for file type
  const getTypeBadge = (type: MediaFile['type']) => {
    switch (type) {
      case 'voice':
        return <Badge variant="secondary">Voice</Badge>;
      case 'image':
        return <Badge variant="destructive">Image</Badge>;
      case 'pdf':
        return <Badge variant="outline">PDF</Badge>;
      default:
        return <Badge>File</Badge>;
    }
  };

  // Load media files on component mount or chatId change
  useEffect(() => {
    if (chatId) {
      fetchMediaFiles();
    }
  }, [chatId]);

  // Show loading state
  if (loading && mediaFiles.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        Loading media files...
      </div>
    );
  }

  // Show error state
  if (error) {
    return (
      <Alert variant="destructive" className="mb-4">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  // Show empty state
  if (mediaFiles.length === 0) {
    return (
      <div className="p-4 text-center text-gray-500">
        No media files found for this chat.
      </div>
    );
  }

  // Group files by type
  const groupedFiles: Record<string, MediaFile[]> = {
    voice: mediaFiles.filter(file => file.type === 'voice'),
    image: mediaFiles.filter(file => file.type === 'image'),
    pdf: mediaFiles.filter(file => file.type === 'pdf'),
    other: mediaFiles.filter(file => !['voice', 'image', 'pdf'].includes(file.type)),
  };

  return (
    <div className="space-y-4">
      {/* Voice files */}
      {groupedFiles.voice.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Voice Messages</h3>
          <div className="space-y-2">
            {groupedFiles.voice.map((file) => (
              <Card key={file.id} className="overflow-hidden">
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {getFileIcon(file.type)}
                      {file.originalName}
                    </CardTitle>
                    {getTypeBadge(file.type)}
                  </div>
                  <CardDescription className="text-xs">
                    {formatFileSize(file.size)} • Uploaded {formatDistanceToNow(new Date(file.uploadedAt), { addSuffix: true })}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4 pt-0">
                  {file.url && (
                    <audio controls className="w-full h-10">
                      <source src={file.url} type={file.contentType} />
                      Your browser does not support audio playback.
                    </audio>
                  )}
                </CardContent>
                <CardFooter className="p-2 bg-gray-50 flex justify-between">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs"
                    onClick={() => window.open(file.url, '_blank')}
                    disabled={!file.url}
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Open
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                    onClick={() => deleteMediaFile(file.id)}
                    disabled={deleting[file.id]}
                  >
                    <Trash className="w-3 h-3 mr-1" />
                    {deleting[file.id] ? 'Deleting...' : 'Delete'}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Image files */}
      {groupedFiles.image.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Images</h3>
          <div className="grid grid-cols-2 gap-2">
            {groupedFiles.image.map((file) => (
              <Card key={file.id} className="overflow-hidden">
                <CardHeader className="p-3 pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {getFileIcon(file.type)}
                      {file.originalName.length > 15 
                        ? file.originalName.substring(0, 12) + '...' 
                        : file.originalName}
                    </CardTitle>
                    {getTypeBadge(file.type)}
                  </div>
                </CardHeader>
                <CardContent className="p-2">
                  {file.url && (
                    <div className="relative aspect-square bg-gray-100 flex items-center justify-center overflow-hidden rounded">
                      <img 
                        src={file.url} 
                        alt={file.originalName} 
                        className="object-cover h-full w-full"
                      />
                    </div>
                  )}
                </CardContent>
                <CardFooter className="p-2 bg-gray-50 flex justify-between">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs"
                    onClick={() => window.open(file.url, '_blank')}
                    disabled={!file.url}
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Open
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                    onClick={() => deleteMediaFile(file.id)}
                    disabled={deleting[file.id]}
                  >
                    <Trash className="w-3 h-3 mr-1" />
                    {deleting[file.id] ? '...' : 'Delete'}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* PDF files */}
      {groupedFiles.pdf.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">PDF Documents</h3>
          <div className="space-y-2">
            {groupedFiles.pdf.map((file) => (
              <Card key={file.id} className="overflow-hidden">
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {getFileIcon(file.type)}
                      {file.originalName}
                    </CardTitle>
                    {getTypeBadge(file.type)}
                  </div>
                  <CardDescription className="text-xs">
                    {formatFileSize(file.size)} • Uploaded {formatDistanceToNow(new Date(file.uploadedAt), { addSuffix: true })}
                  </CardDescription>
                </CardHeader>
                <CardFooter className="p-2 bg-gray-50 flex justify-between">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs"
                    onClick={() => window.open(file.url, '_blank')}
                    disabled={!file.url}
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Open
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                    onClick={() => deleteMediaFile(file.id)}
                    disabled={deleting[file.id]}
                  >
                    <Trash className="w-3 h-3 mr-1" />
                    {deleting[file.id] ? 'Deleting...' : 'Delete'}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Other files */}
      {groupedFiles.other.length > 0 && (
        <div>
          <h3 className="text-sm font-medium mb-2">Other Files</h3>
          <div className="space-y-2">
            {groupedFiles.other.map((file) => (
              <Card key={file.id} className="overflow-hidden">
                <CardHeader className="p-4 pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm flex items-center gap-2">
                      {getFileIcon(file.type)}
                      {file.originalName}
                    </CardTitle>
                    {getTypeBadge(file.type)}
                  </div>
                  <CardDescription className="text-xs">
                    {formatFileSize(file.size)} • Uploaded {formatDistanceToNow(new Date(file.uploadedAt), { addSuffix: true })}
                  </CardDescription>
                </CardHeader>
                <CardFooter className="p-2 bg-gray-50 flex justify-between">
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs"
                    onClick={() => window.open(file.url, '_blank')}
                    disabled={!file.url}
                  >
                    <ExternalLink className="w-3 h-3 mr-1" />
                    Open
                  </Button>
                  <Button 
                    variant="ghost" 
                    size="sm" 
                    className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                    onClick={() => deleteMediaFile(file.id)}
                    disabled={deleting[file.id]}
                  >
                    <Trash className="w-3 h-3 mr-1" />
                    {deleting[file.id] ? 'Deleting...' : 'Delete'}
                  </Button>
                </CardFooter>
              </Card>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 text-right">
        <Button 
          variant="outline" 
          size="sm" 
          onClick={fetchMediaFiles}
        >
          Refresh Media Files
        </Button>
      </div>
    </div>
  );
}