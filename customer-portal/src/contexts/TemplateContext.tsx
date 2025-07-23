import React, { createContext, useContext, useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import axios from "axios";
import { buildApiUrl } from "@/config";
import { Template, TemplateParameter } from "@/components/TemplateModal";
import { Info } from "lucide-react";

// Template interfaces
interface FetchedTemplate {
  templateId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[];
  category?: string;
  nameParameter?: string | null;
  isInteractive?: boolean;
  isDeepResearch?: boolean;
  isComplexTask?: boolean;
  outputAsJson?: boolean;
  outputAsHtml?: boolean;
  selectedLLMs?: string[];
  useSharedBrowser?: boolean;
  turnOffHeadless?: boolean;
}

interface TemplateContextType {
  availableCategories: string[];
  groupedTemplates: Record<string, Template[]>;
  isLoadingTemplates: boolean;
  templateError: string | null;
  refreshTemplates: () => void;
}

const TemplateContext = createContext<TemplateContextType | undefined>(
  undefined
);

export const useTemplates = () => {
  const context = useContext(TemplateContext);
  if (context === undefined) {
    throw new Error("useTemplates must be used within a TemplateProvider");
  }
  return context;
};

interface TemplateProviderProps {
  children: React.ReactNode;
}

export const TemplateProvider = ({ children }: TemplateProviderProps) => {
  const { token } = useAuth();
  const [availableCategories, setAvailableCategories] = useState<string[]>([]);
  const [groupedTemplates, setGroupedTemplates] = useState<
    Record<string, Template[]>
  >({});
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);

  const fetchTemplates = async () => {
    setIsLoadingTemplates(true);
    setTemplateError(null);
    try {
      const response = await axios.get(buildApiUrl("/api/templates"), {
        ...(token && { headers: { Authorization: `Bearer ${token}` } }),
      });
      const data: FetchedTemplate[] = response.data;
      const templatesWithCategories = data.filter((t) => t.category);

      // Group templates by category
      const newGroupedTemplates: Record<string, Template[]> = {};
      templatesWithCategories.forEach((ft) => {
        if (ft.category) {
          if (!newGroupedTemplates[ft.category]) {
            newGroupedTemplates[ft.category] = [];
          }

          // Convert FetchedTemplate to Template format
          const mappedParameters: TemplateParameter[] =
            ft.parameters?.map((paramName) => ({
              id: paramName,
              name: paramName,
              required: false,
            })) || [];

          const displayTemplate: Template = {
            id: ft.templateId,
            title: ft.name,
            description: ft.description,
            category: ft.category,
            promptTemplate: ft.prompt,
            parameters: mappedParameters,
            icon: <Info size={16} />,
            researchType: ft.isDeepResearch ? "Deep Research" : undefined,
            isComplexTask: ft.isComplexTask,
            outputAsJson: ft.outputAsJson,
            outputAsHtml: ft.outputAsHtml,
            selectedLLMs: ft.selectedLLMs,
            useSharedBrowser: ft.useSharedBrowser,
          };

          newGroupedTemplates[ft.category].push(displayTemplate);
        }
      });

      // Get available categories
      const categories = Object.keys(newGroupedTemplates).filter(
        (categoryId) =>
          newGroupedTemplates[categoryId] &&
          newGroupedTemplates[categoryId].length > 0
      );

      // Sort categories by preferred order
      const categoryOrder = [
        "Market Research",
        "Creative Research",
        "Data Analysis",
        "Social Listening",
        "Productivity",
        "Life",
        "Content Creation",
      ];

      const sortedCategories = categories.sort((a, b) => {
        const aIndex = categoryOrder.indexOf(a);
        const bIndex = categoryOrder.indexOf(b);

        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex;
        }
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.localeCompare(b);
      });

      setAvailableCategories(sortedCategories);
      setGroupedTemplates(newGroupedTemplates);
    } catch (err) {
      console.error("Failed to fetch templates:", err);
      setTemplateError("Failed to load templates. Please try again later.");
      setAvailableCategories([]);
      setGroupedTemplates({});
    } finally {
      setIsLoadingTemplates(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchTemplates();
    }
  }, [token]);

  const refreshTemplates = () => {
    fetchTemplates();
  };

  const value: TemplateContextType = {
    availableCategories,
    groupedTemplates,
    isLoadingTemplates,
    templateError,
    refreshTemplates,
  };

  return (
    <TemplateContext.Provider value={value}>
      {children}
    </TemplateContext.Provider>
  );
};
