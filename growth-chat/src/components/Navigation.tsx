
import { Button } from "@/components/ui/button";

const Navigation = () => {
  return (
    <nav className="fixed top-0 w-full bg-background/80 backdrop-blur-md border-b border-border z-50">
      <div className="container mx-auto px-4 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 bg-gradient-growth rounded-lg"></div>
          <span className="text-xl font-bold">Growth Genius</span>
          <span className="text-sm text-muted-foreground">by AgentWeb, Inc.</span>
        </div>
        
        <div className="hidden md:flex items-center space-x-8">
          <a href="#features" className="text-muted-foreground hover:text-foreground transition-colors">
            Features
          </a>
          <a href="#knowledge" className="text-muted-foreground hover:text-foreground transition-colors">
            Knowledge Base
          </a>
          <a href="#about" className="text-muted-foreground hover:text-foreground transition-colors">
            About
          </a>
        </div>
        
        <div className="flex items-center space-x-4">
          <Button variant="ghost">Sign In</Button>
          <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
            Start Chat
          </Button>
        </div>
      </div>
    </nav>
  );
};

export default Navigation;
