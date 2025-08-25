
import Navigation from "@/components/Navigation";
import ChatSection from "@/components/ChatSection";
import FeaturesSection from "@/components/FeaturesSection";
import KnowledgeSection from "@/components/KnowledgeSection";
import CTASection from "@/components/CTASection";
import Footer from "@/components/Footer";

const Index = () => {
  return (
    <div className="min-h-screen">
      <Navigation />
      <ChatSection />
      <FeaturesSection />
      <KnowledgeSection />
      <CTASection />
      <Footer />
    </div>
  );
};

export default Index;
