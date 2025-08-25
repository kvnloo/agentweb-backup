const Footer = () => {
  return (
    <footer className="bg-secondary text-secondary-foreground py-16">
      <div className="container mx-auto px-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          <div className="col-span-1 md:col-span-2">
            <div className="flex items-center space-x-2 mb-4">
              <div className="w-8 h-8 bg-gradient-growth rounded-lg"></div>
              <span className="text-xl font-bold">Growth Genius</span>
            </div>
            <p className="text-secondary-foreground/80 mb-6 max-w-md">
              Empowering startup founders with proven growth strategies from Silicon Valley's 
              most successful companies. Powered by AgentWeb, Inc.
            </p>
            <div className="text-sm text-secondary-foreground/60">
              © 2024 AgentWeb, Inc. All rights reserved.
            </div>
          </div>
          
          <div>
            <h4 className="font-semibold mb-4">Product</h4>
            <ul className="space-y-2 text-sm text-secondary-foreground/80">
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">Growth Genius</a></li>
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">Knowledge Base</a></li>
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">Success Stories</a></li>
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">API Access</a></li>
            </ul>
          </div>
          
          <div>
            <h4 className="font-semibold mb-4">Company</h4>
            <ul className="space-y-2 text-sm text-secondary-foreground/80">
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">About Us</a></li>
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">Contact</a></li>
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">Privacy Policy</a></li>
              <li><a href="#" className="hover:text-secondary-foreground transition-colors">Terms of Service</a></li>
            </ul>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
