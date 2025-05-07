
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface Category {
  id: string;
  label: string;
  comingSoon?: boolean;
}

interface CategoryTabsProps {
  categories: Category[];
  activeCategory: string;
  setActiveCategory: (categoryId: string) => void;
}

export const CategoryTabs = ({ categories, activeCategory, setActiveCategory }: CategoryTabsProps) => {
  return (
    <div className="mb-6 flex items-center gap-4 overflow-x-auto py-1 scrollbar-none">
      {categories.map((category) => (
        <Button
          key={category.id}
          variant={activeCategory === category.id ? "default" : "outline"}
          size="sm"
          className={cn(
            "rounded-full whitespace-nowrap",
            category.comingSoon && "opacity-60"
          )}
          disabled={category.comingSoon}
          onClick={() => setActiveCategory(category.id)}
        >
          {category.label}
          {category.comingSoon && (
            <span className="ml-1 text-xs">(Soon)</span>
          )}
        </Button>
      ))}
    </div>
  );
};
