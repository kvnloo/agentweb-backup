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
  error,
}: TemplateSectionProps) => {
  // Generate categories dynamically based on templates that exist
  const categories = Object.keys(templates)
    .filter(
      (categoryId) => templates[categoryId] && templates[categoryId].length > 0
    )
    .map((categoryId) => ({
      id: categoryId,
      label: categoryId,
      // You can add special handling for specific categories if needed
      comingSoon: false,
    }))
    .sort((a, b) => {
      // Define preferred order for categories
      const categoryOrder = [
        "Market Research",
        "Creative Research",
        "Data Analysis",
        "Social Listening",
        "Productivity",
        "Life",
      ];

      const aIndex = categoryOrder.indexOf(a.id);
      const bIndex = categoryOrder.indexOf(b.id);

      // If both categories are in the preferred order, use that order
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      // If only one is in preferred order, it comes first
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      // Otherwise, alphabetical order
      return a.id.localeCompare(b.id);
    });

  return (
    <Collapsible open={isTemplateOpen} onOpenChange={setIsTemplateOpen}>
      <CollapsibleContent>
        <div className="p-4 pt-0">
          <Separator className="my-4" />
          {categories.length > 0 && (
            <CategoryTabs
              categories={categories}
              activeCategory={activeCategory}
              setActiveCategory={setActiveCategory}
            />
          )}
          {isLoading && <p>Loading templates...</p>}
          {error && <p className="text-destructive">Error: {error}</p>}
          {!isLoading && !error && categories.length > 0 && (
            <TemplateGrid
              templates={templates[activeCategory] || []}
              categoryId={activeCategory}
              onSelectTemplate={onSelectTemplate}
            />
          )}
          {!isLoading && !error && categories.length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400">
                No templates available yet.
              </p>
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
