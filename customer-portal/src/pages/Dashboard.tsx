import { useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useTemplates } from "@/contexts/TemplateContext";
import { toast } from "@/components/ui/use-toast";
import {
  TemplateModal,
  Template as FrontendTemplateDef,
  TemplateParameter,
} from "@/components/TemplateModal";
import { Message } from "@/types/chat";
import { MessageList } from "@/components/chat/MessageList";
import { PromptForm } from "@/components/chat/PromptForm";
import { TemplateSection } from "@/components/templates/TemplateSection";
import axios from "axios";
import { buildApiUrl } from "@/config";

// Define a new interface that correctly combines FrontendTemplateDef with additional fields
interface DisplayTemplate extends FrontendTemplateDef {
  nameParameter?: string | null;
  isInteractive?: boolean;
  isDeepResearch?: boolean;
  isComplexTask?: boolean;
  outputAsJson?: boolean;
  outputAsHtml?: boolean;
  selectedLLMs?: string[];
  useSharedBrowser?: boolean;
  turnOffHeadless?: boolean;
  // Ensure promptTemplate is part of DisplayTemplate if used directly from it later
  // FrontendTemplateDef already has promptTemplate?: string;
}

const Dashboard = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, token } = useAuth();
  const { groupedTemplates, isLoadingTemplates, templateError } =
    useTemplates();
  const [promptTextState, setPromptTextState] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTemplateOpen, setIsTemplateOpen] = useState(true);
  const [activeCategory, setActiveCategory] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] =
    useState<DisplayTemplate | null>(null);

  // Handle sidebar navigation state
  useEffect(() => {
    if (location.state?.activeCategory) {
      setActiveCategory(location.state.activeCategory);
      setIsTemplateOpen(true); // Ensure templates are open when navigating from sidebar
      // Clear the state to prevent it from persisting
      navigate("/", { replace: true, state: undefined });
    }
  }, [location.state, navigate]);

  // Update active category when templates change
  useEffect(() => {
    const availableCategories = Object.keys(groupedTemplates).filter(
      (categoryId) =>
        groupedTemplates[categoryId] && groupedTemplates[categoryId].length > 0
    );

    // Define preferred order for categories
    const categoryOrder = [
      "Market Research",
      "Creative Research",
      "Data Analysis",
      "Social Listening",
      "Productivity",
      "Life",
    ];

    // Sort available categories by preferred order
    const sortedCategories = availableCategories.sort((a, b) => {
      const aIndex = categoryOrder.indexOf(a);
      const bIndex = categoryOrder.indexOf(b);

      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      if (aIndex !== -1) return -1;
      if (bIndex !== -1) return 1;
      return a.localeCompare(b);
    });

    // If current active category is not available or not set, use the first available one
    if (!activeCategory || !availableCategories.includes(activeCategory)) {
      if (sortedCategories.length > 0) {
        setActiveCategory(sortedCategories[0]);
      }
    }
  }, [groupedTemplates, activeCategory]);

  const handleCreateTaskFromDashboardPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = promptTextState.trim();

    if (!prompt) {
      toast({
        title: "Empty Prompt",
        description: "Please enter a prompt to create a task.",
        variant: "destructive",
      });
      return;
    }

    try {
      const response = await axios.post(
        buildApiUrl("/api/tasks"),
        {
          name: `Task - ${prompt.substring(0, 50)}${
            prompt.length > 50 ? "..." : ""
          }`,
          prompt: prompt,
          category: "General",
          description: `User-generated task: ${prompt}`,
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      toast({
        title: "Task Created Successfully",
        description:
          "Your task has been created. You will be redirected to the Tasks page.",
      });

      setPromptTextState(""); // Clear the input
      navigate("/tasks");
    } catch (error) {
      console.error("Task creation failed:", error);
      const errorMessage =
        error.response?.data?.message ||
        "Could not create the task. Please try again.";
      toast({
        title: "Task Creation Failed",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  const handleTemplateClick = (template: DisplayTemplate) => {
    setSelectedTemplate(template);
    setIsModalOpen(true);
  };

  const handleTemplateSubmit = async (
    templateData: DisplayTemplate,
    paramValues: Record<string, string>
  ) => {
    if (!user || !token || !templateData) {
      toast({
        title: "Error",
        description: "User not authenticated or template data missing.",
        variant: "destructive",
      });
      return;
    }

    let finalPrompt = templateData.promptTemplate || templateData.description;
    if (templateData.parameters) {
      templateData.parameters.forEach((param) => {
        const value = paramValues[param.id] || `[${param.name}]`; // Keep placeholder if no value
        finalPrompt = finalPrompt?.replace(
          new RegExp(`\\[${param.name}\\]`, "g"),
          value
        );
      });
    }

    // --- Debugging Task Name ---
    console.log(`Template Title: ${templateData.title}`);
    console.log(`Template Name Parameter: ${templateData.nameParameter}`);
    console.log(`Parameter Values Received:`, paramValues);
    if (templateData.nameParameter) {
      console.log(
        `Value for Name Parameter (${templateData.nameParameter}): ${
          paramValues[templateData.nameParameter]
        }`
      );
    }
    // --- End Debugging ---

    let taskName = templateData.title;
    // If nameParameter is specified and has a value provided by the user, append it.
    if (templateData.nameParameter && paramValues[templateData.nameParameter]) {
      taskName = `${templateData.title} - ${
        paramValues[templateData.nameParameter]
      }`;
    }
    // If nameParameter is not set, or user didn't provide value, taskName remains the original template title.

    console.log(`Final Task Name Generated: ${taskName}`);

    const emailNotification = templateData.isDeepResearch || false;

    // --- Log templateData just before creating payload ---
    console.log("Template data before creating payload:", templateData);
    console.log("Selected LLMs in templateData:", templateData.selectedLLMs);
    // --- End log ---

    const taskPayload = {
      templateId: templateData.id,
      name: taskName,
      prompt: finalPrompt,
      parameterValues: paramValues,
      isInteractive: templateData.isInteractive || false,
      isDeepResearch: templateData.isDeepResearch || false,
      isComplexTask: templateData.isComplexTask || false,
      emailNotification: emailNotification,
      category: templateData.category,
      description: templateData.description,
      outputAsJson: templateData.outputAsJson || false,
      outputAsHtml: templateData.outputAsHtml || false,
      selectedLLMs: templateData.selectedLLMs,
      useSharedBrowser: templateData.useSharedBrowser || false,
      turnOffHeadless: templateData.turnOffHeadless || false,
    };

    console.log("Attempting to create task with payload:", taskPayload);

    try {
      const response = await axios.post(
        buildApiUrl("/api/tasks"),
        taskPayload,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      console.log("Task creation API response:", response.data);

      toast({
        title: "Task Created Successfully",
        description: `Task "${taskName}" has been created. You will be redirected to the Tasks page.`,
      });

      navigate("/tasks");
    } catch (error) {
      console.error("Task creation failed:", error);
      const errorMessage =
        error.response?.data?.message ||
        "Could not create the task. Please try again.";
      toast({
        title: "Task Creation Failed",
        description: errorMessage,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-4xl font-extrabold text-gray-900 dark:text-[rgba(255,255,255,0.85)]">
          Welcome to Your Customer Portal
        </h1>
        <div className="h-0.5 w-1/4 agent-gradient rounded-full"></div>
        <p className="text-gray-500 dark:text-[rgba(255,255,255,0.7)]">
          {user && (
            <>
              Hi,{" "}
              <span className="font-medium">{user.email.split("@")[0]}</span>.
              Dive into your personalized dashboard to explore data-driven
              market insights, creative research and strategic tools—all in one
              place.
            </>
          )}
        </p>
      </div>

      <div className="flex flex-col flex-1 rounded-lg border overflow-hidden">
        {/* Conditionally render the MessageList container only if there are messages */}
        {messages.length > 0 && (
          <div className="flex-1 overflow-hidden">
            <MessageList messages={messages} />
          </div>
        )}

        <div className="border-t">
          <PromptForm
            prompt={promptTextState}
            setPrompt={setPromptTextState}
            onSubmit={handleCreateTaskFromDashboardPrompt}
            isTemplateOpen={isTemplateOpen}
            setIsTemplateOpen={setIsTemplateOpen}
            placeholder="Enter your prompt to create a new task"
            buttonText="Create Task"
          />

          <TemplateSection
            isTemplateOpen={isTemplateOpen}
            setIsTemplateOpen={setIsTemplateOpen}
            activeCategory={activeCategory}
            setActiveCategory={setActiveCategory}
            templates={groupedTemplates} // Now passes Template[] from context
            isLoading={isLoadingTemplates}
            error={templateError}
            onSelectTemplate={handleTemplateClick} // Expects DisplayTemplate
          />
        </div>
      </div>

      {/* Template Modal */}
      {selectedTemplate && (
        <TemplateModal
          isOpen={isModalOpen}
          setIsOpen={(open) => {
            setIsModalOpen(open);
            if (!open) {
              setSelectedTemplate(null);
            }
          }}
          template={selectedTemplate}
          onSubmit={handleTemplateSubmit}
        />
      )}
    </div>
  );
};

export default Dashboard;
