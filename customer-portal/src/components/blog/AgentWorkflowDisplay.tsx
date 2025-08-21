import React, { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle,
  AlertCircle,
  Clock,
} from "lucide-react";
import { cn } from "../../lib/utils";

export interface WorkflowStep {
  id: string;
  title: string;
  description: string;
  status: "pending" | "active" | "completed" | "error";
  details?: string;
  timestamp?: Date;
}

interface AgentWorkflowDisplayProps {
  steps: WorkflowStep[];
  isVisible: boolean;
  onToggle: () => void;
  className?: string;
}

export const AgentWorkflowDisplay: React.FC<AgentWorkflowDisplayProps> = ({
  steps,
  isVisible,
  onToggle,
  className,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Add CSS animations
  React.useEffect(() => {
    const style = document.createElement("style");
    style.textContent = `
      @keyframes fadeInUp {
        from {
          opacity: 0;
          transform: translateY(20px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `;
    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, []);

  if (!isVisible) return null;

  const activeStep = steps.find((step) => step.status === "active");
  const completedSteps = steps.filter((step) => step.status === "completed");
  const errorSteps = steps.filter((step) => step.status === "error");

  return (
    <div
      className={cn(
        "bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-900 border border-blue-200 dark:border-gray-700 rounded-lg p-4",
        className
      )}
    >
      {/* Header with toggle */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center space-x-3">
          <div className="relative">
            {activeStep ? (
              <Loader2 className="h-5 w-5 text-blue-600 dark:text-blue-400 animate-spin" />
            ) : (
              <div className="h-5 w-5 rounded-full bg-blue-600 dark:bg-blue-400" />
            )}
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100">
              AI Agent Workflow
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {activeStep
                ? `Currently: ${activeStep.title}`
                : "Workflow complete"}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 hover:bg-blue-100 dark:hover:bg-gray-700 rounded transition-colors"
          >
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            ) : (
              <ChevronDown className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            )}
          </button>
          <button
            onClick={onToggle}
            className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors"
          >
            Hide
          </button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-4">
        <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
          <span>Progress</span>
          <span>
            {completedSteps.length}/{steps.length} steps
          </span>
        </div>
        <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
          <div
            className="bg-gradient-to-r from-blue-500 to-indigo-500 h-2 rounded-full transition-all duration-700 ease-out transform origin-left"
            style={{
              width: `${(completedSteps.length / steps.length) * 100}%`,
            }}
          />
        </div>
      </div>

      {/* Expanded steps view */}
      {isExpanded && (
        <div className="space-y-3">
          {steps.map((step, index) => (
            <div
              key={step.id}
              className={cn(
                "flex items-start space-x-3 p-3 rounded-lg border transition-all duration-500 ease-out transform",
                step.status === "active" &&
                  "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-700 scale-[1.02] shadow-md",
                step.status === "completed" &&
                  "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-700 scale-100 shadow-sm",
                step.status === "error" &&
                  "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-700 scale-100",
                step.status === "pending" &&
                  "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-600 scale-100"
              )}
              style={{
                animationDelay: `${index * 100}ms`,
                animation: "fadeInUp 0.5s ease-out forwards",
              }}
            >
              {/* Status icon */}
              <div className="flex-shrink-0 mt-0.5 transition-all duration-300 ease-out">
                {step.status === "pending" && (
                  <Clock className="h-4 w-4 text-gray-400 transition-all duration-300" />
                )}
                {step.status === "active" && (
                  <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin transition-all duration-300" />
                )}
                {step.status === "completed" && (
                  <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400 transition-all duration-300" />
                )}
                {step.status === "error" && (
                  <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 transition-all duration-300" />
                )}
              </div>

              {/* Step content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center space-x-2">
                  <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {step.title}
                  </span>
                  {step.timestamp && (
                    <span className="text-xs text-gray-500 dark:text-gray-400">
                      {step.timestamp.toLocaleTimeString()}
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  {step.description}
                </p>
                {step.details && (
                  <div className="mt-2 p-2 bg-white dark:bg-gray-800 rounded text-xs font-mono text-gray-700 dark:text-gray-300 border">
                    {step.details}
                  </div>
                )}
              </div>

              {/* Step number */}
              <div className="flex-shrink-0">
                <div
                  className={cn(
                    "w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium transition-all duration-300 ease-out transform",
                    step.status === "pending" &&
                      "bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-400 scale-100",
                    step.status === "active" &&
                      "bg-blue-600 dark:bg-blue-500 text-white scale-110 shadow-md",
                    step.status === "completed" &&
                      "bg-green-600 dark:bg-green-500 text-white scale-100 shadow-sm",
                    step.status === "error" &&
                      "bg-red-600 dark:bg-red-500 text-white scale-100"
                  )}
                >
                  {index + 1}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Collapsed summary */}
      {!isExpanded && (
        <div className="space-y-2">
          {activeStep && (
            <div className="flex items-center space-x-2 text-sm">
              <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin" />
              <span className="text-gray-700 dark:text-gray-300">
                <strong>Active:</strong> {activeStep.title}
              </span>
            </div>
          )}

          {completedSteps.length > 0 && (
            <div className="flex items-center space-x-2 text-sm">
              <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
              <span className="text-gray-700 dark:text-gray-300">
                <strong>Completed:</strong> {completedSteps.length} steps
              </span>
            </div>
          )}

          {errorSteps.length > 0 && (
            <div className="flex items-center space-x-2 text-sm">
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
              <span className="text-gray-700 dark:text-gray-300">
                <strong>Errors:</strong> {errorSteps.length} steps
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default AgentWorkflowDisplay;
