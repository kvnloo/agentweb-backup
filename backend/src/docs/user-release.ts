// Define the interface for release notes
export interface UserReleaseNote {
  date: string;
  changes: string[];
}

// Store the release notes data
export const userReleaseNotes: UserReleaseNote[] = [
  {
    date: '2025-05-16',
    changes: [
      'Improved Dashboard UI',
      '- Made "Use Template" window scrollable for long content',
      '- Enhanced visibility of the "Use Template" button on template cards'
    ],
  },
  {
    date: '2025-05-14',
    changes: [
      'Improved customer login/register',
      '- Get customer login/register work with waitlist',
      '- Improved error message when login/register fails',
      'Supported Use Shared Browser for tasks',
      '- When enabled, the agent will use shared browser sessions to execute tasks',
      '- It allows access to more account-protected data in a secure way.',
      '- Also available through template configuration'
    ],
  },
  {
    date: '2025-05-12',
    changes: [
      'Template Enhancements with LLM selection',
      '- Aadmin can select a list of LLMs to use when defining a template','- Tasks created using this template would use the selected LLMs to run',
      '- Best for tasks with better-performing LLMs'
    ],
  },
  {
    date: '2025-05-09',
    changes: [
      'Improvements and bug fixes',
      '- Supported Complex Tasks',
      '- Support displaying HTML formatted result',
      '- Bugs on Task Details page',
    ],
  },
  {
    date: '2025-05-08',
    changes: [
      'First version of Customer Portal is deployed (Public Beta)',
      '- Supports templates',
      '- Supports dashboard',
      '- Supports tasks'
    ],
  },
]; 