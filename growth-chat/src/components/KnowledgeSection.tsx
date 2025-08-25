
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const successStories = [
  {
    company: "Airbnb",
    strategy: "Community Building",
    description: "How they leveraged user-generated content and built trust in a peer-to-peer marketplace.",
    tags: ["Marketplace", "Trust", "UGC"]
  },
  {
    company: "Dropbox",
    strategy: "Referral Growth",
    description: "The viral referral program that helped them grow from 100K to 4M users in 15 months.",
    tags: ["Viral", "Referrals", "B2C"]
  },
  {
    company: "Slack",
    strategy: "Product-Led Growth",
    description: "How they achieved 10x growth through exceptional user experience and word-of-mouth.",
    tags: ["PLG", "B2B", "Retention"]
  },
  {
    company: "Instagram",
    strategy: "Network Effects",
    description: "Building a social platform that gets more valuable as more users join and share.",
    tags: ["Social", "Network", "Mobile"]
  },
  {
    company: "Stripe",
    strategy: "Developer Experience",
    description: "Winning the payments market by making integration simple and developer-friendly.",
    tags: ["Developer", "API", "B2B"]
  },
  {
    company: "Notion",
    strategy: "Community Growth",
    description: "How they built a passionate community that drives organic growth and product development.",
    tags: ["Community", "Templates", "Productivity"]
  }
];

const KnowledgeSection = () => {
  return (
    <section id="knowledge" className="py-24">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-section-title mb-6">
            Learn From The 
            <span className="bg-gradient-growth bg-clip-text text-transparent"> Best Success Stories</span>
          </h2>
          <p className="text-body-large text-muted-foreground max-w-3xl mx-auto">
            Our knowledge base contains detailed analysis of growth strategies from over 500 successful startups. 
            Here are just a few examples of what you can learn.
          </p>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {successStories.map((story, index) => (
            <Card 
              key={index}
              className="bg-card hover:shadow-lg transition-all duration-300 border-border/50 group cursor-pointer"
            >
              <CardContent className="p-6">
                <div className="mb-4">
                  <h3 className="text-feature-title mb-2 group-hover:text-primary transition-colors">
                    {story.company}
                  </h3>
                  <div className="text-sm font-medium text-growth mb-3">
                    {story.strategy}
                  </div>
                </div>
                
                <p className="text-muted-foreground mb-4 leading-relaxed">
                  {story.description}
                </p>
                
                <div className="flex flex-wrap gap-2">
                  {story.tags.map((tag, tagIndex) => (
                    <Badge 
                      key={tagIndex}
                      variant="secondary"
                      className="text-xs"
                    >
                      {tag}
                    </Badge>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
        
        <div className="text-center mt-12">
          <p className="text-lg text-muted-foreground mb-6">
            And 500+ more success stories waiting for you...
          </p>
        </div>
      </div>
    </section>
  );
};

export default KnowledgeSection;
