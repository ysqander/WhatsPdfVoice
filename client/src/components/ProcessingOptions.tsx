import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ProcessingOptions as ProcessingOptionsType } from "@shared/types";

interface ProcessingOptionsProps {
  options: ProcessingOptionsType;
  setOptions: (options: ProcessingOptionsType) => void;
}

export default function ProcessingOptions({ options, setOptions }: ProcessingOptionsProps) {
  const handleOptionChange = (option: keyof ProcessingOptionsType) => {
    setOptions({
      ...options,
      [option]: !options[option]
    });
  };
  
  return (
    <div className="mt-4">
      <h3 className="font-semibold mb-2 text-primary">Processing Options</h3>
      <div className="space-y-3">
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="includeVoiceMessages" 
            checked={options.includeVoiceMessages}
            onCheckedChange={() => handleOptionChange('includeVoiceMessages')}
          />
          <Label htmlFor="includeVoiceMessages" className="text-sm">Include voice messages</Label>
        </div>
        
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="includeTimestamps" 
            checked={options.includeTimestamps}
            onCheckedChange={() => handleOptionChange('includeTimestamps')}
          />
          <Label htmlFor="includeTimestamps" className="text-sm">Include timestamps</Label>
        </div>
        
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="highlightSenders" 
            checked={options.highlightSenders}
            onCheckedChange={() => handleOptionChange('highlightSenders')}
          />
          <Label htmlFor="highlightSenders" className="text-sm">Highlight message senders</Label>
        </div>
        
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="includeImages" 
            checked={options.includeImages}
            onCheckedChange={() => handleOptionChange('includeImages')}
          />
          <Label htmlFor="includeImages" className="text-sm">Include images</Label>
        </div>
        
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="includeAttachments" 
            checked={options.includeAttachments}
            onCheckedChange={() => handleOptionChange('includeAttachments')}
          />
          <Label htmlFor="includeAttachments" className="text-sm">Include attachments</Label>
        </div>
      </div>
    </div>
  );
}
