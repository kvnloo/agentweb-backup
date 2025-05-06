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
      "This portal provides you with access to your services, task overviews, reports, and account settings.",
      "Use this guide to understand the features available to you."
    ]
  },
  {
    title: "Getting Started",
    content: [
      "Accessing and navigating your customer portal is simple."
    ],
    subsections: [
      {
        title: "Logging In",
        content: [
          "To access your portal, navigate to the login page provided by your service administrator.",
          "Enter your email and password to log in.",
          "If you have forgotten your password, use the 'Forgot Password' link on the login page.",
          "New users may need to register first using the 'Register' option."
        ]
      },
      {
        title: "Portal Navigation",
        content: [
          "Once logged in, you will find several key sections:",
          "- Dashboard: An overview of your services and recent activity.",
          "- Tasks: A list of tasks related to your account and their current status.",
          "- Market Research: Access to market research reports if applicable to your services.",
          "- Settings: Manage your profile, preferences, and security settings."
        ]
      }
    ]
  },
  {
    title: "Dashboard",
    content: [
      "The Dashboard is your main landing page after logging in.",
      "It provides a quick overview of important information, such as recent task updates, service status, or key metrics relevant to your account."
    ]
  },
  {
    title: "Managing Your Tasks",
    content: [
      "The 'Tasks' section allows you to keep track of automated processes and services related to your account."
    ],
    subsections: [
      {
        title: "Viewing Tasks",
        content: [
          "Navigate to the 'Tasks' page from the main menu.",
          "Here you will see a list of all tasks associated with your account.",
          "Each task entry will typically show the task name, its current status (e.g., pending, in progress, completed, failed), and the last update time."
        ]
      },
      {
        title: "Task Details",
        content: [
          "For more information about a specific task, you may be able to click on it or a 'Details' button.",
          "This might show you more detailed logs, outputs if available, or the history of the task's executions."
        ]
      }
    ]
  },
  {
    title: "Market Research Reports",
    content: [
      "If your service package includes Market Research Reports, you can access them through the 'Market Research' section.",
      "These reports provide insights and data relevant to your industry or specific requests.",
      "Click on a report to view its details."
    ]
  },
  {
    title: "Account Settings",
    content: [
      "The 'Settings' page allows you to manage your personal information and portal preferences."
    ],
    subsections: [
      {
        title: "Profile Management",
        content: [
          "Update your name, contact information, and other personal details.",
          "Ensure your email address is current to receive important notifications."
        ]
      },
      {
        title: "Password Management",
        content: [
          "You can change your portal password for security reasons.",
          "It's recommended to use a strong, unique password."
        ]
      },
      {
        title: "Preferences",
        content: [
          "Set any available preferences for how the portal behaves or how you receive notifications (if applicable)."
        ]
      }
    ]
  },
  {
    title: "Getting Support",
    content: [
      "If you need help or have questions about using the portal, look for a 'Support' or 'Chat' option.",
      "This will connect you to our support team or a helpful AI assistant that can guide you."
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