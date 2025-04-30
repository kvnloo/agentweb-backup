import { Request, Response } from 'express';

interface GuideSubsection {
  title: string;
  content: string[];
}

interface GuideSection {
  title: string;
  content: string[];
  subsections?: GuideSubsection[];
}

// Guide data moved from frontend
const guideSections: GuideSection[] = [
  {
    title: "Introduction",
    content: [
      "AgentWeb is a powerful web automation platform that allows you to create and manage web-based tasks using natural language instructions.",
      "This guide will walk you through all the features and functionalities of AgentWeb to help you get the most out of the platform."
    ]
  },
  {
    title: "Getting Started",
    content: [
      "To begin using AgentWeb, you'll need to create an account and log in."
    ],
    subsections: [
      {
        title: "Account Creation and Login",
        content: [
          "Directly navigate to agentweb.pro/login in your browser",
          "If you're a new user, click on 'Register' on the login page to create an account",
          "Alternatively, you can click 'Continue with Google' to use your Google account for faster login",
          "If you already have an account, enter your credentials to log in",
          "Note: The homepage is currently used for waitlist collection during the beta stage of the platform"
        ]
      }
    ]
  },
  {
    title: "Main Features",
    content: [
      "AgentWeb offers a variety of features to help you automate web tasks efficiently."
    ],
    subsections: [
      {
        title: "Tasks Dashboard",
        content: [
          "After logging in, you'll be directed to the Tasks page which serves as your dashboard where you can:",
          "- View all your active tasks with their status",
          "- See the latest execution status for each task",
          "- Check how many schedules and subscribers each task has",
          "- Access quick links to create new tasks via the 'Create Task' button",
          "- Click 'View Details' on any task to access its full information"
        ]
      },
      {
        title: "Creating a Task",
        content: [
          "Navigate to the 'Tasks' page and click 'Create Task'",
          "Fill in the following details:",
          "- Task Name: A descriptive name for your task",
          "- Task Prompt: Natural language instructions for what you want the AI agent to do",
          "  • Include specific output format requests (e.g., 'Output results as CSV file')",
          "  • Be clear about what data should be included in any output files",
          "- Interactive Mode: Toggle this on if you want the AI to ask for additional information during execution",
          "- Deep Research Mode: Toggle this on for comprehensive research tasks using public web data (automatically enables email notifications)",
          "Important Security Note:",
          "- If your task requires the agent to log into a website, you MUST provide the login credentials on the Config page first",
          "- Never provide passwords through Interactive Mode as they will appear in plaintext in the execution logs",
          "- Website credentials are securely encrypted and managed through the Config page only"
        ]
      },
      {
        title: "Using Templates",
        content: [
          "Templates provide pre-configured task setups for common operations:",
          "1. When creating a task, select the 'From Template' tab",
          "2. Browse available templates and select one that matches your needs",
          "3. Fill in any required parameters specific to your task",
          "4. Review the task preview showing how your parameters will be applied",
          "5. Create the task with your customized parameters",
          "Benefits of using templates:",
          "- Saves time by using pre-configured instructions",
          "- Ensures consistency across similar tasks",
          "- Automatically includes parameter values in task names for better organization"
        ]
      },
      {
        title: "Task Details",
        content: [
          "The Task Details page provides comprehensive information and management options:",
          "- View and edit task name and prompt",
          "- Run the task manually",
          "- View execution history with status and timestamps",
          "- Toggle email notifications",
          "- Toggle interactive mode",
          "- Toggle deep research mode",
          "- Archive tasks (archived tasks can be unarchived later)",
          "- Provide feedback on task executions (accept/reject)",
          "- Upload file attachments for the task",
          "- For any execution, click 'View Full Details' to access the execution details page"
        ]
      },
      {
        title: "Execution Details",
        content: [
          "The Execution Details page provides comprehensive information about a specific task execution:",
          "- View which LLM model was used for the execution",
          "- See the detailed execution log showing what the agent was doing at each step",
          "- View execution recordings including screenshots taken by the agent during the task",
          "- Access any result files or outputs generated during the execution",
          "- See the complete timeline of the execution from start to finish",
          "- Review any interactions that occurred during the execution if it was an interactive task"
        ]
      },
      {
        title: "Task Execution",
        content: [
          "When running a task:",
          "1. The AI agent will execute your instructions",
          "2. If in interactive mode, it may ask questions that require your response",
          "3. You'll see real-time status updates",
          "4. Once completed, you can view the results, including:",
          "   - Text summaries",
          "   - Screenshots",
          "   - Downloaded files",
          "   - HTML reports",
          "   - Structured data files (CSV, JSON, etc.) if requested in your prompt",
          "5. Click on result files to view them directly in the browser (for supported formats) or download them"
        ]
      }
    ]
  },
  {
    title: "Website Configurations",
    content: [
      "The 'Config' page allows you to securely manage website credentials:",
      "1. Click 'Add Website' to store credentials for websites you want the AI to access",
      "2. Enter the website URL, username, and password",
      "3. Credentials are securely stored and only used during task execution",
      "4. You can share configurations with specific users by entering their email",
      "5. You can also 'Share with Everyone' which allows all platform users to use your credentials (without seeing the plaintext)",
      "6. Be cautious of privacy implications when using 'Share with Everyone' as it empowers other users to use your account",
      "7. Delete configurations you no longer need"
    ]
  },
  {
    title: "Workflows",
    content: [
      "Workflows allow you to chain multiple tasks together:",
      "1. Navigate to the 'Workflows' page",
      "2. Click 'Create Workflow' to build a new workflow",
      "3. Define your workflow using natural language instructions",
      "4. The system will generate a YAML file defining the tasks and their dependencies",
      "5. Run workflows manually when needed",
      "6. View workflow execution history and results",
      "Note: Scheduling for workflows is not currently supported"
    ]
  },
  {
    title: "Scheduling",
    content: [
      "For recurring tasks:",
      "1. In the Task Details page, find the 'Schedule' section",
      "2. Click 'Add Schedule'",
      "3. Select the frequency (daily, weekly, monthly)",
      "4. Click 'Create' to set up the schedule",
      "5. Manage your schedules by:",
      "   - Disabling/enabling schedules using the toggle switch",
      "   - Deleting schedules you no longer need",
      "Note: One-time scheduling, custom start times, and end dates are not currently supported"
    ]
  },
  {
    title: "Notifications",
    content: [
      "Stay updated on task executions:",
      "1. On the Task Details page, toggle 'Email Me Latest Run' to receive notifications when a task completes or fails",
      "2. Add subscribers to receive notifications about specific tasks by entering their email addresses",
      "3. Email notifications include a summary of the task results and any important information"
    ]
  },
  {
    title: "Advanced Features",
    content: [
      "AgentWeb offers several advanced features to enhance your experience."
    ],
    subsections: [
      {
        title: "Deep Research Mode",
        content: [
          "When enabled, this mode:",
          "- Uses advanced AI to perform comprehensive research on your topic",
          "- Searches public web data for relevant information",
          "- Provides detailed reports with citations",
          "- Automatically enables email notifications"
        ]
      },
      {
        title: "File Attachments",
        content: [
          "Upload files to provide additional context for your tasks:",
          "1. In the Task Details page, find the 'Attachments' section",
          "2. Click 'Upload File'",
          "3. Select the file from your computer",
          "4. The AI agent can reference these files during task execution"
        ]
      },
      {
        title: "File Output Formats",
        content: [
          "Request the agent to output results in specific file formats:",
          "1. In your task prompt, explicitly state the desired output format",
          "2. Use clear instructions like:",
          "   - 'Output the results as a CSV file'",
          "   - 'Save the data in JSON format'",
          "   - 'Create an HTML report with the findings'",
          "   - 'Generate a TXT file with the summary'",
          "3. Be specific about what data should be included in the file",
          "4. After task execution, you'll see the generated file in the 'Result Files' section",
          "5. Click on the file to view it directly in the browser (for supported formats) or download it",
          "Supported viewable formats include:",
          "- Text formats: .html, .htm, .txt, .json, .csv, .xml, .md, .js, .css",
          "- Image formats: .jpg, .jpeg, .png, .gif, .svg, .webp",
          "- PDF format: .pdf",
          "Other formats will be downloaded when accessed."
        ]
      }
    ]
  },
  {
    title: "Admin Features",
    content: [
      "If you have admin privileges, you can access the Admin Dashboard:",
      "1. Navigate to '/admin' in the application",
      "2. Access features including:",
      "   - User management (view, deactivate users)",
      "   - Waitlist management with email invitations",
      "   - Task analytics and monitoring",
      "   - System performance metrics",
      "   - Comprehensive task overview across all users"
    ],
    subsections: [
      {
        title: "Template Management",
        content: [
          "As an admin, you can create and manage templates for all users:",
          "1. Navigate to the 'Templates' page from the main menu",
          "2. Create new templates with customizable parameters using [parameter_name] syntax",
          "3. Optionally select a parameter to include in task names for better organization",
          "4. Test templates before publishing them",
          "5. Publish templates to make them available to all users",
          "6. Edit or unpublish templates as needed",
          "Note: Only admins can create and manage templates, while all users can use published templates"
        ]
      }
    ]
  },
  {
    title: "Security Features",
    content: [
      "AgentWeb implements a strict security model:",
      "- 256-bit encryption for all stored credentials",
      "- HTTPS encryption site-wide for all data transmission",
      "- Isolated browser sessions for each user",
      "- Automatic session cleanup after task completion"
    ]
  },
  {
    title: "Troubleshooting",
    content: [
      "If you encounter issues:",
      "1. Check the task execution details for error messages",
      "2. Verify your website configurations are correct",
      "3. Ensure your task prompt is clear and specific",
      "4. For interactive tasks, make sure to respond to any questions promptly",
      "5. Contact support if issues persist"
    ]
  },
  {
    title: "Best Practices",
    content: [
      "For optimal results:",
      "1. Write clear, specific task prompts",
      "2. Use interactive mode for complex tasks that might need clarification",
      "3. Schedule recurring tasks for regular automation",
      "4. Review task results and provide feedback to improve future executions",
      "5. Use Deep Research mode for comprehensive information gathering",
      "6. Request specific file formats (CSV, JSON, etc.) for structured data output",
      "7. Be explicit about what data should be included in output files"
    ]
  }
];

export const getGuide = (req: Request, res: Response) => {
  try {
    return res.status(200).json({ success: true, data: guideSections });
  } catch (error) {
    console.error('Error fetching guide data:', error);
    return res.status(500).json({ success: false, message: 'Error fetching guide data' });
  }
}; 