import { Progress } from '@/components/ui/progress'
import { CheckCircle, Circle, Loader } from 'lucide-react'

interface ProcessingStatusProps {
  progress: number
  steps: Array<{ done: boolean; text: string }>
}

export default function ProcessingStatus({
  progress,
  steps,
}: ProcessingStatusProps) {
  return (
    <div className="bg-white rounded-lg shadow-md mt-4 overflow-hidden">
      <div className="bg-secondary text-white py-3 px-4">
        <h2 className="text-lg font-semibold">Processing Status</h2>
      </div>

      <div className="p-4">
        <div className="mb-4">
          <h3 className="font-medium text-sm mb-2">Processing Progress</h3>
          <Progress value={progress} className="h-2.5" />
        </div>

        <div className="space-y-2 text-sm text-gray-700">
          {steps.map((step, index) => {
            const currentStep = steps.findIndex((s) => !s.done)
            const isActive = index === currentStep

            return (
              <div className="flex items-center" key={index}>
                {step.done ? (
                  <CheckCircle className="h-4 w-4 text-success mr-2" />
                ) : isActive ? (
                  <Loader className="h-4 w-4 text-accent mr-2 animate-spin" />
                ) : (
                  <Circle className="h-4 w-4 text-gray-400 mr-2" />
                )}
                <span
                  className={
                    isActive ? 'text-accent' : step.done ? '' : 'text-gray-400'
                  }
                >
                  {step.text}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
