import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Send, ChevronDown, ChevronUp } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";

interface PromptFormProps {
  prompt: string;
  setPrompt: (prompt: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  isTemplateOpen: boolean;
  setIsTemplateOpen: (isOpen: boolean) => void;
  placeholder?: string;
  buttonText?: string;
  showTemplatesButton?: boolean;
}

export const PromptForm = ({
  prompt,
  setPrompt,
  onSubmit,
  isTemplateOpen,
  setIsTemplateOpen,
  placeholder,
  buttonText,
  showTemplatesButton = true,
}: PromptFormProps) => {
  return (
    <form onSubmit={onSubmit} className="p-4">
      <div className="relative">
        <Textarea
          placeholder={placeholder || "Enter your task details or question..."}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="resize-none p-4 min-h-[180px] rounded-lg"
        />
      </div>
      <div
        className={`flex mt-4 ${
          showTemplatesButton ? "justify-between" : "justify-end"
        }`}
      >
        {showTemplatesButton && (
          <Button
            variant="outline"
            className="text-gray-200 border-[#9b87f5] hover:bg-[#F3EFFD] h0"
            onClick={() => setIsTemplateOpen(!isTemplateOpen)}
          >
            Templates{" "}
            {isTemplateOpen ? (
              <ChevronUp className="ml-1 h-4 w-4" />
            ) : (
              <ChevronDown className="ml-1 h-4 w-4" />
            )}
          </Button>
        )}
        <Button
          type="submit"
          disabled={!prompt.trim()}
          className="bg-[#9b87f5] hover:bg-[#7E69AB] text-white"
        >
          <Send className="h-4 w-4 mr-2" />
          {buttonText || "Submit"}
        </Button>
      </div>
    </form>
  );
};
