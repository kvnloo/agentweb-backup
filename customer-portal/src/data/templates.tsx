import { CircleDot, FileText, BarChart, Users, Target, Globe, Search, MessageCircle, Code } from "lucide-react";
import { Template } from "@/components/TemplateModal";

export const templates: Record<string, Template[]> = {
  "market-research": [
    {
      id: "1",
      title: "Market Research",
      description: "AI-generated market research reports and competitive intelligence for customers",
      category: "market-research",
      icon: <FileText className="h-5 w-5" />,
      researchType: "Deep Research",
      parameters: [
        { id: "product", name: "product/service", required: true }
      ],
      promptTemplate: "You are a Market Research Analyst. Your task is to analyze the competitive landscape for my [product/service] in my target market. Tell me about the top 5 competitors in my target market, including their market share, strengths/weaknesses, pricing strategies, and marketing tactics."
    },
    {
      id: "2",
      title: "Competition Landscape Report",
      description: "Identify key competitors in your business area, their offerings and recommendation to your business to gain market share.",
      category: "market-research",
      icon: <BarChart className="h-5 w-5" />,
      researchType: "Deep Research",
      parameters: [
        { id: "business", name: "business", required: true },
        { id: "location", name: "location", required: true }
      ],
      promptTemplate: "As a competitive analysis specialist, research and create a detailed landscape report for [business] in [location]. Identify the top competitors, their market share, pricing strategies, unique selling propositions, and marketing approaches. Provide actionable recommendations for how [business] can differentiate and gain market share."
    },
    {
      id: "3",
      title: "SEO Keyword Recommendation",
      description: "Research and recommend SEO strategies for your business",
      category: "market-research",
      icon: <Search className="h-5 w-5" />,
      researchType: "Deep Research",
      parameters: [
        { id: "business", name: "business", required: true },
        { id: "industry", name: "industry", required: true }
      ],
      promptTemplate: "As an SEO specialist, analyze and recommend the most effective SEO keywords and strategies for [business] in the [industry] industry. Include high-volume, low-competition keywords, content recommendations, and on-page optimization suggestions. Provide a 90-day implementation plan for improving search rankings and organic traffic."
    },
    {
      id: "4",
      title: "Website Diagnostic Report",
      description: "A 360 degree scan on your website's experience, functionality, content, pricing and marketing strategy and recommendations",
      category: "market-research",
      icon: <Globe className="h-5 w-5" />,
      parameters: [
        { id: "website", name: "website URL", required: true }
      ],
      promptTemplate: "Conduct a comprehensive diagnostic report for [website URL]. Analyze the user experience, site functionality, content quality, pricing strategy, and marketing approach. Identify specific strengths and weaknesses, and provide actionable recommendations to improve conversion rates, user engagement, and overall business performance."
    },
  ],
  "creative-research": [
    {
      id: "5",
      title: "Meta Ad Set Creation",
      description: "Shell creation at the ad set level (going off of the meta campaign template)",
      category: "creative-research",
      icon: <Target className="h-5 w-5" />,
      parameters: [
        { id: "campaign", name: "campaign name", required: true },
        { id: "budget", name: "daily budget", required: true },
        { id: "audience", name: "target audience", required: true },
        { id: "placement", name: "ad placement", required: true },
        { id: "objective", name: "campaign objective", required: true }
      ],
      promptTemplate: "Create a Meta Ad Set for the campaign '[campaign name]' with a daily budget of [daily budget]. The target audience is [target audience], ad placement will be [ad placement], and the campaign objective is [campaign objective]. Include detailed audience targeting parameters, optimization goals, and placement recommendations."
    },
    {
      id: "6", 
      title: "Meta Ad Set Optimization",
      description: "Optimizations for ad set status, location, age range, interest/id",
      category: "creative-research",
      icon: <Target className="h-5 w-5" />,
      parameters: [
        { id: "adset", name: "ad set name", required: true },
        { id: "status", name: "status", required: true },
        { id: "location", name: "location", required: true },
        { id: "age_min", name: "minimum age", required: true },
        { id: "age_max", name: "maximum age", required: true },
        { id: "interests", name: "interests", required: false },
        { id: "id", name: "ID", required: false }
      ],
      promptTemplate: "Optimize the Meta ad set '[ad set name]' (ID: [ID]). Set status to [status], target location to [location], and age range from [minimum age] to [maximum age]. Target the following interests: [interests]. Recommend bid strategy and optimization events based on these parameters."
    },
    {
      id: "7",
      title: "Meta Ad Creation",
      description: "Ad creation at the ad level (going off of the meta campaign template)",
      category: "creative-research",
      icon: <Target className="h-5 w-5" />,
      parameters: [
        { id: "adset", name: "ad set name", required: true },
        { id: "name", name: "ad name", required: true },
        { id: "headline", name: "headline", required: true },
        { id: "body", name: "body text", required: true },
        { id: "image", name: "image URL", required: false },
        { id: "cta", name: "call to action", required: true },
        { id: "url", name: "landing page URL", required: true }
      ],
      promptTemplate: "Create a Meta Ad named '[ad name]' for the ad set '[ad set name]'. Use the headline '[headline]' and body text '[body text]'. The ad should use image [image URL] with call to action '[call to action]' that links to [landing page URL]. Provide recommendations for A/B testing variations."
    },
    {
      id: "8",
      title: "Meta Campaign Optimization (Budget)",
      description: "Adjusting budget at the campaign level using FACEBOOKMARKETING_API_CREDENTIAL",
      category: "creative-research",
      icon: <Target className="h-5 w-5" />,
      parameters: [
        { id: "campaign", name: "campaign name", required: true },
        { id: "budget", name: "daily budget", required: true }
      ],
      promptTemplate: "Using the Facebook Marketing API, optimize the budget for campaign '[campaign name]'. Set the daily budget to [daily budget]. Provide budget allocation recommendations across ad sets based on performance data and recommend schedule adjustments for optimal delivery."
    },
    {
      id: "9",
      title: "Meta Campaign Shell Creation",
      description: "Create a shell campaign on Facebook: Two-factor login needed for first-time users",
      category: "creative-research",
      icon: <Target className="h-5 w-5" />,
      researchType: "Interactive",
      parameters: [
        { id: "objective", name: "campaign objective", required: true }
      ],
      promptTemplate: "Create a new Meta campaign shell with the objective [campaign objective]. Set up the campaign structure including campaign settings, initial ad set parameters, and tracking configurations. Prepare for authentication with Facebook's two-factor login system."
    },
    {
      id: "10",
      title: "Competitor Facebook Creative Strategy Analysis",
      description: "Instantly dissect your competitors' creative strategies on Facebook!",
      category: "creative-research",
      icon: <Users className="h-5 w-5" />,
      parameters: [
        { id: "competitor", name: "competitor name", required: true }
      ],
      promptTemplate: "Analyze the Facebook creative strategy of [competitor name]. Research and report on their ad formats, messaging themes, visual style, targeting approach, and campaign frequency. Identify successful patterns and recommend adaptable strategies for our campaigns."
    },
    {
      id: "11",
      title: "Meta Audience Targeting Search",
      description: "Retrieve 10 interest audiences from meta's audience library based on interest_audience keyword",
      category: "creative-research",
      icon: <Users className="h-5 w-5" />,
      parameters: [
        { id: "keyword", name: "interest/audience keyword", required: true }
      ],
      promptTemplate: "Search Meta's audience library for 10 relevant interest audiences related to [interest/audience keyword]. For each audience segment, provide the audience size, demographic breakdown, and targeting recommendations for optimal campaign performance."
    }
  ],
  "social-listening": [
    {
      id: "12",
      title: "Social Listening on Brand",
      description: "A sharp, recent snapshot of mentions, trends, and sentiment across media platforms to keep your brand strategy ahead of the curve.",
      category: "social-listening",
      icon: <MessageCircle className="h-5 w-5" />,
      parameters: [
        { id: "brand", name: "brand name", required: true },
        { id: "timeframe", name: "time period", required: true },
        { id: "platforms", name: "social platforms", required: true },
        { id: "competitors", name: "main competitors", required: false },
        { id: "keywords", name: "related keywords", required: false },
        { id: "sentiment", name: "sentiment analysis", required: false }
      ],
      promptTemplate: "Conduct social listening for [brand name] over the [time period] period across [social platforms]. Compare mentions and sentiment against competitors [main competitors]. Track related keywords [related keywords] and provide sentiment analysis [sentiment analysis]. Deliver insights on brand perception, emerging trends, and recommendation for engagement strategy."
    }
  ]
};
