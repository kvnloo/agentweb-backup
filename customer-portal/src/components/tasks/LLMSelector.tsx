
import React from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface LLMSelectorProps {
  preferredLLM: string;
  onLLMChange: (value: string) => void;
}

export const LLMSelector: React.FC<LLMSelectorProps> = ({
  preferredLLM,
  onLLMChange
}) => {
  return (
    <div>
      <Label htmlFor="preferred_llm" className="block mb-2">Preferred LLM</Label>
      <Select
        value={preferredLLM}
        onValueChange={onLLMChange}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select LLM model" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="gpt-4o">gpt-4o</SelectItem>
          <SelectItem value="gpt-4o-mini">gpt-4o-mini</SelectItem>
          <SelectItem value="gpt-4.5-preview">gpt-4.5-preview</SelectItem>
          <SelectItem value="azure-openai-gpt-40">azure-openai-gpt-40</SelectItem>
          <SelectItem value="claude-3-opus">claude-3-opus</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
};
