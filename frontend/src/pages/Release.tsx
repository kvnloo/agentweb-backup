import { Container, Typography, Paper, Box, Divider } from '@mui/material';

interface Release {
  version: string;
  date: string;
  changes: string[];
}

const releases: Release[] = [
  {
    version: "0.8",
    date: "2025-02-13",
    changes: [
      "Added execution log display for better task debugging visibility",
      "Enhanced user experience with detailed execution logs",
      "Improved error tracking and troubleshooting capabilities"
    ]
  },
  {
    version: "0.7",
    date: "2025-02-12",
    changes: [
      "Added support for file attachments in tasks",
      "Implemented file download functionality for task results",
      "Enhanced task interface to manage attachments and downloads"
    ]
  },
  {
    version: "0.6",
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
    version: "0.5",
    date: "2025-02-02",
    changes: [
      "Implemented parallel task execution",
      "Improved task scheduling and management",
      "Enhanced system performance for concurrent tasks"
    ]
  },
  {
    version: "0.4",
    date: "2025-01-31",
    changes: [
      "Added support for editable task prompts",
      "Implemented per-user cookie file system",
      "Enhanced user isolation and security",
      "Improved user experience with customizable tasks"
    ]
  },
  {
    version: "0.3",
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
    version: "0.2",
    date: "2025-01-29",
    changes: [
      "Implemented task subscription system via email",
      "Added email notifications for task results",
      "Support for non-registered users to receive task updates",
      "Enhanced collaboration features for team usage"
    ]
  },
  {
    version: "0.1",
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
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', mb: 2 }}>
              <Typography variant="h5" component="h2">
                Version {release.version}
              </Typography>
              <Typography variant="subtitle1" color="text.secondary">
                {release.date}
              </Typography>
            </Box>
            
            <Divider sx={{ mb: 2 }} />
            
            <Box component="ul" sx={{ m: 0, pl: 3 }}>
              {release.changes.map((change, changeIndex) => (
                <Typography 
                  key={changeIndex} 
                  component="li" 
                  variant="body1" 
                  sx={{ mb: 1 }}
                >
                  {change}
                </Typography>
              ))}
            </Box>
          </Paper>
        ))}
      </Box>
    </Container>
  );
} 