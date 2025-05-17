import { useState, useEffect } from 'react'
import { apiRequest } from '../lib/queryClient'
import { Button } from './ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from './ui/card'
import { Loader2 } from 'lucide-react'
import { useToast } from '../hooks/use-toast'

interface CheckoutFormProps {
  bundleId: string
  onCancel: () => void
}

const CheckoutForm = ({ bundleId, onCancel }: CheckoutFormProps) => {
  const [isProcessing, setIsProcessing] = useState(false)
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    // Create payment intent when component mounts
    const getCheckoutUrl = async () => {
      try {
        setIsProcessing(true)
        const response = await apiRequest(
          'POST',
          '/api/create-payment-intent',
          {
            bundleId,
          },
        )

        if (!response.ok) {
          throw new Error('Failed to create payment intent')
        }

        const data = await response.json()
        if (data.checkoutUrl) {
          setCheckoutUrl(data.checkoutUrl)
        } else {
          throw new Error('No checkout URL returned')
        }
      } catch (error) {
        console.error('Error creating payment intent:', error)
        toast({
          title: 'Payment Error',
          description: 'Unable to initialize checkout. Please try again.',
          variant: 'destructive',
        })
      } finally {
        setIsProcessing(false)
      }
    }

    getCheckoutUrl()
  }, [bundleId, toast])

  const handleProceedToCheckout = () => {
    if (checkoutUrl) {
      console.log(`Proceeding to Stripe checkout: ${checkoutUrl}`)
      // Track that we're starting a checkout process
      localStorage.setItem('whats_pdf_checkout_started', 'true')
      localStorage.setItem('whats_pdf_bundle_id', bundleId)

      window.location.href = checkoutUrl
    }
  }

  return (
    <Card className="w-full max-w-md mx-auto">
      <CardHeader>
        <CardTitle>Complete Your Purchase</CardTitle>
        <CardDescription>
          Pay securely through Stripe to download your WhatsApp Chat Export with
          all media files.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isProcessing ? (
          <div className="flex justify-center items-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-2">Preparing checkout...</span>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-md bg-secondary p-4">
              <h3 className="font-medium text-foreground">Purchase Details</h3>
              <p className="text-sm text-foreground">
                WhatsApp Chat Export Bundle - $9.00
              </p>
            </div>
          </div>
        )}
      </CardContent>
      <CardFooter className="flex justify-between">
        <Button variant="outline" onClick={onCancel} disabled={isProcessing}>
          Cancel
        </Button>
        <Button
          onClick={handleProceedToCheckout}
          disabled={isProcessing || !checkoutUrl}
        >
          {isProcessing ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Processing
            </>
          ) : (
            'Proceed to Checkout'
          )}
        </Button>
      </CardFooter>
    </Card>
  )
}

interface CheckoutProps {
  bundleId: string
  onCancel: () => void
}

export default function Checkout({ bundleId, onCancel }: CheckoutProps) {
  return <CheckoutForm bundleId={bundleId} onCancel={onCancel} />
}
