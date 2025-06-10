import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
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
import { Info } from "lucide-react";
import { buildApiUrl } from "@/config";

// Extended to include fields from partner-portal's Template interface
interface FetchedTemplate {
  templateId: string;
  name: string;
  description: string;
  prompt: string;
  parameters: string[];
  category?: string;
  nameParameter?: string | null; // Added
  isInteractive?: boolean; // Added
  isDeepResearch?: boolean; // Added
  isComplexTask?: boolean; // Added
  outputAsJson?: boolean; // Added
  outputAsHtml?: boolean; // Added
  selectedLLMs?: string[]; // Added for template LLM selection
  useSharedBrowser?: boolean; // Added useSharedBrowser
  turnOffHeadless?: boolean;
}

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
  const { user, token } = useAuth();
  const [promptTextState, setPromptTextState] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTemplateOpen, setIsTemplateOpen] = useState(true);
  const [activeCategory, setActiveCategory] = useState("");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] =
    useState<DisplayTemplate | null>(null);

  const [allFetchedTemplates, setAllFetchedTemplates] = useState<
    FetchedTemplate[]
  >([]);
  const [groupedTemplates, setGroupedTemplates] = useState<
    Record<string, DisplayTemplate[]>
  >({});
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);

  useEffect(() => {
    const fetchTemplatesFromApi = async () => {
      setIsLoadingTemplates(true);
      setTemplateError(null);
      try {
        const response = await axios.get(buildApiUrl("/api/templates"), {
          ...(token && { headers: { Authorization: `Bearer ${token}` } }),
        });
        const data: FetchedTemplate[] = response.data;
        setAllFetchedTemplates(data.filter((t) => t.category));
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
    const newGroupedTemplates: Record<string, DisplayTemplate[]> = {};
    allFetchedTemplates.forEach((ft) => {
      if (ft.category) {
        if (!newGroupedTemplates[ft.category]) {
          newGroupedTemplates[ft.category] = [];
        }

        const mappedParameters: TemplateParameter[] =
          ft.parameters?.map((paramName) => ({
            id: paramName,
            name: paramName,
            required: false, // Default, actual requirement might come from backend or be assumed true
          })) || [];

        const displayTemplate: DisplayTemplate = {
          id: ft.templateId,
          title: ft.name,
          description: ft.description,
          category: ft.category!, // Category is checked, so it's not undefined here
          promptTemplate: ft.prompt,
          parameters: mappedParameters,
          icon: <Info size={24} />,
          nameParameter: ft.nameParameter,
          isInteractive: ft.isInteractive,
          isDeepResearch: ft.isDeepResearch,
          isComplexTask: ft.isComplexTask,
          outputAsJson: ft.outputAsJson,
          outputAsHtml: ft.outputAsHtml,
          selectedLLMs: ft.selectedLLMs, // Map selectedLLMs
          useSharedBrowser: ft.useSharedBrowser, // Added useSharedBrowser
          turnOffHeadless: ft.turnOffHeadless, // Added turnOffHeadless
        };
        newGroupedTemplates[ft.category].push(displayTemplate);
      }
    });
    setGroupedTemplates(newGroupedTemplates);
  }, [allFetchedTemplates]);

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

  // This function will now handle creating a task from the main dashboard prompt
  const handleCreateTaskFromDashboardPrompt = async (e: React.FormEvent) => {
    e.preventDefault();
    const promptContent = promptTextState;

    if (!user || !token) {
      toast({
        title: "Error",
        description: "User not authenticated. Please log in again.",
        variant: "destructive",
      });
      return;
    }

    if (!promptContent.trim()) {
      toast({
        title: "Input Required",
        description: "Please enter task details or a question.",
        variant: "default", // Changed to default as it's informational
      });
      return;
    }

    // Generate a name for the task
    const taskName = `Task: ${promptContent.substring(0, 50)}${
      promptContent.length > 50 ? "..." : ""
    }`;

    const taskPayload = {
      name: taskName,
      prompt: promptContent,
      isInteractive: false,
      isDeepResearch: false,
      isComplexTask: true,
      emailNotification: false,
      extractPageContent: false,
      category: "General",
      description: "Task created from dashboard prompt.",
      parameterValues: {},
      outputAsHtml: true,
      useSharedBrowser: true,
    };

    console.log(
      "Attempting to create direct task from dashboard prompt with payload:",
      taskPayload
    );
    setPromptTextState(""); // Clear input immediately

    try {
      const response = await axios.post(
        buildApiUrl("/api/tasks"),
        taskPayload,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      console.log("Direct task creation API response:", response.data);

      toast({
        title: "Task Created Successfully",
        description: `Task "${taskName}" has been created. You will be redirected.`,
      });

      navigate("/tasks"); // Navigate after success
    } catch (error) {
      console.error("Direct task creation failed:", error);
      const errorMessageText =
        error.response?.data?.message ||
        "Could not create the task. Please try again.";
      toast({
        title: "Task Creation Failed",
        description: errorMessageText,
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
            templates={groupedTemplates} // Now passes DisplayTemplate[]
            isLoading={isLoadingTemplates}
            error={templateError}
            onSelectTemplate={handleTemplateClick} // Expects DisplayTemplate
          />
        </div>
      </div>

      <TemplateModal
        isOpen={isModalOpen}
        setIsOpen={setIsModalOpen}
        template={selectedTemplate} // Receives DisplayTemplate
        onSubmit={handleTemplateSubmit} // Expects DisplayTemplate as first arg
      />
    </div>
  );
};

export default Dashboard;
