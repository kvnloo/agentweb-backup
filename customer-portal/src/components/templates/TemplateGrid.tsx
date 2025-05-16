import { Button } from "@/components/ui/button";
import { Template } from "@/components/TemplateModal";

interface TemplateGridProps {
  templates: Template[];
  categoryId: string;
  onSelectTemplate: (template: Template) => void;
}

export const TemplateGrid = ({ templates, categoryId, onSelectTemplate }: TemplateGridProps) => {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-4">
      {templates?.map((template) => (
        <div 
          key={template.id} 
          className="flex flex-col rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden cursor-pointer hover:border-primary/50 dark:hover:border-primary/50 hover:shadow-md transition-all"
        >
          <div className="p-4 flex-grow">
            <div className="flex items-center gap-2 mb-2">
              <div className="rounded-full bg-gray-100 dark:bg-gray-800 p-1.5">
                {template.icon}
              </div>
              <h3 className="font-medium text-sm text-black dark:text-black">{template.title}</h3>
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">
              {template.description}
            </p>
            {template.researchType && (
              <div className="mt-2">
                <span className="text-xs text-primary font-medium">{template.researchType}</span>
                {template.parameters && (
                  <span className="text-xs text-gray-500 dark:text-gray-400 ml-2">
                    {template.parameters.length} {template.parameters.length === 1 ? "Parameter" : "Parameters"}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="border-t border-gray-100 dark:border-gray-800 p-2 bg-primary dark:bg-primary hover:bg-primary/90 dark:hover:bg-primary/80">
            <Button 
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs text-primary-foreground dark:text-primary-foreground hover:bg-transparent dark:hover:bg-transparent"
              onClick={() => onSelectTemplate(template)}
            >
              Use template
            </Button>
          </div>
        </div>
      ))}
      
      {(!templates || templates.length === 0) && (
        <div className="col-span-full text-center py-8">
          <p className="text-gray-500 dark:text-gray-400">
            {categoryId === "social-listening" 
              ? "Coming soon! Templates will be available in a future update." 
              : "No templates available in this category yet."}
          </p>
        </div>
      )}
    </div>
  );
};
