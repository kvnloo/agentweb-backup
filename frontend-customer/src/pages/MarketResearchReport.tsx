
import { useState } from "react";
import { X, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { 
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ExecutionHistory, TaskExecution } from "@/components/tasks/ExecutionHistory";

// Sample data for demonstration
const mockExecutions: TaskExecution[] = [
  {
    id: "1",
    status: "completed",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    prompt: "Generate a market research report for children personalized storybooks, list the TAM, the key competitors, opportunity and outlook.",
    result: "Market research report generated successfully. Total Addressable Market (TAM) estimated at $2.8B with a 14% annual growth rate.",
    details: "Research completed using Parallel Search and targeted website analysis. Found 12 major competitors and 8 emerging startups in the space."
  },
  {
    id: "2",
    status: "completed",
    startedAt: new Date(Date.now() - 86400000).toISOString(),
    completedAt: new Date(Date.now() - 86300000).toISOString(),
    prompt: "Research competitors in the personalized children's storybook market",
    result: "Identified 12 direct competitors and 8 emerging startups.",
  }
];

const MarketResearchReport = () => {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  // Use first execution's prompt
  const prompt = mockExecutions[0]?.prompt || "";

  return (
    <div className="flex h-full overflow-hidden">
      {/* Main content */}
      <div className="flex-1 overflow-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Market Research Report</h1>
        </div>

        <div className="space-y-8">
          {/* User Prompt */}
          <div className="bg-gray-100 p-6 rounded-lg">
            <p className="text-gray-900 font-medium">{prompt}</p>
          </div>
          
          {/* Initial response */}
          <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
            <p className="text-gray-800">
              I'll help you generate a comprehensive market research report on the children's personalized storybook market. Let me first outline a plan for creating this report.
            </p>
          </div>

          {/* Tool usage indicator with Execution Log button */}
          <div className="bg-[#1A1F2C] text-white p-4 rounded-lg flex justify-between items-center">
            <div className="flex items-center">
              <span className="font-medium">Using Tool</span>
              <span className="mx-2">|</span>
              <span className="text-gray-300">initial_plan</span>
            </div>
            <Button 
              variant="ghost" 
              className="text-white hover:text-gray-200"
              onClick={() => setIsDrawerOpen(true)}
            >
              <FileText className="mr-2 h-4 w-4" />
              Execution log
            </Button>
          </div>
        </div>
      </div>

      {/* Execution log drawer (shown on mobile) */}
      <Drawer open={isDrawerOpen} onOpenChange={setIsDrawerOpen}>
        <DrawerContent className="h-[85vh] max-h-[85vh]">
          <DrawerHeader>
            <DrawerTitle className="flex justify-between items-center">
              Execution History
              <DrawerClose asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <X className="h-4 w-4" />
                </Button>
              </DrawerClose>
            </DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-4">
            <ExecutionHistory executions={mockExecutions} />
          </div>
        </DrawerContent>
      </Drawer>

      {/* Execution log sidebar (shown on desktop) */}
      <div className={`border-l border-gray-200 w-[450px] hidden md:${isDrawerOpen ? 'block' : 'hidden'} overflow-auto`}>
        <div className="p-4 border-b border-gray-200 flex justify-between items-center sticky top-0 bg-white z-10">
          <h2 className="font-semibold">Execution History</h2>
          <Button 
            variant="ghost" 
            size="icon"
            className="h-8 w-8"
            onClick={() => setIsDrawerOpen(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="p-4">
          <ExecutionHistory executions={mockExecutions} />
        </div>
      </div>
    </div>
  );
};

export default MarketResearchReport;
