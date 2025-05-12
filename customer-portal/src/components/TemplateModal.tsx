import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";

export interface TemplateParameter {
  id: string;
  name: string;
  required: boolean;
}

export interface Template {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: JSX.Element;
  parameters?: TemplateParameter[];
  promptPreview?: string;
  promptTemplate?: string;
  researchType?: string;
  isComplexTask?: boolean;
  outputAsJson?: boolean;
  outputAsHtml?: boolean;
  selectedLLMs?: string[];
}

interface TemplateModalProps {
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  template: Template | null;
  onSubmit: (template: Template, paramValues: Record<string, string>) => void;
}

export const TemplateModal = ({ 
  isOpen, 
  setIsOpen, 
  template, 
  onSubmit 
}: TemplateModalProps) => {
  const [paramValues, setParamValues] = useState<Record<string, string>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    // Check if all required parameters have values
    if (template?.parameters) {
      const missingRequired = template.parameters
        .filter(p => p.required)
        .some(p => !paramValues[p.id] || paramValues[p.id].trim() === '');
      
      if (missingRequired) {
        toast({
          title: "Missing required fields",
          description: "Please fill in all required fields",
          variant: "destructive",
        });
        return;
      }
    }
    
    if (template) {
      onSubmit(template, paramValues);
      // Reset param values after submit
      setParamValues({});
      setIsOpen(false);
    }
  };

  if (!template) return null;

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[500px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{template.title}</DialogTitle>
            <DialogDescription>
              {template.description}
              {template.researchType && (
                <span className="block mt-1 text-xs text-primary">{template.researchType}</span>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {template.parameters && template.parameters.length > 0 ? (
              <div className="space-y-4">
                <h3 className="text-sm font-medium">Template Parameters</h3>
                <p className="text-xs text-muted-foreground">Please provide values for the following parameters:</p>
                
                {template.parameters.map((param) => (
                  <div key={param.id} className="space-y-2">
                    <Label htmlFor={param.id}>
                      {param.name} {param.required && <span className="text-destructive">*</span>}
                    </Label>
                    <Input
                      id={param.id}
                      value={paramValues[param.id] || ""}
                      onChange={(e) => 
                        setParamValues({...paramValues, [param.id]: e.target.value})
                      }
                      placeholder={`Value for [${param.name}]`}
                      required={param.required}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">
                This template does not require any parameters.
              </div>
            )}

            {template.promptTemplate && (
              <div className="mt-6">
                <h3 className="text-sm font-medium mb-2">Task Preview</h3>
                <div className="text-xs space-y-2">
                  <p className="font-medium">Task Name:</p>
                  <p>{template.title}</p>
                  
                  {template.parameters && template.parameters.length > 0 && (
                    <p className="text-muted-foreground text-xs italic">
                      Will include parameters when provided
                    </p>
                  )}
                  
                  <p className="font-medium mt-2">Task Prompt:</p>
                  <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded text-xs whitespace-pre-wrap">
                    {template.promptTemplate}
                  </div>
                  
                  {(template.researchType || template.isComplexTask || template.outputAsJson || template.outputAsHtml) && (
                    <div className="mt-4">
                      <p className="font-medium mb-1">Task Settings:</p>
                      <div className="space-y-0.5 text-xs">
                        {template.researchType && (
                          <p><span className="font-semibold">Mode:</span> {template.researchType} (Email notifications will be sent)</p>
                        )}
                        {template.isComplexTask && (
                          <p><span className="font-semibold">Complex Task:</span> Enabled</p>
                        )}
                        {template.outputAsJson && (
                          <p><span className="font-semibold">Output Format:</span> JSON</p>
                        )}
                        {template.outputAsHtml && (
                          <p><span className="font-semibold">Output Format:</span> HTML5</p>
                        )}
                      </div>
                    </div>
                  )}
                  
                  {/* Display Selected LLMs */}
                  {template.selectedLLMs && template.selectedLLMs.length > 0 && (
                    <div className="mt-4">
                      <p className="font-medium mb-1">LLMs to use:</p>
                      <div className="flex flex-wrap gap-1">
                        {template.selectedLLMs.map(llm => (
                          <Badge key={llm} variant="secondary">
                            {llm.split('->').pop() || llm} 
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => setIsOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" className="bg-primary hover:bg-primary/90 text-white">
              Use Template
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
