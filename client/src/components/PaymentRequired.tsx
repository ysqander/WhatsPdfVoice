import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { DollarSign, ExternalLink, FileText, File, MessageSquare } from "lucide-react";
import { useState } from "react";
import { FREE_TIER_MESSAGE_LIMIT, FREE_TIER_MEDIA_SIZE_LIMIT } from "@shared/types";

interface PaymentRequiredProps {
  messageCount: number;
  mediaSizeBytes: number;
  bundleId: string;
  checkoutUrl: string | null;
}

export default function PaymentRequired({
  messageCount,
  mediaSizeBytes,
  bundleId,
  checkoutUrl
}: PaymentRequiredProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  
  const mediaSize = (mediaSizeBytes / (1024 * 1024)).toFixed(1); // Convert to MB
  
  const handleCheckout = async () => {
    if (!bundleId) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "No payment bundle found"
      });
      return;
    }
    
    setIsLoading(true);
    
    try {
      if (checkoutUrl) {
        // If we already have a checkout URL, use it
        window.location.href = checkoutUrl;
        return;
      }
      
      // Otherwise, get a new checkout URL
      const response = await fetch(`/api/checkout/${bundleId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({})
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || 'Error creating checkout session');
      }
      
      const data = await response.json();
      
      // Redirect to Stripe checkout
      window.location.href = data.checkoutUrl;
    } catch (error) {
      setIsLoading(false);
      toast({
        variant: "destructive",
        title: "Error",
        description: error instanceof Error ? error.message : "An unknown error occurred",
      });
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md mt-4 overflow-hidden">
      <div className="bg-accent text-white py-3 px-4">
        <h2 className="text-lg font-semibold">Payment Required</h2>
      </div>
      
      <div className="p-5">
        <div className="flex items-center justify-center mb-5">
          <div className="w-24 h-24 bg-amber-100 rounded-full flex items-center justify-center">
            <DollarSign className="w-12 h-12 text-amber-500" />
          </div>
        </div>
        
        <h3 className="text-lg font-medium text-center mb-3">
          Your chat export exceeds free tier limits
        </h3>
        
        <div className="bg-gray-50 p-4 rounded-lg mb-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center">
              <MessageSquare className="w-5 h-5 mr-2 text-gray-500" />
              <div>
                <p className="text-sm text-gray-500">Messages</p>
                <p className="font-medium">
                  {messageCount} 
                  <span className="text-xs text-gray-500 ml-1">
                    (Limit: {FREE_TIER_MESSAGE_LIMIT})
                  </span>
                </p>
              </div>
            </div>
            
            <div className="flex items-center">
              <File className="w-5 h-5 mr-2 text-gray-500" />
              <div>
                <p className="text-sm text-gray-500">Media Size</p>
                <p className="font-medium">
                  {mediaSize} MB
                  <span className="text-xs text-gray-500 ml-1">
                    (Limit: {FREE_TIER_MEDIA_SIZE_LIMIT / (1024 * 1024)} MB)
                  </span>
                </p>
              </div>
            </div>
          </div>
        </div>
        
        <div className="mb-5">
          <h4 className="font-medium mb-2">What you'll get:</h4>
          <ul className="space-y-2 text-sm">
            <li className="flex items-start">
              <FileText className="w-4 h-4 mr-2 text-primary mt-0.5" />
              <span>Full PDF export with all {messageCount} messages</span>
            </li>
            <li className="flex items-start">
              <FileZip className="w-4 h-4 mr-2 text-primary mt-0.5" />
              <span>All media files from your conversation ({mediaSize} MB)</span>
            </li>
            <li className="flex items-start">
              <ExternalLink className="w-4 h-4 mr-2 text-primary mt-0.5" />
              <span>30-day secure download link</span>
            </li>
          </ul>
        </div>
        
        <Button 
          className="w-full bg-accent hover:bg-accent/90"
          size="lg"
          onClick={handleCheckout}
          disabled={isLoading}
        >
          {isLoading ? 'Processing...' : 'Continue to Payment ($9)'}
        </Button>
        
        <p className="text-xs text-center text-gray-500 mt-3">
          Secure payment processed by Stripe
        </p>
      </div>
    </div>
  );
}