
import { Button } from "@/components/ui/button";
import { MessageCircle, ArrowRight } from "lucide-react";

const CTASection = () => {
  return (
    <section className="py-24 bg-gradient-hero text-white">
      <div className="container mx-auto px-4 text-center">
        <h2 className="text-section-title mb-6">
          Ready to Accelerate Your Growth?
        </h2>
        <p className="text-body-large mb-12 max-w-2xl mx-auto text-white/90">
          Join thousands of founders who are already using Growth Genius to discover 
          and execute proven growth strategies. Start your chat session now.
        </p>
        
        <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
          <Button 
            size="lg" 
            className="bg-growth hover:bg-growth/90 text-growth-foreground px-8 py-4 text-lg animate-pulse-glow"
          >
            <MessageCircle className="w-5 h-5 mr-2" />
            Start Growth Chat
          </Button>
          <Button 
            variant="outline" 
            size="lg"
            className="border-white bg-white/10 text-white hover:bg-white hover:text-secondary px-8 py-4 text-lg"
          >
            Learn More
            <ArrowRight className="w-5 h-5 ml-2" />
          </Button>
        </div>
        
        <div className="mt-12 text-sm text-white/70">
          No credit card required • Currently no charges • 24/7 availability
        </div>
      </div>
    </section>
  );
};

export default CTASection;
