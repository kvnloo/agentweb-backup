
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
}

export const TemplateSection = ({ 
  isTemplateOpen, 
  setIsTemplateOpen,
  activeCategory,
  setActiveCategory,
  templates,
  onSelectTemplate
}: TemplateSectionProps) => {
  const categories = [
    { id: "market-research", label: "Market Research" },
    { id: "creative-research", label: "Creative Research" },
    { id: "social-listening", label: "Social Listening", comingSoon: true },
    { id: "productivity", label: "Productivity" },
    { id: "life", label: "Life", comingSoon: true },
    { id: "data-analysis", label: "Data Analysis", comingSoon: true },
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
          <TemplateGrid 
            templates={templates[activeCategory] || []} 
            categoryId={activeCategory}
            onSelectTemplate={onSelectTemplate}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
