import { Container, Typography, Paper, Box, Divider, Link, Accordion, AccordionSummary, AccordionDetails } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';

interface GuideSection {
  title: string;
  content: string[];
  subsections?: {
    title: string;
    content: string[];
  }[];
}

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
          "- Interactive Mode: Toggle this on if you want the AI to ask for additional information during execution",
          "- Deep Research Mode: Toggle this on for comprehensive research tasks using public web data (automatically enables email notifications)"
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
          "- Archive or delete tasks",
          "- Provide feedback on task executions (accept/reject)",
          "- Upload file attachments for the task"
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
          "   - HTML reports"
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
      "4. You can share configurations with other users by entering their email",
      "5. Delete configurations you no longer need"
    ]
  },
  {
    title: "Workflows",
    content: [
      "Workflows allow you to chain multiple tasks together:",
      "1. Navigate to the 'Workflows' page",
      "2. Click 'Create Workflow' to build a new workflow",
      "3. Add tasks to your workflow and define their sequence",
      "4. Set conditions for task execution",
      "5. Run workflows manually or schedule them",
      "6. View workflow execution history and results"
    ]
  },
  {
    title: "Scheduling",
    content: [
      "For recurring tasks:",
      "1. In the Task Details page, find the 'Schedule' section",
      "2. Click 'Add Schedule'",
      "3. Set the frequency (one-time, daily, weekly, monthly)",
      "4. Choose the start date and time",
      "5. Optionally set an end date",
      "6. View and manage all schedules for the task"
    ]
  },
  {
    title: "Notifications",
    content: [
      "Stay updated on task executions:",
      "1. Toggle email notifications for individual tasks",
      "2. Add subscribers to receive notifications about specific tasks",
      "3. Receive alerts for task completion or failures"
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
        title: "Task Sharing",
        content: [
          "Share task results with others:",
          "1. Add subscribers to your task",
          "2. Enter their email address",
          "3. They will receive notifications and results when the task completes"
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
    ]
  },
  {
    title: "Security Features",
    content: [
      "AgentWeb implements a strict security model:",
      "- Zero permanent storage of target website credentials",
      "- Fresh credential input required for each task execution",
      "- Isolated browser sessions for each task",
      "- MFA-protected AgentWeb accounts",
      "- No correlation between AgentWeb accounts and target website credentials",
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
      "6. Organize related tasks into workflows for efficient execution"
    ]
  }
];

export default function Guide() {
  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        AgentWeb User Guide
      </Typography>
      
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {guideSections.map((section, index) => (
          <Paper key={index} sx={{ p: 3 }}>
            <Typography variant="h5" component="h2" gutterBottom>
              {section.title}
            </Typography>
            
            <Divider sx={{ mb: 2 }} />
            
            <Box sx={{ mb: 2 }}>
              {section.content.map((paragraph, paragraphIndex) => {
                const isListItem = paragraph.startsWith('-') || paragraph.match(/^\d+\./);
                return (
                  <Typography 
                    key={paragraphIndex} 
                    variant="body1" 
                    component={isListItem ? 'li' : 'p'} 
                    sx={{ 
                      mb: 1,
                      ...(isListItem && paragraph.startsWith('-') && {
                        listStyleType: 'none',
                        pl: 2,
                        position: 'relative',
                        '&::before': {
                          content: '"•"',
                          position: 'absolute',
                          left: 0,
                          color: 'text.secondary'
                        }
                      })
                    }}
                  >
                    {isListItem && paragraph.startsWith('-') ? paragraph.substring(2) : paragraph}
                  </Typography>
                );
              })}
            </Box>
            
            {section.subsections && section.subsections.map((subsection, subIndex) => (
              <Accordion key={subIndex} sx={{ mb: 1, '&:before': { display: 'none' } }}>
                <AccordionSummary
                  expandIcon={<ExpandMoreIcon />}
                  aria-controls={`panel${index}-${subIndex}-content`}
                  id={`panel${index}-${subIndex}-header`}
                >
                  <Typography variant="h6">{subsection.title}</Typography>
                </AccordionSummary>
                <AccordionDetails>
                  <Box component={subsection.content.some(p => p.startsWith('-')) ? 'ul' : 'div'} sx={{ m: 0, pl: subsection.content.some(p => p.startsWith('-')) ? 3 : 0 }}>
                    {subsection.content.map((paragraph, paragraphIndex) => {
                      const isListItem = paragraph.startsWith('-') || paragraph.match(/^\d+\./);
                      return (
                        <Typography 
                          key={paragraphIndex} 
                          variant="body1" 
                          component={isListItem ? 'li' : 'p'} 
                          sx={{ 
                            mb: 1,
                            ...(isListItem && paragraph.startsWith('-') && {
                              listStyleType: 'none',
                              pl: 2,
                              position: 'relative',
                              '&::before': {
                                content: '"•"',
                                position: 'absolute',
                                left: 0,
                                color: 'text.secondary'
                              }
                            })
                          }}
                        >
                          {isListItem && paragraph.startsWith('-') ? paragraph.substring(2) : paragraph}
                        </Typography>
                      );
                    })}
                  </Box>
                </AccordionDetails>
              </Accordion>
            ))}
          </Paper>
        ))}
      </Box>
    </Container>
  );
} 