// Define the interface for release notes
export interface UserReleaseNote {
  date: string;
  changes: string[];
}

// Store the release notes data
export const userReleaseNotes: UserReleaseNote[] = [
  {
    date: '2025-07-24',
    changes: [
      'Major UI changes:',
      '- Added Templates to the sidebar for easier access and task creation.',
      '- Supported Brand Guidelines: customers can now maintain their brand guidelines in the portal.',
      '- Task runs can leverage the guideline to maintain consistent branding for generated content.',
    ],
  },
  {
    date: '2025-07-14',
    changes: [
      'Added perform_video_analysis function call which uses Gemini 2.5 Pro to understand video content',
      '- Any web agents can use the function to understand video content by providing a video url',
      '- For youtube video, it will be analyzed directly',
      '- For other videos, it will be downloaded and then sent as attached file to Gemini'
    ],
  },
  {
    date: '2025-07-07',
    changes: [
      'Added image generation at task level',
      '- Our agent can now generate and edit images using OpenAI GPT Image during task execution',
      '- Supports generating new images from text prompts',
      '- Supports editing existing images with text prompts',
      '- Images are saved in PNG format with configurable size and quality settings'
    ],
  },
  {
    date: '2025-07-01',
    changes: [
      'Bug fix on filtering archived task executions',
      '- Fixed an issue where archived task executions were still being displayed in the Task Details page',
      '- Latest execution logic now correctly identifies the most recent non-archived execution'
    ],
  },
  {
    date: '2025-06-21',
    changes: [
      'Supported data analysis at task level',
      '- Our agent will execute code to perform analysis on data files when running a task in order to find insights',
      '- Supports various file formats including CSV, JSON, text files, and more',
      '- Uses Google Gemini with code execution capabilities for advanced data analysis',
      '- Lead list data will be included in data analysis if it is available',
      'Fixed bar chart issue with HTML reports when data range is large',
      '- Rerun to get better visualized HTML reports'
    ],
  },
  {
    date: '2025-06-12',
    changes: [
      'Enhanced Result Reports with Visualizations',
      '- Added support for tables, diagrams, and charts in result reports',
      '- Improved report display in Execution Result page',
    ],
  },
  {
    date: '2025-06-10',
    changes: [
      'Supported dynamic loading templates based on categories',
      '- More templates can be made available to customers',
      '- Improved template discovery and management'
    ],
  },
  {
    date: '2025-06-05',
    changes: [
      'Added Stripe payment integration for subscriptions',
      '- Users can now start a two-week free trial without booking a demo',
      '- Automatic payment starts after the free trial period',
      '- Customers can cancel during the free trial to avoid any charges'
    ],
  },
  {
    date: '2025-06-03',
    changes: [
      'Made Emma chat window collapsable',
      'Improved custom defined task defaults',
      '- Set default task type to complex task',
      '- Set default output format to HTML',
      '- Enabled shared browser mode by default'
    ],
  },
  {
    date: '2025-05-29',
    changes: [
      'Support file downloads in Execution Details page',
      '- Users can now download files generated during task execution',
      '- Files are securely stored and accessible through the Execution Details page',
      'Bug fixes',
      '- Fixed an issue with Discord integration'
    ],
  },
  {
    date: '2025-05-22',
    changes: [
      'Updated sign up page to look like login page and improved dropdown',
      '- Unified the design between login and sign up pages for better user experience',
      '- Enhanced dropdown functionality and appearance'
    ],
  },
  {
    date: '2025-05-21',
    changes: [
      'Support co-pilot mode and schedule for tasks.',
      '- With co-pilot, the agent will ask the user for necessary input when running a task.',
      '- The user can schedule to run a task daily, weekly, or monthly.',
    ],
  },
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