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

export const CategoryTabs = ({
  categories,
  activeCategory,
  setActiveCategory,
}: CategoryTabsProps) => {
  return (
    <div className="mb-6 flex items-center gap-2 overflow-x-auto py-1 scrollbar-none">
      {categories.map((category) => (
        <Button
          key={category.id}
          size="sm"
          className={cn(
            "rounded-full whitespace-nowrap px-4 py-2 transition-all duration-200 dark:bg-transparent",
            activeCategory === category.id
              ? "tab-gradient text-white font-semibold shadow-md"
              : "bg-white/10 dark:bg-black/20 text-white/70 dark:text-white/50 hover:bg-white/20 dark:hover:bg-black/30 hover:text-white/90 dark:hover:text-white/70",
            category.comingSoon && "opacity-60 cursor-not-allowed"
          )}
          disabled={category.comingSoon}
          onClick={() => setActiveCategory(category.id)}
        >
          {category.label}
          {category.comingSoon && <span className="ml-1 text-xs">(Soon)</span>}
        </Button>
      ))}
    </div>
  );
};
