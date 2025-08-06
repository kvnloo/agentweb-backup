import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Home,
  FileText,
  Settings,
  ChevronLeft,
  ChevronRight,
  Bell,
  Activity,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  BarChart,
  Target,
  Users,
  Search,
  Lightbulb,
  Palette,
  Image,
  Play,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { useAuth } from "@/contexts/AuthContext";
import { useTemplates } from "@/contexts/TemplateContext";
import UserProfileDropdown from "./UserProfileDropdown";
import ChatSupport from "../chat/ChatSupport";
import { DISCORD_INVITE_URL } from "@/config";
import AgentWebLogo from "@/assets/AgentWeb-Logo-189x62.svg";

// Define consistent types for sidebar items
type IconType =
  | React.ComponentType<{ className?: string }>
  | (() => React.ReactElement);

interface SidebarItem {
  icon: IconType;
  label: string;
  path: string;
  id: string;
}

interface SidebarCategory {
  key: string;
  title: string;
  items: SidebarItem[];
}

const Layout = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { availableCategories } = useTemplates();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isChatPanelCollapsed, setIsChatPanelCollapsed] = useState(false);
  const [activeItem, setActiveItem] = useState<string | null>(null);

  // State for collapsible sections
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    overview: true,
    templates: true,
    brand: true,
    creatives: true,
    activities: true,
    documents: true,
    account: true,
  });

  const toggleChatPanel = () => {
    setIsChatPanelCollapsed(!isChatPanelCollapsed);
  };

  const toggleSection = (sectionKey: string) => {
    setOpenSections((prev) => ({
      ...prev,
      [sectionKey]: !prev[sectionKey],
    }));
  };

  // Icon mapping for categories
  const getCategoryIcon = (category: string): IconType => {
    const iconMap: Record<string, IconType> = {
      "Market Research": BarChart,
      "Creative Research": Target,
      "Social Listening": Users,
      "Data Analysis": Search,
      Productivity: Lightbulb,
      "Content Creation": FileText,
      Life: Users,
    };
    return iconMap[category] || FileText;
  };

  // Generate template items dynamically from available categories
  const templateItems: SidebarItem[] = availableCategories.map((category) => ({
    icon: getCategoryIcon(category),
    label: category,
    path: `/?category=${category}`,
    id: category.toLowerCase().replace(/\s+/g, "-"),
  }));

  const categories: SidebarCategory[] = [
    {
      key: "overview",
      title: "OVERVIEW",
      items: [{ icon: Home, label: "Dashboard", path: "/", id: "dashboard" }],
    },
    // Only show templates section if there are available categories
    ...(availableCategories.length > 0
      ? [
          {
            key: "templates",
            title: "TEMPLATES",
            items: templateItems,
          },
        ]
      : []),
    {
      key: "brand",
      title: "BRAND",
      items: [
        {
          icon: Palette,
          label: "Brand Guidelines",
          path: "/brand-guidelines",
          id: "brand-guidelines",
        },
        {
          icon: TrendingUp,
          label: "Market Strategy",
          path: "/market-strategy",
          id: "market-strategy",
        },
        {
          icon: FileText,
          label: "Research Reports",
          path: "/research-reports",
          id: "research-reports",
        },
      ],
    },
    {
      key: "creatives",
      title: "CREATIVES",
      items: [
        {
          icon: Image,
          label: "Ad Images",
          path: "/images",
          id: "images",
        },
        {
          icon: Play,
          label: "Ad Videos",
          path: "/videos",
          id: "videos",
        },
      ],
    },
    {
      key: "activities",
      title: "ACTIVITIES",
      items: [{ icon: Activity, label: "Tasks", path: "/tasks", id: "tasks" }],
    },
    {
      key: "documents",
      title: "DOCUMENTS",
      items: [
        { icon: FileText, label: "User Guide", path: "/guide", id: "guide" },
        {
          icon: FileText,
          label: "Changelog",
          path: "/changelog",
          id: "changelog",
        },
      ],
    },
    {
      key: "account",
      title: "ACCOUNT",
      items: [
        {
          icon: Settings,
          label: "Settings",
          path: "/settings",
          id: "settings",
        },
      ],
    },
  ];

  // Initialize the active item based on pathname when component mounts
  useState(() => {
    // Find the item that matches the current path
    for (const category of categories) {
      const matchingItem = category.items.find(
        (item) => item.path === location.pathname
      );
      if (matchingItem) {
        setActiveItem(matchingItem.id);
        break;
      }
    }
    // Default to dashboard if on home path
    if (location.pathname === "/" && !activeItem) {
      setActiveItem("dashboard");
    }
  });

  const handleItemClick = (item: SidebarItem) => {
    setActiveItem(item.id);

    // Special handling for different navigation types
    if (item.path.startsWith("/?category=")) {
      // Template category - navigate to dashboard with category
      const categoryName = item.path.replace("/?category=", "");
      navigate("/", { state: { activeCategory: categoryName } });
    } else if (item.path === "/") {
      // Main dashboard - navigate without category to show prompt form
      navigate("/", { state: { activeCategory: null } });
    } else {
      // Regular navigation
      navigate(item.path);
    }
  };

  const renderIcon = (item: SidebarItem) => {
    const IconComponent = item.icon;
    const iconClassName = cn(
      "h-5 w-5",
      isSidebarCollapsed ? "mx-auto" : "mr-3"
    );

    if (typeof IconComponent === "function" && IconComponent.length === 0) {
      // Function component that returns JSX
      return (
        <span className={iconClassName}>
          {(IconComponent as () => React.ReactElement)()}
        </span>
      );
    } else {
      // Regular component
      return <IconComponent className={iconClassName} />;
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-[#1A1F2C]">
      {/* Sidebar (Left Nav) */}
      <aside
        className={cn(
          "flex flex-col h-screen bg-white dark:bg-[#1B2549] transition-all duration-300 shrink-0",
          isSidebarCollapsed ? "w-[60px]" : "w-[240px]"
        )}
      >
        {/* Logo section */}
        <div className="flex h-14 items-center px-4">
          {!isSidebarCollapsed && (
            <Link to="/" className="flex items-center gap-2">
              <img src={AgentWebLogo} alt="AgentWeb Logo" className="h-8" />
            </Link>
          )}
          {isSidebarCollapsed && (
            <div className="w-full flex justify-center">
              <img src={AgentWebLogo} alt="AgentWeb Logo" className="h-8" />
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-auto py-2">
          {categories.map((category, categoryIndex) => (
            <div key={categoryIndex} className="mb-2">
              <Collapsible
                open={openSections[category.key]}
                onOpenChange={() => toggleSection(category.key)}
              >
                {!isSidebarCollapsed && (
                  <div className="px-4 py-1">
                    <CollapsibleTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-between p-0 h-auto text-xs font-semibold text-[#7E69AB] dark:text-[rgba(255,255,255,0.7)] tracking-wider hover:bg-transparent"
                      >
                        {category.title}
                        {openSections[category.key] ? (
                          <ChevronUp className="h-3 w-3" />
                        ) : (
                          <ChevronDown className="h-3 w-3" />
                        )}
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                )}
                <CollapsibleContent className="space-y-1 px-2">
                  {category.items.map((item, itemIndex) => (
                    <Button
                      key={`${categoryIndex}-${itemIndex}`}
                      variant="ghost"
                      onClick={() => handleItemClick(item)}
                      className={cn(
                        "w-full justify-start py-2 px-2 rounded-md text-sm font-medium transition-colors relative",
                        activeItem === item.id
                          ? "sidebar-active-button text-[#7E69AB] dark:text-dark"
                          : "text-gray-600 hover:bg-[#F3EFFD] hover:text-[#7E69AB] dark:text-[rgba(255,255,255,0.85)] dark:hover:bg-[rgba(255,255,255,0.1)] dark:hover:text-white"
                      )}
                    >
                      {renderIcon(item)}
                      {!isSidebarCollapsed && <span>{item.label}</span>}
                      {activeItem === item.id && !isSidebarCollapsed && (
                        <div className="absolute left-0 h-6 w-1 agent-gradient rounded-r-full" />
                      )}
                    </Button>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            </div>
          ))}
        </div>

        {/* Public Beta Notice */}
        {!isSidebarCollapsed && (
          <div className="px-4 py-2 text-xs text-gray-500 dark:text-[rgba(255,255,255,0.7)] border-t border-[#D6BCFA] dark:border-[rgba(255,255,255,0.1)]">
            <p className="mb-1">
              Customer Portal is in{" "}
              <strong className="font-semibold">Public Beta</strong>.
            </p>
            <p>
              Join our{" "}
              <a
                href={DISCORD_INVITE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#7E69AB] dark:text-purple-light hover:underline"
              >
                Discord community
              </a>{" "}
              to report bugs or share feedback.
            </p>
          </div>
        )}

        {/* Collapse button */}
        <div className="border-t border-[#D6BCFA] dark:border-[rgba(255,255,255,0.1)] p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full flex justify-center text-[#7E69AB] hover:bg-[#F3EFFD] hover:text-[#7E69AB] dark:text-[rgba(255,255,255,0.85)] dark:hover:bg-[rgba(255,255,255,0.1)] dark:hover:text-white"
            onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          >
            {isSidebarCollapsed ? (
              <ChevronRight size={18} />
            ) : (
              <ChevronLeft size={18} />
            )}
          </Button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-[#10141F]">
        {/* Header */}
        <header className="bg-white dark:bg-[#1B2549] h-14 px-4 flex items-center justify-between shrink-0">
          {/* Gradient bar */}
          <div className="absolute top-0 left-0 right-0 h-[2px] agent-gradient"></div>
          <div className="flex items-center gap-4">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-[rgba(255,255,255,0.85)]">
              {categories
                .flatMap((category) => category.items)
                .find((item) => item.id === activeItem)?.label || "Dashboard"}
            </h1>
            {user?.delegateInfo?.isDelegated && (
              <div className="px-3 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 text-sm rounded-full flex items-center gap-1">
                <Users size={14} />
                <span>Admin View: {user.delegateInfo.adminEmail}</span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="text-[#7E69AB] dark:text-[rgba(255,255,255,0.85)]"
            >
              <Bell size={20} />
            </Button>
            <UserProfileDropdown />
          </div>
        </header>

        {/* Page Children - make it scrollable independently */}
        <div className="flex-1 p-6 overflow-y-auto">{children}</div>
      </main>

      {/* Right Chat Panel Container */}
      <aside
        className={cn(
          "h-screen shrink-0 border-l border-[#D6BCFA] dark:border-gray-700 bg-white dark:bg-white flex flex-col transition-all duration-300",
          isChatPanelCollapsed ? "w-0 border-l-0" : "w-96"
        )}
      >
        <ChatSupport
          isChatPanelCollapsed={isChatPanelCollapsed}
          onToggleChatPanel={toggleChatPanel}
        />
      </aside>
    </div>
  );
};

export default Layout;
