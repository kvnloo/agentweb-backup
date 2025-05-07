import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Home, FileText, Settings, ChevronLeft, ChevronRight, Bell, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import UserProfileDropdown from "./UserProfileDropdown";
import ChatSupport from "../chat/ChatSupport";

const Layout = ({ children }: { children: React.ReactNode }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [activeItem, setActiveItem] = useState<string | null>(null);

  const categories = [
    { 
      title: "OVERVIEW",
      items: [
        { icon: Home, label: "Dashboard", path: "/", id: "dashboard" },
      ]
    },
    {
      title: "ACTIVITIES",
      items: [
        { icon: Activity, label: "Tasks", path: "/tasks", id: "tasks" },
      ]
    },
    {
      title: "ACCOUNT",
      items: [
        { icon: Settings, label: "Settings", path: "/settings", id: "settings" },
      ]
    }
  ];
  
  // Initialize the active item based on pathname when component mounts
  useState(() => {
    // Find the item that matches the current path
    for (const category of categories) {
      const matchingItem = category.items.find(item => item.path === location.pathname);
      if (matchingItem) {
        setActiveItem(matchingItem.id);
        break;
      }
    }
    // Default to dashboard if on home path
    if (location.pathname === '/' && !activeItem) {
      setActiveItem('dashboard');
    }
  });

  return (
    <div className="flex min-h-screen bg-white dark:bg-[#1A1F2C]">
      {/* Sidebar (Left Nav) */}
      <aside 
        className={cn(
          "flex flex-col border-r border-[#D6BCFA] bg-white dark:bg-white transition-all duration-300 shrink-0",
          isCollapsed ? "w-[60px]" : "w-[240px]"
        )}
      >
        {/* Logo section */}
        <div className="flex h-14 items-center px-4 border-b border-[#D6BCFA] dark:border-[#7E69AB]">
          {!isCollapsed && (
            <Link to="/" className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-md agent-gradient flex items-center justify-center">
                <span className="text-white font-bold">A</span>
              </div>
              <span className="text-xl font-semibold text-gray-900 dark:text-gray-900">Customer Portal</span>
            </Link>
          )}
          {isCollapsed && (
            <div className="w-full flex justify-center">
              <div className="h-8 w-8 rounded-md agent-gradient flex items-center justify-center">
                <span className="text-white font-bold">A</span>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-auto py-2">
          {categories.map((category, categoryIndex) => (
            <div key={categoryIndex} className="mb-4">
              {!isCollapsed && (
                <div className="px-4 py-1">
                  <p className="text-xs font-semibold text-[#7E69AB] dark:text-[#7E69AB] tracking-wider">
                    {category.title}
                  </p>
                </div>
              )}
              <div className="space-y-1 px-2">
                {category.items.map((item, itemIndex) => (
                  <Link
                    key={`${categoryIndex}-${itemIndex}`}
                    to={item.path}
                    onClick={() => setActiveItem(item.id)}
                    className={cn(
                      "flex items-center py-2 px-2 rounded-md text-sm font-medium transition-colors",
                      activeItem === item.id
                        ? "bg-[#F3EFFD] text-[#7E69AB] dark:bg-[#F3EFFD] dark:text-[#7E69AB]"
                        : "text-gray-600 hover:bg-[#F3EFFD] hover:text-[#7E69AB] dark:text-gray-600 dark:hover:bg-[#F3EFFD] dark:hover:text-[#7E69AB]"
                    )}
                  >
                    <item.icon className={cn("h-5 w-5", isCollapsed ? "mx-auto" : "mr-3")} />
                    {!isCollapsed && <span>{item.label}</span>}
                    {activeItem === item.id && !isCollapsed && (
                      <div className="absolute left-0 h-6 w-1 agent-gradient rounded-r-full" />
                    )}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Collapse button */}
        <div className="border-t border-[#D6BCFA] dark:border-[#7E69AB] p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full flex justify-center text-[#7E69AB] hover:bg-[#F3EFFD] hover:text-[#7E69AB] dark:text-[#7E69AB] dark:hover:bg-[#F3EFFD] dark:hover:text-[#7E69AB]"
            onClick={() => setIsCollapsed(!isCollapsed)}
          >
            {isCollapsed ? <ChevronRight size={18} /> : <ChevronLeft size={18} />}
          </Button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-auto bg-gray-50 dark:bg-[#10141F]">
        {/* Header */}
        <header className="border-b border-[#D6BCFA] bg-white dark:bg-white h-14 px-4 flex items-center justify-between shrink-0">
          <div className="flex items-center">
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-900">
              {categories.flatMap(category => category.items).find(item => item.id === activeItem)?.label || "Dashboard"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" className="text-[#7E69AB]">
              <Bell size={20} />
            </Button>
            <UserProfileDropdown />
          </div>
        </header>

        {/* Page Children - make it scrollable independently */}
        <div className="flex-1 container mx-auto p-6 overflow-y-auto">
          {children}
        </div>
      </main>

      {/* Right Chat Panel */}
      <aside className="w-96 shrink-0 border-l border-[#D6BCFA] bg-white dark:bg-white flex flex-col">
        <ChatSupport />
      </aside>
    </div>
  );
};

export default Layout;
