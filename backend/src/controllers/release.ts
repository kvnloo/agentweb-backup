import { Request, Response } from 'express';

interface Release {
  date: string;
  changes: string[];
}

// Release data moved from frontend
const releases: Release[] = [
  {
    date: "2025-05-19",
    changes: [
      "Added new models for task runs",
      "- OpenAI GPT-4.1 from Azure",
      "- Google Gemini Pro 2.5 Preview 05-06",
      "Fixed bugs"
    ]
  },
  {
    date: "2025-05-15",
    changes: [
      "Enhanced email notifications",
      "- Updated email notifications to display HTML file content directly in the email",
      "- Added email feature in Execution Details of Partner Portal",
      "- Makes it easier to share task results with clients or team members",
      "- Useful for sending leads detailed results of task runs to help convert them"
    ]
  },
  {
    date: "2025-05-02",
    changes: [
      "Added Agentic Dev Mode to Task Details page",
      "- Enables agents to access current page content",
      "- Allows running JavaScript on the current page",
      "- Enhances developer capabilities for advanced web automation tasks"
    ]
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
      "- Improves stability and reliability for Gemini-powered tasks"
    ]
  },
  {
    date: "2025-04-29",
    changes: [
      "Introduced AI Customer Support Agent",
      "- Context-aware support assistant powered by RAG technology",
      "- Real-time access to product documentation and guides",
      "- Page-specific help based on user's current location",
      "- Integration with knowledge base for accurate responses",
      "- Powered by the advanced GPT-4.1 model from OpenAI"
    ]
  },
  {
    date: "2025-04-17",
    changes: [
      "Added Output As JSON option on Task Details page",
      "- When enabled, the agent will output results in structured JSON format",
      "- Useful for programmatic processing of agent outputs",
      "- Task will fail if agent cannot produce valid JSON output",
      "Improved reliability of agent login by providing the list of domains with valid credentials to the agent"
    ]
  },
  {
    date: "2025-03-26",
    changes: [
      "Added support for code management with GitHub",
      "- Agents can now use submit_python_code to submit code to GitHub, subject for admin review",
      "- Once merged, the code can be loaded with get_approved_python_code() and run with run_approved_python_code",
      "Added support for the latest Gemini 2.5 Pro LLM",
      "Fixed various bugs and improved stability"
    ]
  },
  {
    date: "2025-03-18",
    changes: [
      "Added no-code API access via Config page",
      "- Users can now connect to external APIs without writing any code",
      "- Simply provide API name, key, and documentation link in the Config page",
      "- Agents then can use the API in their tasks",
      "- Share API configurations while maintaining security"
    ]
  },
  {
    date: "2025-03-17",
    changes: [
      "Added Extract Page Content option on Task Details page",
      "- Contents on pages can be extracted and saved as JSON files for download",
      "- Enable this option to automatically extract structured data from web pages",
      "Added Validate Output option on Task Details page",
      "- When enabled, the agent will validate its output to ensure higher accuracy",
      "Bug fixes"
    ]
  },
  {
    date: "2025-03-13",
    changes: [
      "Added execution details sharing functionality",
      "- Users can now share execution details via a secure URL",
      "- Share button added to Execution Details page",
      "- Shared executions can be viewed without requiring login"
    ]
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
      "- Expanded model selection provides more options for different task types"
    ]
  },
  {
    date: "2025-03-10",
    changes: [
      "Added Complex Task toggle on Task Details page",
      "- Allows agents to run up to 100 steps (instead of default 25)",
      "- Enables completion of more complex tasks requiring more actions"
    ]
  },
  {
    date: "2025-03-09",
    changes: [
      "Introduced Templates for task creation",
      "- Pre-configured templates with customizable parameters",
      "- Parameter values can be included in task names",
      "- Saves time and ensures consistency across similar tasks"
    ]
  },
  {
    date: "2025-03-07",
    changes: [
      "Added User Guide page",
      "Fixed various UI bugs"
    ]
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
      "- It helps easily identify important emails"
    ]
  },
  {
    date: "2025-03-03",
    changes: [
      "Improved Deep Research reports",
      "- Reduced hallucination on citations",
      "- Added support for Azure OpenAI o1-mini model, which offers improved reasoning capabilities",
      "Optimized polling for Task Details page to reduce unnecessary traffic"
    ]
  },
  {
    date: "2025-02-28",
    changes: [
      "Added public credential sharing feature",
      "- Users can share their configured website credentials with everyone in Config page",
      "- Shared credentials remain securely encrypted and protected",
      "- Enhanced security with session isolation for shared credentials"
    ]
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
      "- Automatic fallback to other LLMs if preferred one fails"
    ]
  },
  {
    date: "2025-02-13",
    changes: [
      "Added execution log display for better task debugging visibility",
      "Enhanced user experience with detailed execution logs",
      "Improved error tracking and troubleshooting capabilities"
    ]
  },
  {
    date: "2025-02-12",
    changes: [
      "Added support for file attachments in tasks",
      "Implemented file download functionality for task results",
      "Enhanced task interface to manage attachments and downloads"
    ]
  },
  {
    date: "2025-02-11",
    changes: [
      "Major upgrade: Introduced Workflows feature",
      "Added support for creating workflows using natural programming language",
      "Implemented workflow execution engine",
      "Added workflow management interface",
      "Support for tasks running in predefined order within workflows"
    ]
  },
  {
    date: "2025-02-02",
    changes: [
      "Implemented parallel task execution",
      "Improved task scheduling and management",
      "Enhanced system performance for concurrent tasks"
    ]
  },
  {
    date: "2025-01-31",
    changes: [
      "Added support for editable task prompts",
      "Implemented per-user cookie file system",
      "Enhanced user isolation and security",
      "Improved user experience with customizable tasks"
    ]
  },
  {
    date: "2025-01-30",
    changes: [
      "Added support for multiple LLM providers:",
      "- AWS Anthropic Claude 3.5 Sonnet",
      "- Azure OpenAI GPT-4o",
      "- OpenAI GPT-4o",
      "Enhanced AI model selection and fallback system"
    ]
  },
  {
    date: "2025-01-29",
    changes: [
      "Implemented task subscription system via email",
      "Added email notifications for task results",
      "Support for non-registered users to receive task updates",
      "Enhanced collaboration features for team usage"
    ]
  },
  {
    date: "2025-01-27",
    changes: [
      "Beta launch of AgentWeb",
      "Initial UI implementation",
      "Core backend services deployment",
      "Agent engine development and integration",
      "Basic task management system"
    ]
  }
];

export const getReleases = (req: Request, res: Response) => {
  try {
    return res.status(200).json({ success: true, data: releases });
  } catch (error) {
    console.error('Error fetching release data:', error);
    return res.status(500).json({ success: false, message: 'Error fetching release data' });
  }
}; 