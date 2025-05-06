import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/use-toast";
import { TemplateModal, Template } from "@/components/TemplateModal";
import { templates } from "@/data/templates";
import { Message } from "@/types/chat";
import { MessageList } from "@/components/chat/MessageList";
import { PromptForm } from "@/components/chat/PromptForm";
import { TemplateSection } from "@/components/templates/TemplateSection";

const Dashboard = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTemplateOpen, setIsTemplateOpen] = useState(true);
  const [activeCategory, setActiveCategory] = useState("market-research");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(null);
  
  // Create a welcome message with user information
  useEffect(() => {
    if (user && messages.length === 0) {
      const welcomeMessage: Message = {
        id: "welcome",
        content: `Welcome back, ${user.email.split('@')[0]}! How can I assist you today?`,
        sender: "ai",
        timestamp: new Date(),
      };
      setMessages([welcomeMessage]);
    }
  }, [user, messages.length]);
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (prompt.trim()) {
      // Add user message
      const userMessage: Message = {
        id: Date.now().toString(),
        content: prompt,
        sender: "user",
        timestamp: new Date(),
      };
      
      setMessages([...messages, userMessage]);
      setPrompt("");

      // Simulate AI response for demonstration
      setTimeout(() => {
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          content: `I'll help you with your request about "${prompt.substring(0, 30)}${prompt.length > 30 ? '...' : ''}"`,
          sender: "ai",
          timestamp: new Date(),
        };
        setMessages(prev => [...prev, aiMessage]);
      }, 1000);
    }
  };

  const handleTemplateClick = (template: Template) => {
    setSelectedTemplate(template);
    setIsModalOpen(true);
  };
  
  const handleTemplateSubmit = (template: Template, paramValues: Record<string, string>) => {
    // Generate a prompt based on the template and parameter values
    let promptText = template.promptTemplate || template.description;
    
    // Replace parameter placeholders in the prompt with actual values
    if (template.parameters) {
      template.parameters.forEach(param => {
        const value = paramValues[param.id] || `[${param.name}]`;
        promptText = promptText?.replace(`[${param.name}]`, value);
      });
    }
    
    // Set the generated prompt in the textarea
    setPrompt(promptText || template.description);
    
    toast({
      title: "Template applied",
      description: `${template.title} template with your parameters has been loaded`,
    });
    
    // If this is a market research template, navigate to the report page
    if (activeCategory === "market-research") {
      navigate("/market-research-report");
    }
  };
  
  return (
    <div className="flex flex-col gap-6 w-full h-full">
      {/* Welcome section */}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">
          Welcome to your Customer Portal
        </h1>
        {user && (
          <p className="text-gray-600">
            Hello, <span className="font-medium">{user.email.split('@')[0]}</span>. Access your market research resources and more from this dashboard.
          </p>
        )}
      </div>
      
      {/* Main container with proper height */}
      <div className="flex flex-col flex-1 rounded-lg bg-white border border-gray-200 shadow-sm overflow-hidden">
        {/* Messages area */}
        <div className="flex-1 overflow-hidden">
          <MessageList messages={messages} />
        </div>
        
        {/* Input area */}
        <div className="border-t border-[#D6BCFA] bg-[#F3EFFD]">
          <PromptForm 
            prompt={prompt} 
            setPrompt={setPrompt} 
            onSubmit={handleSubmit} 
            isTemplateOpen={isTemplateOpen}
            setIsTemplateOpen={setIsTemplateOpen}
          />

          {/* Template section */}
          <TemplateSection 
            isTemplateOpen={isTemplateOpen}
            setIsTemplateOpen={setIsTemplateOpen}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            templates={templates}
            onSelectTemplate={handleTemplateClick}
          />
        </div>
      </div>

      {/* Template Parameter Modal */}
      <TemplateModal 
        isOpen={isModalOpen} 
        setIsOpen={setIsModalOpen}
        template={selectedTemplate}
        onSubmit={handleTemplateSubmit}
      />
    </div>
  );
};

export default Dashboard;
