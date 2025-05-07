import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/components/ui/use-toast";
import { TemplateModal, Template as FrontendTemplate } from "@/components/TemplateModal";
import { Message } from "@/types/chat";
import { MessageList } from "@/components/chat/MessageList";
import { PromptForm } from "@/components/chat/PromptForm";
import { TemplateSection } from "@/components/templates/TemplateSection";
import axios from 'axios';
import { Info } from 'lucide-react';

// Structure from backend (TaskTemplate)
interface FetchedTemplate {
  templateId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[]; // Array of parameter names
  category?: string;
  // other fields like isInteractive, published, etc., might exist but are not used in current mapping
}

const Dashboard = () => {
  const navigate = useNavigate();
  const { user, token } = useAuth(); 
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTemplateOpen, setIsTemplateOpen] = useState(true);
  const [activeCategory, setActiveCategory] = useState("Market Research");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<FrontendTemplate | null>(null);

  const [allFetchedTemplates, setAllFetchedTemplates] = useState<FetchedTemplate[]>([]);
  const [groupedTemplates, setGroupedTemplates] = useState<Record<string, FrontendTemplate[]>>({});
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  
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

  useEffect(() => {
    const fetchTemplatesFromApi = async () => {
      setIsLoadingTemplates(true);
      setTemplateError(null);
      try {
        // TODO: Replace with buildApiUrl if available for frontend-customer
        // Or ensure backend URL is correctly sourced from an env variable for production
        const response = await axios.get('http://localhost:3001/api/templates', {
          // Conditionally add Auth header if token exists. 
          // For public templates, this might not be strictly needed if endpoint is public.
          ...(token && { headers: { Authorization: `Bearer ${token}` } }),
        });
        const data: FetchedTemplate[] = response.data;
        // Filter out templates without a category, as per user request
        setAllFetchedTemplates(data.filter(t => t.category)); 
      } catch (err) {
        console.error("Failed to fetch templates:", err);
        setTemplateError("Failed to load templates. Please try again later.");
        setAllFetchedTemplates([]);
      } finally {
        setIsLoadingTemplates(false);
      }
    };

    fetchTemplatesFromApi();
  }, [token]);

  useEffect(() => {
    const newGroupedTemplates: Record<string, FrontendTemplate[]> = {};
    allFetchedTemplates.forEach((ft) => {
      // This check is technically redundant if allFetchedTemplates is already filtered,
      // but good for safety if the filtering logic changes.
      if (ft.category) { 
        if (!newGroupedTemplates[ft.category]) {
          newGroupedTemplates[ft.category] = [];
        }
        newGroupedTemplates[ft.category].push({
          id: ft.templateId,
          title: ft.name,
          description: ft.description,
          category: ft.category, // Category is guaranteed here due to prior filter
          promptTemplate: ft.prompt,
          parameters: ft.parameters?.map(paramName => ({
            id: paramName,       
            name: paramName,     
            required: false // Default as per TemplateParameter interface
          })) || [],
          icon: <Info size={24} /> // Default icon as per FrontendTemplate interface
        });
      }
    });
    setGroupedTemplates(newGroupedTemplates);
  }, [allFetchedTemplates]);
  
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (prompt.trim()) {
      const userMessage: Message = {
        id: Date.now().toString(),
        content: prompt,
        sender: "user",
        timestamp: new Date(),
      };
      
      setMessages([...messages, userMessage]);
      setPrompt("");

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

  const handleTemplateClick = (template: FrontendTemplate) => {
    setSelectedTemplate(template);
    setIsModalOpen(true);
  };
  
  const handleTemplateSubmit = (template: FrontendTemplate, paramValues: Record<string, string>) => {
    let promptText = template.promptTemplate || template.description;
    
    if (template.parameters) {
      template.parameters.forEach(param => {
        const value = paramValues[param.id] || `[${param.name}]`;
        promptText = promptText?.replace(`[${param.name}]`, value);
      });
    }
    
    setPrompt(promptText || template.description);
    
    toast({
      title: "Template applied",
      description: `${template.title} template with your parameters has been loaded`,
    });
    
    if (activeCategory === "market-research") {
      navigate("/market-research-report");
    }
  };
  
  return (
    <div className="flex flex-col gap-6 w-full h-full">
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
      
      <div className="flex flex-col flex-1 rounded-lg bg-white border border-gray-200 shadow-sm overflow-hidden">
        <div className="flex-1 overflow-hidden">
          <MessageList messages={messages} />
        </div>
        
        <div className="border-t border-[#D6BCFA] bg-[#F3EFFD]">
          <PromptForm 
            prompt={prompt} 
            setPrompt={setPrompt} 
            onSubmit={handleSubmit} 
            isTemplateOpen={isTemplateOpen}
            setIsTemplateOpen={setIsTemplateOpen}
          />

          <TemplateSection 
            isTemplateOpen={isTemplateOpen}
            setIsTemplateOpen={setIsTemplateOpen}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            templates={groupedTemplates}
            isLoading={isLoadingTemplates}
            error={templateError}
            onSelectTemplate={handleTemplateClick}
          />
        </div>
      </div>

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
