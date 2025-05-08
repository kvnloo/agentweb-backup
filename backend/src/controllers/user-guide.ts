import { Request, Response } from 'express';

interface UserGuideSubsection {
  title: string;
  content: string[];
}

interface UserGuideSection {
  title: string;
  content: string[];
  subsections?: UserGuideSubsection[];
}

const userGuideSections: UserGuideSection[] = [
  {
    title: "Welcome to Your Customer Portal",
    content: [
      "Welcome! This portal is your command center for leveraging AgentWeb's powerful automation capabilities for your marketing needs.",
      "Here, you can create and manage tasks, access pre-defined templates, and interact with Emma, your AI marketing assistant.",
      "This guide will walk you through the key features available to you."
    ]
  },
  {
    title: "Getting Started",
    content: [
      "Accessing and navigating your Customer Portal is designed to be intuitive."
    ],
    subsections: [
      {
        title: "Logging In",
        content: [
          "To access your portal, navigate to the login page provided.",
          "You can log in using your registered email and password, or by using your Google account via the Google Sign-In option.",
          "If you have forgotten your password, use the 'Forgot Password' link on the login page.",
          "New users can create an account using the 'Register' option."
        ]
      },
      {
        title: "Portal Navigation",
        content: [
          "Once logged in, the main sections you'll interact with are:",
          "- Dashboard: Your primary workspace for creating tasks and accessing templates.",
          "- Tasks: View and manage all your created tasks and their execution history.",
          "- Settings: Manage your profile and account preferences.",
          "- Emma (AI Assistant): Your 24/7 marketing operator, typically accessible via a chat panel on the right side of your screen."
        ]
      }
    ]
  },
  {
    title: "Dashboard: Creating and Managing Tasks",
    content: [
      "The Dashboard is your main hub for initiating new marketing tasks and leveraging predefined strategies."
    ],
    subsections: [
      {
        title: "Creating Tasks Directly",
        content: [
          "At the top of the Dashboard (or in a prominent input area), you'll find a prompt input field.",
          "Simply type your marketing task request or question directly into this field (e.g., 'Analyze competitor X's latest social media campaign' or 'Draft three ad headlines for a new shoe launch').",
          "Click 'Create Task', and a new task will be generated based on your prompt. You'll be redirected to the Tasks page to see its progress."
        ]
      },
      {
        title: "Using Task Templates",
        content: [
          "Below the main input area or in a dedicated section, you'll find Task Templates designed to streamline common marketing activities.",
          "These templates are organized into categories such as:",
          "  - Market Research: For tasks like competitor analysis, SEO keyword research, and website diagnostics.",
          "  - Creative Research: For generating ad copy, campaign structures, and analyzing competitor creative strategies.",
          "  - Social Listening: (Coming Soon) For monitoring brand mentions and sentiment.",
          "To use a template, click on it, fill in any required parameters in the modal that appears, and submit. This will create a new task pre-configured with the template's logic."
        ]
      }
    ]
  },
  {
    title: "Managing Your Tasks",
    content: [
      "The 'Tasks' page (accessible from the navigation menu) lists all tasks you've created, whether directly or from a template."
    ],
    subsections: [
      {
        title: "Viewing Your Task List",
        content: [
          "On the Tasks page, each task will typically display its name, current status (e.g., Queued, Running, Completed, Failed), and creation date.",
          "You can quickly see the state of all your ongoing and completed marketing automations."
        ]
      },
      {
        title: "Understanding Task Details",
        content: [
          "Click on any task in the list to navigate to its Task Details page.",
          "Here you'll find comprehensive information:",
          "  - Basic Info: Task name, description (if any), original prompt, and category.",
          "  - Executions: A chronological list of all attempts to run this task.",
          "    - Each execution shows its ID, status, start and end times, and a truncated preview of the result.",
          "    - Click on an individual execution in this list to open a detailed view/modal.",
          "  - Detailed Execution View: When you select an execution, a modal or panel will display its full prompt and the complete, untruncated result.",
          "  - Re-run Task: On the Task Details page, you'll find a button to re-initiate the task with its original prompt and settings."
        ]
      }
    ]
  },
  {
    title: "Emma: Your AI Marketing Assistant",
    content: [
      "Emma is your dedicated 24/7 AI marketing operator, available directly within the Customer Portal (usually via a chat panel on the right).",
      "Emma can help you with:",
      "  - Understanding Portal Features: Ask questions about how to use the portal (she's learning from this guide!).",
      "  - Market Research: Request information on market trends, competitor activities, and more.",
      "  - Campaign Planning & Optimization: Get assistance in strategizing your marketing campaigns.",
      "  - Performance Metrics: Inquire about key metrics and how to track them (feature may depend on integrations).",
      "Simply type your questions or requests into Emma's chat window. She will use her knowledge base, including this user guide and the content of the pages you are viewing, to assist you."
    ]
  },
  {
    title: "Account Settings",
    content: [
      "The 'Settings' page (usually accessible from your user profile icon or a navigation link) allows you to manage your account."
    ],
    subsections: [
      {
        title: "Profile Management",
        content: [
          "Update your name, contact information, and ensure your email address is current for notifications."
        ]
      },
      {
        title: "Password Management",
        content: [
          "Change your portal password regularly for security. Choose a strong, unique password."
        ]
      }
    ]
  },
  {
    title: "Troubleshooting & Support",
    content: [
      "If you encounter issues or have questions not covered by Emma or this guide:",
      "  - Review error messages carefully; they often provide clues.",
      "  - For critical issues, please contact your service administrator or the support channel provided during your onboarding."
    ]
  }
];

export const getUserGuide = (req: Request, res: Response) => {
  try {
    res.status(200).json({
      success: true,
      data: userGuideSections
    });
  } catch (error) {
    console.error('Error fetching user guide:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching user guide',
      error: error instanceof Error ? error.message : String(error)
    });
  }
}; 