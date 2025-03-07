import { Container, Typography, Paper, Box, Divider } from '@mui/material';

interface Release {
  date: string;
  changes: string[];
}

const releases: Release[] = [
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

export default function Release() {
  return (
    <Container maxWidth="lg" sx={{ mt: 4, mb: 4 }}>
      <Typography variant="h4" component="h1" gutterBottom>
        Release History
      </Typography>
      
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {releases.map((release, index) => (
          <Paper key={index} sx={{ p: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 2 }}>
              <Typography variant="subtitle1" color="text.secondary">
                {new Date(`${release.date}T12:00:00Z`).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                  timeZone: 'UTC'
                })}
              </Typography>
            </Box>
            
            <Divider sx={{ mb: 2 }} />
            
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {release.changes.map((change, changeIndex) => {
                const isSubItem = change.startsWith('- ');
                return (
                  <Typography 
                    key={changeIndex} 
                    component="li" 
                    variant="body1" 
                    sx={{ 
                      mb: 1,
                      ...(isSubItem && {
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
                    {isSubItem ? change.substring(2) : change}
                  </Typography>
                );
              })}
            </Box>
          </Paper>
        ))}
      </Box>
    </Container>
  );
} 