
import React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface TaskOptions {
  emailMe: boolean;
  interactiveMode: boolean;
  performDeepResearch: boolean;
  complexTask: boolean;
  extractPageContent: boolean;
  validateOutput: boolean;
  outputAsJSON: boolean;
}

interface TaskOptionsSelectorProps {
  options: TaskOptions;
  onToggleOption: (option: keyof TaskOptions) => void;
}

export const TaskOptionsSelector: React.FC<TaskOptionsSelectorProps> = ({
  options,
  onToggleOption
}) => {
  return (
    <div>
      <h4 className="text-md font-medium mb-3">Task Options</h4>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="emailMe" 
            checked={options.emailMe}
            onCheckedChange={() => onToggleOption('emailMe')}
          />
          <Label htmlFor="emailMe">Email Me Latest Run</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="interactiveMode" 
            checked={options.interactiveMode}
            onCheckedChange={() => onToggleOption('interactiveMode')}
          />
          <Label htmlFor="interactiveMode">Interactive Mode</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="performDeepResearch" 
            checked={options.performDeepResearch}
            onCheckedChange={() => onToggleOption('performDeepResearch')}
          />
          <Label htmlFor="performDeepResearch">Perform Deep Research</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="complexTask" 
            checked={options.complexTask}
            onCheckedChange={() => onToggleOption('complexTask')}
          />
          <Label htmlFor="complexTask">Complex Task</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="extractPageContent" 
            checked={options.extractPageContent}
            onCheckedChange={() => onToggleOption('extractPageContent')}
          />
          <Label htmlFor="extractPageContent">Extract Page Content</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="validateOutput" 
            checked={options.validateOutput}
            onCheckedChange={() => onToggleOption('validateOutput')}
          />
          <Label htmlFor="validateOutput">Validate Output</Label>
        </div>
        <div className="flex items-center space-x-2">
          <Checkbox 
            id="outputAsJSON" 
            checked={options.outputAsJSON}
            onCheckedChange={() => onToggleOption('outputAsJSON')}
          />
          <Label htmlFor="outputAsJSON">Output As JSON</Label>
        </div>
      </div>
    </div>
  );
};
