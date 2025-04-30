import { Request, Response } from 'express';

interface ApiSubsection {
  title: string;
  content: string[];
}

interface ApiSection {
  title: string;
  content: string[];
  subsections?: ApiSubsection[];
}

// API documentation data moved from frontend
const apiSections: ApiSection[] = [
  {
    title: "Introduction",
    content: [
      "AgentWeb provides a comprehensive REST API that allows developers to integrate web automation capabilities into their applications.",
      "This documentation covers all available endpoints, authentication methods, and example usage."
    ]
  },
  {
    title: "Authentication",
    content: [
      "All API endpoints (except public routes) require authentication using JWT tokens.",
      "To authenticate your requests, include the JWT token in the Authorization header:"
    ],
    subsections: [
      {
        title: "Authentication Endpoints",
        content: [
          "POST /auth/register - Register a new user",
          "- Required fields: email, password",
          "POST /auth/login - Login and get JWT token",
          "- Required fields: email, password",
          "GET /auth/me - Get current user information",
          "- Requires: Authorization header with JWT token"
        ]
      }
    ]
  },
  {
    title: "Tasks API",
    content: [
      "The Tasks API allows you to create and manage automation tasks."
    ],
    subsections: [
      {
        title: "Task Management",
        content: [
          "GET /tasks - List all tasks",
          "POST /tasks - Create a new task",
          "- Required fields: name, prompt",
          "- Optional fields: interactiveMode, deepResearchMode",
          "GET /tasks/:taskId - Get task details",
          "PUT /tasks/:taskId - Update task",
          "DELETE /tasks/:taskId - Delete task"
        ]
      },
      {
        title: "Task Execution",
        content: [
          "POST /tasks/:taskId/execute - Execute a task",
          "GET /tasks/:taskId/executions - Get task execution history",
          "GET /tasks/execution/:executionId - Get execution details",
          "POST /tasks/execution/:executionId/interaction - Respond to interactive prompts",
          "GET /tasks/execution/:executionId/log - Get execution logs"
        ]
      }
    ]
  },
  {
    title: "Configurations API",
    content: [
      "The Configurations API enables secure management of website and API credentials."
    ],
    subsections: [
      {
        title: "Website Configurations",
        content: [
          "POST /config - Add new website configuration",
          "- Required fields: website, username, password",
          "GET /config - List all configurations",
          "DELETE /config/:configId - Delete configuration",
          "POST /config/:configId/share - Share configuration",
          "- Required fields: email OR shareWithEveryone",
          "GET /config/shared - List shared configurations"
        ]
      },
      {
        title: "API Configurations",
        content: [
          "POST /config - Add new API configuration",
          "- Required fields: appName, username, password, isApiConfig",
          "- Optional fields: integrationDocLink",
          "GET /config/api/:appName - Get API configuration by app name",
          "Note: API configurations can be shared just like website configurations"
        ]
      }
    ]
  },
  {
    title: "Workflows API",
    content: [
      "The Workflows API allows creation and management of task chains."
    ],
    subsections: [
      {
        title: "Workflow Management",
        content: [
          "GET /workflows - List all workflows",
          "POST /workflows - Create new workflow",
          "GET /workflows/:workflowId - Get workflow details",
          "PUT /workflows/:workflowId - Update workflow",
          "DELETE /workflows/:workflowId - Delete workflow"
        ]
      },
      {
        title: "Workflow Generation",
        content: [
          "POST /workflows/generate - Generate workflow from natural language",
          "- Required fields: description",
          "- Returns: YAML configuration for the workflow"
        ]
      }
    ]
  },
  {
    title: "Schedules API",
    content: [
      "The Schedules API enables management of recurring task executions."
    ],
    subsections: [
      {
        title: "Schedule Management",
        content: [
          "POST /schedules - Create new schedule",
          "- Required fields: taskId, frequency (daily/weekly/monthly)",
          "GET /schedules/task/:taskId - Get schedules for a task",
          "PUT /schedules/:scheduleId - Update schedule",
          "DELETE /schedules/:scheduleId - Delete schedule"
        ]
      }
    ]
  },
  {
    title: "Admin API",
    content: [
      "The Admin API provides administrative functions (requires admin privileges)."
    ],
    subsections: [
      {
        title: "User Management",
        content: [
          "GET /admin/users - List all users",
          "GET /admin/users/:userId - Get user details",
          "PUT /admin/users/:userId - Update user",
          "DELETE /admin/users/:userId - Delete user"
        ]
      },
      {
        title: "Waitlist Management",
        content: [
          "GET /admin/waitlist - List waitlist entries",
          "POST /admin/waitlist/invite - Send invitations",
          "DELETE /admin/waitlist/:email - Remove from waitlist"
        ]
      },
      {
        title: "Analytics",
        content: [
          "GET /admin/analytics/tasks - Get task analytics",
          "- Optional query params: startDate, endDate",
          "GET /admin/analytics/users - Get user analytics",
          "- Optional query params: startDate, endDate"
        ]
      }
    ]
  }
];

export const getApiDocs = (req: Request, res: Response) => {
  try {
    return res.status(200).json({ success: true, data: apiSections });
  } catch (error) {
    console.error('Error fetching API documentation:', error);
    return res.status(500).json({ success: false, message: 'Error fetching API documentation' });
  }
}; 