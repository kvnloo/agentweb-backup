
import { Card, CardContent } from "@/components/ui/card";
import { Brain, Database, MessageSquare, Target, Users, Rocket } from "lucide-react";

const features = [
  {
    icon: Brain,
    title: "AI-Powered Insights",
    description: "Get personalized growth recommendations based on your startup's stage, industry, and challenges."
  },
  {
    icon: Database,
    title: "Silicon Valley Knowledge Base",
    description: "Access proven strategies from successful startups like Airbnb, Uber, Dropbox, and hundreds more."
  },
  {
    icon: MessageSquare,
    title: "Interactive Chat Experience",
    description: "Ask specific questions about your growth challenges and get instant, actionable advice."
  },
  {
    icon: Target,
    title: "Strategy Execution",
    description: "Not just ideas - get step-by-step implementation guides for each growth strategy."
  },
  {
    icon: Users,
    title: "Founder-Focused",
    description: "Built specifically for startup founders who need practical, tested growth solutions."
  },
  {
    icon: Rocket,
    title: "No Credit Card Required",
    description: "Start using all features immediately without any payment information or setup costs."
  }
];

const FeaturesSection = () => {
  return (
    <section id="features" className="py-24 bg-muted/30">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-section-title mb-6">
            Everything You Need to 
            <span className="bg-gradient-growth bg-clip-text text-transparent"> Scale Your Startup</span>
          </h2>
          <p className="text-body-large text-muted-foreground max-w-3xl mx-auto">
            Our platform combines the collective wisdom of Silicon Valley's most successful companies 
            with cutting-edge AI to give you personalized growth strategies.
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <Card 
              key={index} 
              className="bg-gradient-card border-border/50 hover:shadow-lg transition-all duration-300 group"
            >
              <CardContent className="p-8">
                <div className="mb-6">
                  <div className="w-14 h-14 bg-primary/10 rounded-xl flex items-center justify-center group-hover:bg-primary/20 transition-colors">
                    <feature.icon className="w-7 h-7 text-primary" />
                  </div>
                </div>
                <h3 className="text-feature-title mb-4">{feature.title}</h3>
                <p className="text-muted-foreground leading-relaxed">{feature.description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
};

export default FeaturesSection;
