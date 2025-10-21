// Define the interface for release notes
export interface UserReleaseNote {
  date: string;
  changes: string[];
}

// Store the release notes data
export const userReleaseNotes: UserReleaseNote[] = [
  {
    date: '2025-10-21',
    changes: [
      'Fixed Interactive Sharing Task Results Display Issue',
      '- Resolved "Access denied" error when loading task execution results in interactive sharing mode',
      'Fixed Create Revision Task Display in Agent Mode',
      '- Create revision tool calls now properly display task execution status in the Agent Mode chat box',
      'Enhanced Meta Ads Metrics with Campaign-Specific Breakdown Filtering',
      '- Added optional campaign_name parameter to get_meta_ads_metrics function for filtering by specific campaigns',
      'Fixed Brand Guidelines Creation in Agent Mode',
      '- Agent Mode can now create brand guidelines using update_brand_guidelines when no existing guidelines are found',
      '- Previously returned an error requiring users to create guidelines first; now automatically creates initial structure',
    ],
  },
  {
    date: '2025-10-20',
    changes: [
      'Enhanced Free User Waitlist Management and Customer Portal Access',
      '- Free users can now be added to the waitlist and receive invitation emails to join the Customer Portal',
    ],
  },
  {
    date: '2025-10-19',
    changes: [
      'Enhanced Scheduled Chat Reliability with Increased Retry Attempts',
      '- Increased maximum retry attempts from 3 to 6 for scheduled chats to improve success rates',
    ],
  },
  {
    date: '2025-10-17',
    changes: [
      'Enhanced Email Engagement Events Data Structure in Agent Mode',
      '- Improved get_task_subscriber_engagement_events function to focus on key engagement events (delivered, opened, clicked)',
      '- Events are now grouped by user email for better timeline analysis and easier tracking of user engagement patterns',
      'Improved Chat Message Display with Newline Formatting in Agent Mode',
      '- User messages with newlines are automatically converted to HTML for proper display',
      'Optimized Email Metrics Performance',
      '- Removed unused timeline data from email metrics API to improve performance and reduce data transfer',
    ],
  },
  {
    date: '2025-10-16',
    changes: [
      'Renamed Meta Campaigns to Campaign Performance with Enhanced Email Campaign Monitoring',
      '- Meta Campaigns page renamed to Campaign Performance for broader campaign tracking',
      '- Added Email Campaigns section for monitoring email campaign performance',
      '- Added comprehensive backend API endpoints for email campaign task management',
    ],
  },
  {
    date: '2025-10-15',
    changes: [
      'Fixed Interactive Share Link Task Results Display',
      '- Resolved issue where interactive share links were not displaying task execution results properly',
      'Enhanced Email Metrics Display with Smart Open Tracking',
      '- Email metrics now intelligently hide opened count and open rate when open tracking is disabled',
    ],
  },
  {
    date: '2025-10-14',
    changes: [
      'Added Support for Sending Test Email and Group Recipients for Scheduled Chats',
      '- Users can send a test notification email for any Test History record by providing an email address',
      '- Scheduled chat notifications now send a single email addressed to all recipients instead of one-by-one',
      'Enhanced Founder Profile Management in Brand Guidelines',
      '- Individual edit buttons for each founder entry instead of global edit mode',
      '- Improved UX with Save/Cancel buttons for each founder entry',
      'Fixed Agent Mode Session Jumping Bug',
      '- Resolved issue where conversations would disappear after typing messages',
      'Added Azure OpenAI Content Filtering Error Handling',
      '- Graceful handling of content policy violations with user-friendly error messages',
      'Improved Email Events Data Loading',
      '- Fixed issue where email events data was not fully loaded when fetching large datasets',
    ],
  },
  {
    date: '2025-10-13',
    changes: [
      'Supported Shared Interactive Link in Agent Mode',
      '- Users can now create interactive share links for Agent Mode conversations that allow others to continue chatting without login',
      '- Interactive share links use secure tokens for access control and can be shared via email or direct links',
      '- Scheduled chat email notifications now automatically include interactive share links for seamless conversation continuation',
      '- Separate from view-only share links, interactive shares enable full conversation participation',
      'Supported loading email metrics in Agent Mode',
      '- Added get_task_subscriber_metrics function call to retrieve email performance metrics for specific tasks',
      '- Added get_task_subscriber_engagement_events function call to get detailed email engagement events by subject',
      '- Both function calls provide the same data as the UI Email Metrics and Subscriber Details popups',
      'Supported Email Notification list in Scheduled Chats',
      '- Users can now configure multiple email addresses for scheduled chat notifications',
    ],
  },
  {
    date: '2025-10-10',
    changes: [
      'Supported Scheduled Chats in Agent Mode',
      '- Users can now create scheduled chats that automatically run at specified intervals (hourly, daily, weekly, monthly)',
      '- Schedule configuration includes starting message, required function calls, and keywords for response validation',
      '- Automated email notifications with results, AI responses, and direct links to view conversations',
      '- Schedule management with pause/resume functionality and comprehensive test history tracking',
      'Supported account-level Slack channel configuration',
      '- Admins can now configure a specific Slack channel for each user in the Users tab of the admin page',
      '- When a user has an account-level Slack channel configured, only that channel is available for selection in approval requests',
      '- Users without a configured Slack channel can choose from all available channels as before',
      '- Provides better control over where approval notifications are sent for each user account',
    ],
  },
  {
    date: '2025-10-09',
    changes: [
      'Supported generate image and create blog article for Agent Mode',
      '- Agent Mode now supports real-time image generation using generate_image function call',
      '- Added create_blog_article function call for complete blog post creation with content, images, and HTML',
      '- Image generation supports multiple AI providers (OpenAI, Azure, Google) with automatic model selection',
      '- Blog articles include AI-generated content, hero images, and professionally formatted HTML files',
    ],
  },
  {
    date: '2025-10-07',
    changes: [
      'Added support for password reset at Login page',
      'Added Form Submission leads to Meta Campaigns page and Agent Mode',
      '- Meta Campaigns page now displays both Website Leads and Form Submissions with Results and Cost/Result columns',
      '- Agent Mode can now fetch and analyze form submission leads alongside website leads',
      '- Consistent lead prioritization logic: Website Leads take precedence over Form Submissions when both exist',
      '- Enhanced lead metrics summary with comprehensive breakdown across campaigns, ad sets, and individual ads',
    ],
  },
  {
    date: '2025-10-06',
    changes: [
      'Fixed common failures of generate_image',
      '- Removed LLM-provided image model from parameters so the LLM will not provide invalid model name',
      '- When an invalid quality is provided, it now falls back to the default instead of erroring',
    ],
  },
  {
    date: '2025-10-03',
    changes: [
      'Fixed message size bug in Agent Mode',
      '- Resolved DynamoDB session size limit errors that prevented conversation continuation',
      '- Optimized tool result storage to minimize data size and prevent session overflow',
      '- Added intelligent session management that preserves conversation history while staying within limits',
      'Added read_page_source function call',
      '- Agent can now read HTML page source from any URL using the read_page_source tool',
      'Supported Founder Profile in Brand Guidelines',
      '- Brand Guidelines now support adding and updating founder profiles (name, job title, style & tone, signature posts)',
      '- Agent Mode can read and update founder profiles; merging uses founder name as key',
    ],
  },
  {
    date: '2025-10-02',
    changes: [
      'Supported benchmark tests for Agent Mode',
      '- Admins can now create benchmark tests from Agent Mode conversations to evaluate Emma\'s performance',
      '- "Add to Benchmark" button appears in Agent Mode when admins access customer accounts via delegate access',
      '- Benchmark tests capture conversation history and allow setting expected keywords and function calls',
      '- Tests can be run individually or in bulk to measure pass/fail rates and execution times',
      '- Comprehensive test history tracking with detailed execution results and response analysis',
    ],
  },
  {
    date: '2025-10-01',
    changes: [
      'Made Changelog page publicly accessible',
      '- Users can now view the changelog without logging in at /changelog',
      '- Unauthenticated users see a clean interface with only changelog access',
      '- Authenticated users continue to see changelog in their normal navigation',
    ],
  },
  {
    date: '2025-09-30',
    changes: [
      'Added Authorization checkbox for creating meta ad',
    ],
  },
  {
    date: '2025-09-26',
    changes: [
      'Updated Subscribed Email Footer',
      'Added lead gen breakdown to Demographics, Placement and Device metrics in Agent Mode',
      'Added clear indicator when there is no task running for Agent Mode',
    ],
  },
  {
    date: '2025-09-25',
    changes: [
      'Fixed bug that screenshot files cannot be uploaded in Agent Mode',
      'Supported account-level Email Sender configuration',
      '- Users can now set up default email sender configuration at the account level in Admin Dashboard',
      '- Configure email domain, default sender username (e.g., noreply), and from name for all tasks',
      '- Task emails automatically use account-level configuration when no task-specific sender is set',
      '- Provides consistent branding, professional email appearance and tracking for all user communications',
    ],
  },
  {
    date: '2025-09-24',
    changes: [
      'Improved email friendly HTML',
      '- Ensured raw HTML is used when Send HTML Report Only is enabled',
      '- Fixed non-approval path to use email-friendly revised HTML for subscribers',
      '- Added guidance to ensure clean left/right edges, full width layout, and white background in emails',
      'Supported Format Instructions for HTML Report',
      '- Added clickable "Format Instructions" badge on Task Details page for easy access',
      '- Users can now add or edit custom HTML format instructions for consistent report styling',
      '- Format instructions are automatically applied during HTML report generation in agent-engine',
      '- Instructions can be used in Report Preview revision workflow for quick formatting updates',
      'Added read_file_content function call in Agent Mode',
      '- Agent can now read and extract content from file URLs including PDFs, text files, HTML, Markdown, CSV, and other common formats',
      '- Supports automatic file type detection and content extraction with proper error handling',
      'Added lead generation metrics for Agent Mode',
      '- Agent can now fetch and analyze website leads and cost per lead data from Meta Ads',
    ],
  },
  {
    date: '2025-09-23',
    changes: [
      'Supported fetching more meta metrics data in Agent Mode',
      '- Added demographics (age, gender), placement (publisher platform, position), and device breakdowns for Meta Ads insights',
      '- Enhanced metrics summary to include these breakdowns for better analysis',
      'Fixed bug of Revision request not sent',
      '- Fixed issue where "Send to Emma" action in Agent Mode was not properly sending revision requests to the backend',
    ],
  },
  {
    date: '2025-09-22',
    changes: [
      'Route error to agent for better error handling in Agent Mode',
      'Added inline task name editing in Customer Portal',
      '- Users can now edit task names directly on the Task Details page',
      'Updated Emma chat panel default behavior in Customer Portal',
      '- Emma chat window now starts collapsed by default for better user experience',
      '- Added configurable setting to control default chat panel state',
      'Supported performance insight tasks in Agent Mode',
      '- Agent can now fetch and analyze Meta ads performance data with 7d, 14d, 30d, and 90d timeframes',
      '- Added 14-day timeframe option to Meta Campaigns page for more granular analysis',
      '- Agent can create and save files using save_file function for sharing reports and insights',
    ],
  },
  {
    date: '2025-09-19',
    changes: [
      'Supported updating Market Strategy in Agent Mode',
      '- Agent can now read current market strategy including business overview, competitors, and ideal customer profiles (ICPs)',
      '- Agent can update market strategy through natural conversation, supporting business overview, competitor analysis, and ICP management',
      '- Smart merging preserves existing entries when updating competitors (by name) and ICPs (by title)',
    ],
  },
  {
    date: '2025-09-18',
    changes: [
      'Supported to read and update brand guidelines in Agent Mode',
      '- Agent can now read current brand guidelines including brand data (colors, fonts, messaging) and brand assets (logos, brand guides)',
      '- Agent can update brand guidelines through natural conversation, supporting both text-based brand data and visual brand assets',
      '- Also supported attachments in Agent Mode',
    ],
  },
  {
    date: '2025-09-17',
    changes: [
      'Supported web search in Agent Mode',
      '- Agent can now search the web for current information and real-time data',
      '- Proactive web search automatically gathers information before asking users for clarification',
      '- Multiple search iterations allow agent to refine research based on findings',
      '- Search results are synthesized into tailored responses rather than raw data dumps',
      'Supported Test Email',
      '- Added "📧 Test Email" button in Slack approval messages for HTML assets',
      'Supported Email Friendly HTML',
      '- New Email-Friendly option under Output as HTML5 in Partner Portal (Task Details)',
      '- Email HTML conversion inlines CSS and JavaScript charts for compatibility',
      'Supported customization of Welcome message and Starter items for Agent Mode',
      '- Admins can now customize Emma\'s welcome message with rich HTML formatting (bold, lists, links, etc.)',
      '- Conversation starter buttons can be customized to match specific business needs',
    ],
  },
  {
    date: '2025-09-16',
    changes: [
      'Added Open Rate and Click Through Rate to Email Metrics',
      '- Metrics are grouped by email subject in the Metrics popup',
      '- Definitions: Open Rate = Unique Opens / Delivered; Click-Through Rate = Unique Clicks / Delivered',
      '- Clicking an email opens the same Subscriber Details popup as in Task Details',
      'Added OpenAI image model from Azure',
      '- Integrated Azure OpenAI gpt-image-1 model for image generation and editing',
      '- Supports image generation from text prompts with configurable size and quality',
    ],
  },
  {
    date: '2025-09-15',
    changes: [
      'Improved Report Revision to Realtime',
      '- Report revisions now process instantly in the backend instead of waiting for agent-engine startup',
      '- Enhanced revision workflow with proper Slack approval integration when "Require Approval" is enabled',
      'Improved scalable email sending with delay, retry and more detailed engagement data',
      '- Implemented retry strategy with exponential backoff for 429 errors (3 attempts max)',
      '- Enhanced Email Metrics with detailed engagement tracking per date',
    ],
  },
  {
    date: '2025-09-14',
    changes: [
      'Supported Scalable Email Sending with Resend',
      '- Integrated Resend service for high-volume email delivery with custom sender domains',
      '- Added Email Domain configuration in Admin Portal for custom sender setup',
      '- Implemented custom email sender configuration in Task Details with format: <username>@<domain>',
      '- Added email events tracking and webhook integration for delivery analytics',
      '- Enhanced subscriber management with email metrics and timeline views',
      '- Improved email content with conditional "Manage task" links based on HTML Report Only mode',
    ],
  },
  {
    date: '2025-09-11',
    changes: [
      'Enable Customer Portal to config image model',
      '- Users can now select and configure image models directly from the Task Details page',
      '- Supports all available image models with clear descriptions and provider information',
      '- User-selected image models override the system default for personalized generation',
      'Added popup modal support for quick task configuration on Ad Images, Ad Videos, and Research Reports pages',
      '- Users can now view and modify task settings without leaving their current page',
    ],
  },
  {
    date: '2025-09-10',
    changes: [
      'Added Agent Mode',
      '- Emma AI assistant for automated marketing campaign execution through natural conversation',
      '- Complete marketing workflow support including SWOT analysis, strategy development, and creative generation',
      '- Task creation and execution with real-time status tracking and HTML result previews',
      '- Meta ads integration for creating and analyzing advertising campaigns',
      '- Image generation capabilities for marketing visuals and ad creatives',
      '- Admin-configurable system prompts with version tracking in chat history',
      '- ChatGPT-like interface with conversation history and quick start templates',
    ],
  },
  {
    date: '2025-09-05',
    changes: [
      'Added Batch Upload for Subscriber List',
      '- Users can now upload subscriber lists via CSV files on the Task Details page',
      '- CSV files support email column as the key with other columns treated as custom profile fields',
      '- Automatic deduplication of emails both within the CSV and against existing subscribers',
      '- Upload preview shows all valid rows before processing',
      '- Subscriber details popup displays custom profile fields with inline editing capabilities',
      '- Added subscriber email limit (configurable via SUBSCRIBER_EMAIL_LIMIT, default 1000)',
    ],
  },
  {
    date: '2025-09-04',
    changes: [
      'Support Create Meta Ad for Ad Images',
      '- Users can now create Meta ads directly from their generated images on the Ad Images page',
      '- Create Meta Ads icon appears on each image for easy access to ad creation',
      '- Ad creation popup allows users to select campaigns, ad sets, and Facebook pages',
      '- Supports all ad creative fields including ad name, text, headline, description, and call-to-action',
      '- Images are automatically uploaded to Meta and converted to compatible formats when needed',
      '- Created ads are stored in paused status for review and publishing in Facebook Business Manager',
      '- Ad history tracking shows recently created ads with direct links to Facebook Ads Manager',
      "- Also added Ads table in Meta Campaigns page for users to view all ads",
    ],
  },
  {
    date: '2025-09-02',
    changes: [
      'Automated asset revision based on feedback',
      '- When users provide feedback via Slack "Needs Changes" button, the system now automatically creates revision executions',
      '- Supports automated revision for image and HTML assets (video assets require manual review)',
      '- Revision executions are sent back to the same Slack channel where the original feedback was provided',
      '- Added "Reject" button option in Slack approval workflow for definitive asset rejection',
    ],
  },
  {
    date: '2025-08-28',
    changes: [
      'Supported image variation generation',
      '- Users can now request 1-5 variations when revising images',
      '- Image revision feature renamed to "Image Revision/Variation" for clarity',
      '- Added helpful tip about including other image URLs as references in revision prompts',
    ],
  },
  {
    date: '2025-08-27',
    changes: [
      'Fixed format issue of subscriber emails',
    ],
  },
  {
    date: '2025-08-24',
    changes: [
      'Added Gemini-2.5-Pro GA LLM',
      'Fixed bug about sending emails to subscribers when "Send HTML Report Only" is enabled',
    ],
  },
  {
    date: '2025-08-21',
    changes: [
      'Added Blog Post Publishing feature',
      '- Users can now convert research reports into blog posts and publish them directly to BaseHub',
      '- AI-powered blog content generation with customizable tone, length, and keywords',
      '- Automatic hero image generation using GPT Image models',
      '- Blog post history tracking to help avoid duplicate content creation',
      'Improved Task Subscribers management',
      '- Added "Send HTML Report Only" toggle for cleaner email delivery',
      '- Supported unsubscribing from task updates',
      '- Optional feedback collection when users unsubscribe',
      '- Enhanced subscriber list display showing unsubscribed users and their feedback',
    ],
  },
  {
    date: '2025-08-19',
    changes: [
      'Fixed percentage issue with Meta Campaigns',
      '- CTR values now display correctly as percentages without incorrect multiplication',
      'Made admin page tabs easier to access',
      '- Added URL-based tab routing for direct access to specific admin sections',
      '- Users can now bookmark direct links like /admin?tab=users or /admin?tab=tasks',
      '- Improved admin page performance by only loading data for the active tab',
      '- Compact Actions column in Users table with icon-based buttons and tooltips',
    ],
  },
  {
    date: '2025-08-15',
    changes: [
      'Added Require Approval control for task execution',
      '- Users can now enable "Require Approval" toggle on tasks to send results to Slack for review',
      '- When enabled, users select a Slack channel for approval requests',
      '- Task results are sent to Slack instead of directly to subscribers',
      '- Once approved via Slack, results are automatically sent to all task subscribers',
      'Added Meta Campaigns page under Brand category',
      '- Users can now view Meta ad performance data including campaigns and ad sets',
      '- Timeframe selection (7 days, 30 days, 90 days) for performance analysis',
      '- Admin-configurable Meta Ad Account IDs via partner portal admin page',
    ],
  },
  {
    date: '2025-08-13',
    changes: [
      'Added Create Variation with Placid feature',
      '- Users can now create variations of images using the same Placid template and configuration',
      '- Create Variation icon (refresh icon) appears next to Archive icon for images created with Placid',
      '- Clicking create variation opens the Placid editor with all previous settings pre-populated',
      '- Users can modify the configuration to create variations or recreate the exact same image',
    ],
  },
  {
    date: '2025-08-12',
    changes: [
      'Added comprehensive layer field controls for Placid image editing',
      '- Complete control over layer properties including opacity, rotation, positioning, sizing, and visibility',
      '- Folded interface design with content inputs always visible and advanced controls expandable on demand',
      '- Real-time preview updates for all layer property changes',
      'Provide direct links to partner portal for task and execution management',
      '- Admin users with delegate access can now see manage icons on task details and execution records',
      '- Settings icons provide direct links to partner portal for task and execution management',
    ],
  },
  {
    date: '2025-08-11',
    changes: [
      'Added live preview with Placid templates',
      '- Real-time preview of template customization as you type',
      '- Instant updates when changing text, images, or logos',
    ],
  },
  {
    date: '2025-08-09',
    changes: [
      'Added image editing feature with Placid integration',
      '- Edit button added to image preview windows on Ad Images page',
      '- Template-based image generation with live preview',
      '- Automatic logo selection from brand guidelines',
    ],
  },
  {
    date: '2025-08-08',
    changes: [
      'Display preferred LLM and LLM for the task and executions',
      '- Task details now show the preferred LLM model in the task header',
      '- Execution history displays the LLM model used for each execution',
    ],
  },
  {
    date: '2025-08-07',
    changes: [
      'Added Kling models for video generation',
      '- Users can now generate videos using ReelMind\'s Kling models',
      '- Kling V2.1 Std for image-to-video generation',
      '- Kling V1.6 Std for text-to-video generation',
      '- 5-second videos with 16:9 aspect ratio',
      '- Available in the video model selector alongside VEO 3 and Runway models',
    ],
  },
  {
    date: '2025-08-06',
    changes: [
      'Added Research Reports page under Brand category',
      '- Users can now view all HTML research reports generated by their tasks in a dedicated page',
      '- Reports are grouped by task and show execution details with filtering and sorting options',
      '- Users can favorite, download, archive, and send reports for Slack approval',
      '- "Generate More" button allows users to re-run tasks with specific feedback or upload custom reports',
      '- Create Research Reports functionality with brand guidelines and market strategy integration',
      '- Reports support revision workflow with "Submit Revision" in preview window',
    ],
  },
  {
    date: '2025-08-05',
    changes: [
      'Added review approval flow for image and video assets',
      '- Users can now send images and videos for approval via Slack channels',
      '- Approval button added to each asset with dynamic status indicators (pending, approved, needs changes, revision submitted)',
      '- Detailed tooltips show approval status, reviewer, timestamps, feedback, and channel information',
      '- "Needs changes" workflow allows users to select alternative assets from the same task for revision',
    ],
  },
  {
    date: '2025-08-04',
    changes: [
      'Fixed issue with Ad Images not seeing images for new owner after changing ownership',
      '- When task ownership is transferred to a new user, all associated execution images are now properly transferred',
      '- New task owners can immediately see all images from previous executions in their Ad Images page',
      'Added support for Delegate access for admin to customer portal',
      '- Admins can now access any customer\'s portal view by clicking "Access Customer Portal" button',
      '- Delegate access creates secure 2-hour tokens that allow admins to view the portal as the user',
      '- Clear visual indication shows when admin is viewing in delegate mode',
      '- Added Support Note column with inline editing for admins to track user information',
      '- Added Last Login Time column to track when users last accessed the platform',
    ],
  },
  {
    date: '2025-08-03',
    changes: [
      'Added Ad Videos page under Creatives category',
      '- Users can now view all videos generated by their tasks in a dedicated page',
      '- Supports filtering by task name/ID and sorting by latest execution, name, or creation date',
      '- Users can favorite, download, and archive videos',
      '- "Generate More" button allows users to re-run tasks with specific feedback',
      '- Upload directly feature for adding custom videos to task executions',
      '- Create Ad Video functionality with brand guidelines and market strategy integration',
    ],
  },
  {
    date: '2025-07-31',
    changes: [
      'Supported image preview and revision',
      '- Users can now click on any image in the Ad Images page to open a preview popup',
      '- Preview popup displays the full image with download functionality',
      '- Image Revision prompt allows users to describe how they want to modify the image',
      '- Revision requests create new task executions with the original image as context',
      '- Enables iterative improvement of generated images based on user feedback',
    ],
  },
  {
    date: '2025-07-30',
    changes: [
      'Reduced noisy images in Ad Images by moving download_image to attachment folder',
      '- Reference images downloaded via download_image are now saved in the task-specific attachments folder',
      '- This improves organization and reduces clutter in the downloads folder',
      'Supported archive images in Ad Images',
      '- Users can now archive images they no longer want to see in the Ad Images page',
      '- Archive icon appears next to each image for easy access',
      '- Confirmation dialog warns users that archived images require support contact to restore',
      'Added Upload directly button to Ad Images page',
      '- Users can now upload ad images directly to S3 and add them to the latest execution',
      '- Uploaded images appear alongside generated images in the task execution results',
      'Improved auto-refresh performance for Ad Images page',
      '- Page no longer refreshes entire data every 5 seconds when tasks are in progress',
      '- Individual execution results are updated efficiently during task execution',
      '- Full page refresh only occurs when tasks start or complete for optimal performance',
      'Improved image prompt to emphasize following brand guidelines',
      '- When brand guidelines are selected, AI is now explicitly instructed to use brand data',
      '- Instructions include using logo, typography, brand colors, and other brand elements',
      '- Ensures generated images maintain consistency with brand identity',
    ],
  },
  {
    date: '2025-07-29',
    changes: [
      'Added Market Strategy page to Customer Portal under Brand category',
      '- Users can now manage their business overview, competitors, and ideal customer profiles (ICP)',
      '- Competitors: Add, edit, and delete competitor information with name and description',
      '- ICP (Ideal Customer Profile): Define customer profiles with title, description, and value proposition',
      'Added Images page to Customer Portal under Creatives category',
      '- Users can now view all images generated by their tasks in a dedicated page',
      '- Images are grouped by task and show execution details',
      '- Supports filtering by task name/ID and sorting by latest execution, name, or creation date',
      '- Users can favorite images and provide feedback for better generation results',
      '- "Generate More" button allows users to re-run tasks with specific feedback',
      'Added Create Ad Image button to Images page',
      '- Users can now create ad image generation tasks directly from the Images page',
      '- Configurable options include Brand Guidelines, Market Strategy (Business Overview, ICP selection)',
      '- Required fields: Task Name and Image Prompt for describing desired images',
      '- Supports reference image URLs and custom styling instructions',
      '- Creates targeted tasks based on selected ICPs or general audience',
    ],
  },
  {
    date: '2025-07-28',
    changes: [
      'Added attachment support on Task Details page',
      '- Users can now upload up to 5 files as attachments to their tasks',
      '- Maximum file size is 5MB per file',
      '- Files are securely stored and accessible during task execution'
    ],
  },
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