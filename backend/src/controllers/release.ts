import { Request, Response } from "express";

interface Release {
  date: string;
  changes: string[];
}

// Release data moved from frontend
const releases: Release[] = [
  {
    date: "2025-10-13",
    changes: [
      "Added search_web function call to browser agent",
      "- search_web is an alternative to search_google as Google Search sometimes are blocked by reCAPTCHA",
    ],
  },
  {
    date: "2025-10-07",
    changes: [
      "Added Create User in Waitlist tab of Admin Page",
      "- Admins can now create user accounts directly from waitlist entries",
      "- Generate random secure passwords and send welcome emails to new users",
      "- Transfer waitlist data (company name, use cases, etc.) to new user accounts",
      "- Support role assignment (customer, partner, free) during user creation",
      "- Icon-only Create User button appears only for unregistered waitlist entries",
    ],
  },
  {
    date: "2025-09-25",
    changes: [
      "Added visualizations and fixed bugs in metrics data for admin page",
      "- Added comprehensive chart visualizations to admin Overview tab including user growth, task growth, and execution trends",
      "- Fixed critical date comparison logic in analytics functions that was causing inaccurate metrics",
      "- Implemented DynamoDB pagination to handle large datasets properly",
      "- Added proper error handling and logging for better debugging",
      "- Enhanced admin dashboard with interactive charts using Chart.js",
      "Supported configuring report revision system prompt in Default Prompts tab of Admin page",
      "- Added new Default Prompts tab to admin dashboard for managing AI system instructions",
      "- Fixed knowledge base metrics data issue",
    ],
  },
  {
    date: "2025-09-20",
    changes: [
      "Supported Repair Image Embedding for HTML reports",
      "- Added Repair Image Embedding option to Task Details page alongside Email Friendly HTML",
      "- Automatically detects and fixes broken image links in HTML reports",
      "- Replaces relative image paths with full file paths from available assets",
      "- Ensures all available image files are properly referenced in HTML output",
    ],
  },
  {
    date: "2025-09-02",
    changes: [
      "Fixed issue with header color issue with subscriber emails",
      "- Removed unnecessary styling from email templates to prevent white text visibility issues",
      "- Headers and footers in subscriber emails are now properly visible",
      "- Applied fixes to both agent-engine and backend email services",
    ],
  },
  {
    date: "2025-08-28",
    changes: [
      "Added new image model Nano Banana from Google Gemini",
      "- Users can now select gemini-2.5-flash-image-preview as an alternative to OpenAI and FLUX models",
      "- Nano Banana provides advanced image generation and editing capabilities through Google's Gemini API",
      "- Model selection is available on the Task Details page with a dropdown menu",
      "- Selected model is automatically saved and used for image generation tasks",
    ],
  },
  {
    date: "2025-08-27",
    changes: [
      "Improved Growth Genius chat service",
      "- Added chat interface with ChatGPT-like sidebar and dedicated chat pages",
      "- Improved system prompt to make sure the chatbot is less salesy",
      "- Added startup profile management system for personalized context",
      "- Home page will direct the user to chat page when the user sends a message",
    ],
  },
  {
    date: "2025-08-26",
    changes: [
      "Created Growth Genius chat service",
      "- New AI-powered startup growth assistant chatbot",
      "- Dedicated frontend application with modern UI/UX",
      "- Integration with existing AgentWeb authentication system",
      "- Knowledge base search capabilities via Azure OpenAI function calling",
      "- Chat session management with persistent history",
    ],
  },
  {
    date: "2025-08-20",
    changes: [
      "Added Flux model for image generation",
      "- Users can now select FLUX.1-Kontext-pro (Azure) as an alternative to openai-image-1 (OpenAI)",
      "- FLUX model provides advanced image generation and editing capabilities",
      "- Model selection is available on the Task Details page with a dropdown menu",
      "- Selected model is automatically saved and used for image generation tasks",
    ],
  },
  {
    date: "2025-08-12",
    changes: [
      "Added OpenAI GPT-5 mode via Azure",
      "- Users can now access GPT-5 through Azure integration for enhanced AI capabilities",
      "- This model replaces the openai->openai->gpt-5 model for better performance and cost efficiency",
    ],
  },
  {
    date: "2025-08-07",
    changes: [
      "Added support for GPT-5",
      "- GPT-5 is now available as an advanced reasoning model",
      "- Users can access GPT-5 by selecting openai->openai->gpt-5 model in preferred models",
      "- GPT-5 provides the most advanced AI capabilities for strategic thinking and deep analysis",
    ],
  },
  {
    date: "2025-08-01",
    changes: [
      "Added video model selection on Task Details page",
      "- Users can now choose between VEO 3 from Google or Runway model",
      "- Selected model is displayed as a chip next to the Create Video toggle",
    ],
  },
  {
    date: "2025-07-31",
    changes: [
      "Added Create Video toggle to Task Details",
      "- Users can now enable video generation capabilities for tasks",
      "- Supports both text-to-video and image-to-video generation using Google VEO API",
      "- Generated videos are 8-second MP4 files in 16:9 aspect ratio",
      "- Includes support for negative prompts to avoid unwanted elements",
      "- Videos are automatically saved to downloads folder and can be referenced in task results",
    ],
  },
  {
    date: "2025-07-28",
    changes: [
      "Added support for two new Gemini models: Gemini 2.5 Flash and Gemini 2.5 Flash Lite",
      "- These models are cheaper and faster compared to Gemini 2.5 Pro",
      "- Available for regular tasks with improved cost efficiency",
      "Removed older Gemini models: Gemini 2.0 Flash and Gemini 2.5 Pro Preview 03-25",
      "- These models are no longer useful and have been replaced by newer, more efficient alternatives",
    ],
  },
  {
    date: "2025-07-24",
    changes: [
      "Enhanced Admin page to support showing tasks of a given user:",
      "- Admins can now click on a user's task count in the Users tab to view all tasks for that user in a popup dialog.",
      "- The task list includes Task ID, Name, truncated Prompt, and a 'View Details' link for each task (opens in a new tab).",
    ],
  },
  {
    date: "2025-07-18",
    changes: [
      "Lifted file size limit from 1MB to 5MB for task attachments",
      "- Users can now upload larger files (up to 5MB) as task attachments",
      "- Improved file upload experience for documents, images, and other larger files",
    ],
  },
  {
    date: "2025-06-18",
    changes: [
      "Temporarily removed the 'Perform Deep Research' toggle from the Create Task and Task Details pages to prevent accidental use.",
    ],
  },
  {
    date: "2025-06-17",
    changes: [
      "Enhanced Admin Dashboard with Waitlist Analytics",
      "- Added marketing channels tracking in waitlist management",
      "- Implemented visualization of user acquisition sources",
      "- Added ability to filter and analyze waitlist entries by marketing channel",
      "- Enhanced admin insights for better marketing strategy optimization",
    ],
  },
  {
    date: "2025-06-16",
    changes: [
      "Added support for scalable lead generation list at task level",
      "- Enable Update Lead List option to allow agents to add records to the lead list",
      "- Users can manually maintain the list by editing it",
      "- Each record requires a unique identifier field for tracking",
      "- Records are automatically merged when duplicates are found",
    ],
  },
  {
    date: "2025-06-11",
    changes: [
      "Enhanced Knowledge Base features",
      "- Added support for private knowledge base",
      "- Added Knowledge Base tab to admin page for metrics and management",
      "- Enhanced Task Details page with knowledge base creation and management",
      "- Added automatic knowledge base updates from execution records",
      "- Added support for private knowledge base access to both web agents and Emma chatbot",
    ],
  },
  {
    date: "2025-06-06",
    changes: [
      "Added support for task rerun in Workflows",
      "- Users can now rerun individual tasks with modified prompts after an execution",
      "- Avoids the need to run a complete workflow which could take much longer time and consume more tokens",
      "- Added ability to kill a task when rerunning it",
      "Enhanced Admin capabilities with workflow management",
      "- Added Workflows tab in Admin page for viewing and managing user workflows",
      "- Admins can help users debug by running workflows and rerun tasks on their behalf",
    ],
  },
  {
    date: "2025-06-04",
    changes: [
      "Improved the workflow feature",
      "- Added a Workflow Execution Details page for better visibility",
      "- Enhanced Workflow to support referencing existing tasks of the user",
      "Tasks page shows knowledge size for better knowledge base management",
      "Enhanced admin functions for better customer support",
      "- Added ability for admins to archive and kill task executions",
    ],
  },
  {
    date: "2025-05-30",
    changes: [
      "Added support for Knowledge Base",
      "- Based on Google Vertex AI Search for powerful search capability",
      "- Automatically update knowledge base from good execution records",
      "- Manual knowledge base updates available on Task Details page",
      "- Enable 'Use Knowledge Base' option when running tasks",
      "- Agents can search platform-wide knowledge base during web navigation",
      "- Chatbots now have access to platform-wide knowledge base for more comprehensive support",
    ],
  },
  {
    date: "2025-05-23",
    changes: [
      "Support Turn Off Headless toggle",
      "- Added new toggle in Task Details page of Partner Portal and Templates",
      "- When creating a new task based on a template, this setting will be enabled based on template",
      "- Useful for tasks which visit sites that require headless to be off such as x.com, circle.so",
    ],
  },
  {
    date: "2025-05-22",
    changes: [
      "Added Kill button to Execution Details page",
      "- Users can now terminate a running task execution if not satisfied with its progress",
      "- Provides better control over task execution and resource management",
      "- Helps prevent unnecessary resource usage from unwanted executions",
      "Improved task ownership change notifications",
      "- Fixed a bug",
      "- Single email sent to new owner with old owner and admin CC'd",
      "- Updated email links to point to customer portal instead of partner portal",
    ],
  },
  {
    date: "2025-05-19",
    changes: [
      "Added new models for task runs",
      "- OpenAI GPT-4.1 from Azure",
      "- Google Gemini Pro 2.5 Preview 05-06",
      "Fixed bugs",
    ],
  },
  {
    date: "2025-05-15",
    changes: [
      "Enhanced email notifications",
      "- Updated email notifications to display HTML file content directly in the email",
      "- Added email feature in Execution Details of Partner Portal",
      "- Makes it easier to share task results with clients or team members",
      "- Useful for sending leads detailed results of task runs to help convert them",
    ],
  },
  {
    date: "2025-05-02",
    changes: [
      "Added Agentic Dev Mode to Task Details page",
      "- Enables agents to access current page content",
      "- Allows running JavaScript on the current page",
      "- Enhances developer capabilities for advanced web automation tasks",
    ],
  },
  {
    date: "2025-05-01",
    changes: [
      "Implemented near real-time task execution monitoring",
      "- Execution log updates every 10 seconds on Execution Details page",
      "- Provides near real-time visibility into task progress",
      "- Enhances user experience with live execution updates",
      "Updated Gemini 2.5 Pro model from experimental to preview status",
      "- Resolves rate limit issues with the experimental model",
      "- Improves stability and reliability for Gemini-powered tasks",
    ],
  },
  {
    date: "2025-04-29",
    changes: [
      "Introduced AI Customer Support Agent",
      "- Context-aware support assistant powered by RAG technology",
      "- Real-time access to product documentation and guides",
      "- Page-specific help based on user's current location",
      "- Integration with knowledge base for accurate responses",
      "- Powered by the advanced GPT-4.1 model from OpenAI",
    ],
  },
  {
    date: "2025-04-17",
    changes: [
      "Added Output As JSON option on Task Details page",
      "- When enabled, the agent will output results in structured JSON format",
      "- Useful for programmatic processing of agent outputs",
      "- Task will fail if agent cannot produce valid JSON output",
      "Improved reliability of agent login by providing the list of domains with valid credentials to the agent",
    ],
  },
  {
    date: "2025-03-26",
    changes: [
      "Added support for code management with GitHub",
      "- Agents can now use submit_python_code to submit code to GitHub, subject for admin review",
      "- Once merged, the code can be loaded with get_approved_python_code() and run with run_approved_python_code",
      "Added support for the latest Gemini 2.5 Pro LLM",
      "Fixed various bugs and improved stability",
    ],
  },
  {
    date: "2025-03-18",
    changes: [
      "Added no-code API access via Config page",
      "- Users can now connect to external APIs without writing any code",
      "- Simply provide API name, key, and documentation link in the Config page",
      "- Agents then can use the API in their tasks",
      "- Share API configurations while maintaining security",
    ],
  },
  {
    date: "2025-03-17",
    changes: [
      "Added Extract Page Content option on Task Details page",
      "- Contents on pages can be extracted and saved as JSON files for download",
      "- Enable this option to automatically extract structured data from web pages",
      "Added Validate Output option on Task Details page",
      "- When enabled, the agent will validate its output to ensure higher accuracy",
      "Bug fixes",
    ],
  },
  {
    date: "2025-03-13",
    changes: [
      "Added execution details sharing functionality",
      "- Users can now share execution details via a secure URL",
      "- Share button added to Execution Details page",
      "- Shared executions can be viewed without requiring login",
    ],
  },
  {
    date: "2025-03-11",
    changes: [
      "Added support for output files (CSV, JSON, etc.)",
      "- Agents can now write results directly to files in various formats",
      "- Supported formats include CSV, JSON, TXT, XML, HTML, and more",
      "- Files can be downloaded after task execution is complete",
      "Added Complex Task support with Templates",
      "- Templates can now be configured with Complex Task option",
      "Added new models for running regular tasks: Anthropic 3.7 sonnet and Google Gemini 2.0 flash",
      "- Note: These models are not available for deep research yet",
      "- Expanded model selection provides more options for different task types",
    ],
  },
  {
    date: "2025-03-10",
    changes: [
      "Added Complex Task toggle on Task Details page",
      "- Allows agents to run up to 100 steps (instead of default 25)",
      "- Enables completion of more complex tasks requiring more actions",
    ],
  },
  {
    date: "2025-03-09",
    changes: [
      "Introduced Templates for task creation",
      "- Pre-configured templates with customizable parameters",
      "- Parameter values can be included in task names",
      "- Saves time and ensures consistency across similar tasks",
    ],
  },
  {
    date: "2025-03-07",
    changes: ["Added User Guide page", "Fixed various UI bugs"],
  },
  {
    date: "2025-03-05",
    changes: [
      "Replaced Delete Task with Archive Task functionality",
      "- Tasks can now be archived instead of permanently deleted",
      "- Archived tasks can be unarchived from the Task Details page",
      "- Archived tasks are hidden from the main Tasks page",
      "- Task schedules are automatically disabled when a task is archived",
      "Enhanced email notifications for task executions",
      "- Email titles of task executions now include summary of new information",
      "- This informative subject works for both users and subscribers",
      "- It helps easily identify important emails",
    ],
  },
  {
    date: "2025-03-03",
    changes: [
      "Improved Deep Research reports",
      "- Reduced hallucination on citations",
      "- Added support for Azure OpenAI o1-mini model, which offers improved reasoning capabilities",
      "Optimized polling for Task Details page to reduce unnecessary traffic",
    ],
  },
  {
    date: "2025-02-28",
    changes: [
      "Added public credential sharing feature",
      "- Users can share their configured website credentials with everyone in Config page",
      "- Shared credentials remain securely encrypted and protected",
      "- Enhanced security with session isolation for shared credentials",
    ],
  },
  {
    date: "2025-02-26",
    changes: [
      "Added Deep Research mode powered by AG2 multi-agent framework",
      "- Users can enable Deep Research mode on Task Details page",
      "- Advanced AI performs comprehensive research on topics",
      "- Generates detailed research reports with findings",
      "- Special thanks to Chi Wang@Google Deepmind for AG2 framework support",
      "Added task name editing functionality",
      "- Users can edit task name on Task Details page",
      "Implemented preferred LLM selection for tasks",
      "- Users can choose specific LLM for task execution",
      "- Automatic fallback to other LLMs if preferred one fails",
    ],
  },
  {
    date: "2025-02-13",
    changes: [
      "Added execution log display for better task debugging visibility",
      "Enhanced user experience with detailed execution logs",
      "Improved error tracking and troubleshooting capabilities",
    ],
  },
  {
    date: "2025-02-12",
    changes: [
      "Added support for file attachments in tasks",
      "Implemented file download functionality for task results",
      "Enhanced task interface to manage attachments and downloads",
    ],
  },
  {
    date: "2025-02-11",
    changes: [
      "Major upgrade: Introduced Workflows feature",
      "Added support for creating workflows using natural programming language",
      "Implemented workflow execution engine",
      "Added workflow management interface",
      "Support for tasks running in predefined order within workflows",
    ],
  },
  {
    date: "2025-02-02",
    changes: [
      "Implemented parallel task execution",
      "Improved task scheduling and management",
      "Enhanced system performance for concurrent tasks",
    ],
  },
  {
    date: "2025-01-31",
    changes: [
      "Added support for editable task prompts",
      "Implemented per-user cookie file system",
      "Enhanced user isolation and security",
      "Improved user experience with customizable tasks",
    ],
  },
  {
    date: "2025-01-30",
    changes: [
      "Added support for multiple LLM providers:",
      "- AWS Anthropic Claude 3.5 Sonnet",
      "- Azure OpenAI GPT-4o",
      "- OpenAI GPT-4o",
      "Enhanced AI model selection and fallback system",
    ],
  },
  {
    date: "2025-01-29",
    changes: [
      "Implemented task subscription system via email",
      "Added email notifications for task results",
      "Support for non-registered users to receive task updates",
      "Enhanced collaboration features for team usage",
    ],
  },
  {
    date: "2025-01-27",
    changes: [
      "Beta launch of AgentWeb",
      "Initial UI implementation",
      "Core backend services deployment",
      "Agent engine development and integration",
      "Basic task management system",
    ],
  },
];

export const getReleases = (req: Request, res: Response) => {
  try {
    return res.status(200).json({ success: true, data: releases });
  } catch (error) {
    console.error("Error fetching release data:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error fetching release data" });
  }
};
