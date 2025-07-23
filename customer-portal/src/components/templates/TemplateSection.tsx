import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
// import { CategoryTabs } from "./CategoryTabs"; // Removed since categories are now in sidebar
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
  return (
    <Collapsible open={isTemplateOpen} onOpenChange={setIsTemplateOpen}>
      <CollapsibleContent>
        <div className="p-4 pt-0">
          <Separator className="my-4" />
          {/* Template category tabs removed - categories are now in sidebar navigation */}
          {isLoading && <p>Loading templates...</p>}
          {error && <p className="text-destructive">Error: {error}</p>}
          {!isLoading &&
            !error &&
            Object.keys(templates).length > 0 &&
            activeCategory && (
              <TemplateGrid
                templates={templates[activeCategory] || []}
                categoryId={activeCategory}
                onSelectTemplate={onSelectTemplate}
              />
            )}
          {!isLoading && !error && Object.keys(templates).length === 0 && (
            <div className="text-center py-8">
              <p className="text-gray-500 dark:text-gray-400">
                No templates available yet.
              </p>
            </div>
          )}
          {!isLoading &&
            !error &&
            Object.keys(templates).length > 0 &&
            !activeCategory && (
              <div className="text-center py-8">
                <p className="text-gray-500 dark:text-gray-400">
                  Select a template category from the sidebar to view available
                  templates.
                </p>
              </div>
            )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
};
