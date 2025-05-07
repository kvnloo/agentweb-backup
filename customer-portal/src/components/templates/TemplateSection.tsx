import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { CategoryTabs } from "./CategoryTabs";
import { TemplateGrid } from "./TemplateGrid";
import { Template } from "@/components/TemplateModal";

interface TemplateSectionProps {
  isTemplateOpen: boolean;
  setIsTemplateOpen: (isOpen: boolean) => void;
  activeCategory: string;
  setActiveCategory: (categoryId: string) => void;
  templates: Record<string, Template[]>;
  onSelectTemplate: (template: Template) => void;
  isLoading?: boolean;
  error?: string | null;
}

export const TemplateSection = ({ 
  isTemplateOpen, 
  setIsTemplateOpen,
  activeCategory,
  setActiveCategory,
  templates,
  onSelectTemplate,
  isLoading,
  error
}: TemplateSectionProps) => {
  const categories = [
    { id: "Market Research", label: "Market Research" },
    { id: "Creative Research", label: "Creative Research" },
    { id: "Social Listening", label: "Social Listening", comingSoon: true },
    { id: "Productivity", label: "Productivity" },
    { id: "Life", label: "Life", comingSoon: true },
    { id: "Data Analysis", label: "Data Analysis", comingSoon: true },
  ];
  
  return (
    <Collapsible open={isTemplateOpen} onOpenChange={setIsTemplateOpen}>
      <CollapsibleContent>
        <div className="p-4 pt-0">
          <Separator className="my-4" />
          <CategoryTabs 
            categories={categories} 
            activeCategory={activeCategory} 
            setActiveCategory={setActiveCategory} 
          />
          {isLoading && <p>Loading templates...</p>}
          {error && <p className="text-destructive">Error: {error}</p>}
          {!isLoading && !error && (
            <TemplateGrid 
              templates={templates[activeCategory] || []} 
              categoryId={activeCategory}
              onSelectTemplate={onSelectTemplate}
            />
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
