import { Request, Response } from "express";

interface Release {
  date: string;
  changes: string[];
}

// Release data moved from frontend
const releases: Release[] = [
  {
    date: "2026-07-21",
    changes: [
      "Org-Aware LLM Cost Breakdown (Admin)",
      "- Fixed: the per-user \"LLM Cost Burn\" modal compared a user's gross burn against their own quota counter — but org member spend is deducted onto the org owner, so members showed burn with \"$0 counted\" (a false \"spend escaping the cap\" alarm) and owners showed a counter far above their own burn",
      "- The modal now rolls gross burn across all org members and reconciles it against the owner's quota counter (the real cap), with a per-member burn table so per-user detail is preserved and the selected user is highlighted",
      "- Members now read \"charged to org owner (<email>)\" instead of a false $0; the old red \"absorbed by platform / investigate\" card is replaced by a neutral coverage metric, and a counter-ahead-of-tracking case is shown as an informational note",
      "- The cost-cap bar now reads the org owner's tier cap; no customer-facing behavior changes (cost accounting remains observe-only)",
    ],
  },
  {
    date: "2026-07-06",
    changes: [
      "Publish Guardrail for Skills Not Entitled to Any Tier",
      "- When you publish a skill that is not in any subscription tier's allowed-skills list, Skill Management now shows a warning — a published-but-unentitled skill is invisible to all non-wildcard users and its tools are undiscoverable to Emma",
      "- The warning is advisory only: publishing still succeeds, and it points you to Admin → Subscriptions to add the skill to the relevant tiers",
      "- This closes a silent gap where a newly published skill (for example, Google Drive Management) could reach nobody until it was manually added to the tier allow-lists",
    ],
  },
  {
    date: "2026-06-22",
    changes: [
      "Gemini 3.1 Flash Image Model Migrated to GA Endpoint",
      "- The Gemini 3.1 Flash image model now targets Google's generally available \"gemini-3.1-flash-image\" endpoint instead of the deprecated \"gemini-3.1-flash-image-preview\" preview endpoint (same cost, quality, and behavior)",
      "- The Admin default-image-model selector now offers \"gemini-3.1-flash-image\"; the legacy preview id is still accepted as an alias, so any previously-saved default keeps working without reconfiguration",
      "- No Imagen 4 (imagen-4.0-*) endpoints were used by Agent Mode; the only Imagen reference (a Python example notebook) was ported to the Gemini image API ahead of Google's August 17, 2026 Imagen 4 discontinuation",
    ],
  },
  {
    date: "2026-06-12",
    changes: [
      "Stronger Password Minimum (12 Characters)",
      "- The minimum password length is now 12 characters across the platform — enforced on signup, password reset, the customer change-password form, and the admin \"Set Password\" dialog",
      "- The admin Set Password dialog now validates length client-side and the helper text reflects the new 12-character minimum",
      "- Existing passwords are unaffected; the new minimum applies only when a password is created or changed",
    ],
  },
  {
    date: "2026-06-10",
    changes: [
      "Authoritative Stripe Status Reconcile (Admin)",
      "- Fixed: accounts could get stuck showing \"overdue\"/past_due even when their Stripe subscription was active — a stale local status that a missed payment-recovery webhook never cleared",
      "- The per-user \"Sync Stripe\" button now authoritatively reconciles status against Stripe (Stripe wins), so it overwrites a stuck status instead of only filling blank fields",
      "- \"Resync Payments\" now reconciles subscription status, payment method, tier, period end, and offer for every user in addition to the amount, and reports a new \"statuses reconciled\" count in the result toast",
      "- The \"canceling\" pseudo-status set by cancel-at-period-end is preserved and never flipped back to active",
    ],
  },
  {
    date: "2026-05-22",
    changes: [
      "Self-Service Analytics & SEO Configuration",
      "- Customers can configure their own SEO domains, Google Analytics 4 properties, and Microsoft Clarity projects via Settings → Analytics & SEO in the customer portal",
      "- A GA4 \"Test connection\" button reports immediately whether the shared analytics service account has access to a property",
      "- Org admins can share analytics org-wide and appoint analytics editors from Settings → Organization Sharing; org analytics config now lives on the Organization record",
      "- Partner Portal: the Configure SEO/AEO dialog now loads the resolved, org-aware config — fixing empty GA4/Clarity lists",
      "- Fixed: shared-funnel metrics, the User Journey Funnel section, and the SEO dashboard now resolve org-shared analytics correctly for members",
      "- New backend endpoints: GET /api/seo/config and PUT /api/seo/config/{ga,seo-domains,clarity}",
    ],
  },
  {
    date: "2026-05-19",
    changes: [
      "Org-wide Sharing Controls (Customer Portal)",
      "- Org admins can now configure which feature areas are shared across their organization via Settings → Org Sharing in the customer portal",
      "- Toggleable sharing for five areas: Knowledge Bases, HTML Templates, Landing Pages, Work Plans, and Skills",
      "- Brand Guidelines and Marketing Strategy remain always org-shared; admins can now designate per-feature editors from their member list",
      "- New backend endpoints: GET/PATCH /api/orgs/me/share-settings (admin-only)",
    ],
  },
  {
    date: "2026-03-09",
    changes: [
      "Notion Attachments in Dev Environments",
      "- Screenshots, files, PDFs, and videos attached to Notion sprint items are now downloaded to the EC2 instance when a dev environment launches",
      "- Claude Code prompt includes paths to downloaded attachments so it can view and reference them",
      "- Supports both Notion-hosted and externally-linked files",
      "Dev/Prod Status Isolation for Notion Webhooks",
      "- Dev and test environments now use Start_Test/Done_Test status values to trigger launches and teardowns",
      "- Production continues to use Start/Done, preventing test activity from accidentally triggering production environments",
    ],
  },
  {
    date: "2026-03-03",
    changes: [
      "Cloud Dev Environment",
      "- Launch cloud dev environments from Notion by setting a sprint item status to \"Start\"",
      "- EC2 instance auto-provisions with hot-reload dev servers and Claude Code",
      "- Claude Code auto-runs \"prep branch\" using the Notion item title and description",
      "- SSH in and run claude then /resume to continue development",
      "- Set status to \"Done\" in Notion to tear down the environment",
    ],
  },
  {
    date: "2026-02-23",
    changes: [
      "Repository Security",
      "- Enabled branch protection on main for both agentweb and customer-portal repos",
      "- Direct pushes to main are now blocked; all changes require a pull request",
      "- Force pushes and branch deletion are blocked, including for admins",
    ],
  },
  {
    date: "2026-02-18",
    changes: [
      "Simplified CI/CD Deployment",
      "- Build artifacts and EB version labels now use date-based naming: <component>-yyyymmdd-pr<number> (e.g., backend-20260218-pr42)",
      "- Production deployments are triggered by file changes instead of requiring manual version bumps",
      "- Staging deployments use the same naming convention for consistency",
      "- Removed semver version checks from PR and deploy workflows",
      "Added Pending @agentweb.pro and Unassigned Work Items on GTM Tracker User Cards",
      "- Each client card now shows how many pending work items are assigned to @agentweb.pro team members, with a per-email breakdown",
      "- Cards also display a count of unassigned pending items (no DRI) with a warning indicator",
      "- Sections only appear when relevant, keeping cards clean for clients without pending team or unassigned items",
    ],
  },
  {
    date: "2026-01-29",
    changes: [
      "Added Model Context Protocol (MCP) Support for Dynamic Agent Tool Management",
      "- MCP Server exposes agent tools as MCP-compatible endpoints with SSE (Server-Sent Events) transport support",
      "- External clients can now discover and invoke agent capabilities through standardized MCP protocol",
      "- Supports dynamic refresh when MCP server configurations change for hot-reloading capabilities",
      "Added MCP Servers Management UI in Partner Portal",
      "- New MCP Servers Tab in Admin section for adding, editing, and deleting MCP server configurations",
      "- Discover and test tools from connected MCP servers before deployment",
      "- Configure SSE transport settings and access token authentication",
      "- REST API endpoints for CRUD operations on MCP server configurations",
      "Enhanced Security for MCP Integration",
      "- Access token encryption for MCP server configurations stored in database",
      "- Token-based authentication (MCP_ACCESS_TOKEN) for securing MCP server endpoints",
    ],
  },
  {
    date: "2026-01-14",
    changes: [
      "Added showInAgentMode configuration for predefined work plans",
      "- Admins can now control which predefined work plans are displayed on the agent-mode/new page in the customer portal",
    ],
  },
  {
    date: "2026-01-13",
    changes: [
      "Added column sorting to the Admin Users table and Waitlist table",
      "- Default sort is Created (descending) for Users table",
      "- Default sort is Joined At (descending) for Waitlist table",
      "- All user columns are sortable for quick triage",
      "- All waitlist columns are sortable for quick triage",
    ],
  },
  {
    date: "2026-01-12",
    changes: [
      "Added GTM Plans page to Partner Portal",
      "- New admin-protected GTM Plans page accessible from the navigation menu",
      "- Displays all GTM Plans from all users in a unified view",
      "- Admins can update status, edit notes, assign PoC, and set due dates for plans, phases, and work items",
      "- Supports role-based notifications with customizable recipient selection",
      "- Includes due date management with visual indicators and constraint warnings",
    ],
  },
  {
    date: "2026-01-09",
    changes: [
      "Enhanced Admin Announcement feature",
      "- Added Test button to send test emails to a list of recipients before sending to all users",
      "- Added ability to load announcement content from HTML URL",
    ],
  },
  {
    date: "2026-01-08",
    changes: [
      "Improved Agent Mode work plan management in admin panel",
      "- Work plans can now be saved individually instead of saving all plans at once",
      "- This prevents conflicts when multiple admins edit different work plans simultaneously",
      "Enhanced delegate access to support multiple users in the same browser",
      "- Admins can now open multiple customer portal sessions in different tabs simultaneously",
      "- Each delegate access session is isolated using tab-specific storage (sessionStorage)",
      "- Delegate tokens are stored separately per user email to prevent session conflicts",
      "- Fixed Brand Guidelines, SEO, Settings, and LinkedIn OAuth pages to work with delegate access",
      "- All pages now use AuthContext token instead of reading directly from localStorage",
    ],
  },
  {
    date: "2026-01-04",
    changes: [
      "Improved Admin Users and Overview analytics",
      "- Users tab now shows Chat Sessions count per user",
      "- Fixed the bug in Message Analytics to count messages",
      "- admin page defaults to Users tab with admin?tab=users, and Overview remains at admin?tab=overview",
    ],
  },
  {
    date: "2025-12-21",
    changes: [
      "Improved Admin Chat History performance",
      "- Chat sessions now load the most recent 30 records first with infinite scroll for older entries",
    ],
  },
  {
    date: "2025-12-08",
    changes: [
      "Supported Deployment to Staging for Backend",
      "- Backend changes in Pull Requests now automatically deploy to staging after tests pass",
      "- Staging environment available at https://api-stage.agentweb.pro for testing",
      "- Frontend applications (Partner Portal and Customer Portal) can run locally pointing to staging backend",
      "- Enables developers to test backend changes in staging before merging to production",
    ],
  },
  {
    date: "2025-11-15",
    changes: [
      "Enhanced Admin Dashboard Chat History",
      "- Chat sessions are now categorized by type: Regular, Predefined Work Plan, Scheduled, and Image Generation",
      "- Added \"Shared Chat\" buttons to quickly access shared sessions directly from the admin dashboard",
      "- View-only and interactive share links are now easily accessible for sessions with sharing enabled",
    ],
  },
  {
    date: "2025-10-13",
    changes: [
      "Added search_web function call to browser agent",
      "- search_web is an alternative to search_google as Google Search sometimes are blocked by reCAPTCHA",
    ],
  },
  {
    date: "2025-10-07",
    changes: [
      "Added Create User in Waitlist tab of Admin Page",
      "- Admins can now create user accounts directly from waitlist entries",
      "- Generate random secure passwords and send welcome emails to new users",
      "- Transfer waitlist data (company name, use cases, etc.) to new user accounts",
      "- Support role assignment (customer, partner, free) during user creation",
      "- Icon-only Create User button appears only for unregistered waitlist entries",
    ],
  },
  {
    date: "2025-09-25",
    changes: [
      "Added visualizations and fixed bugs in metrics data for admin page",
      "- Added comprehensive chart visualizations to admin Overview tab including user growth, task growth, and execution trends",
      "- Fixed critical date comparison logic in analytics functions that was causing inaccurate metrics",
      "- Implemented DynamoDB pagination to handle large datasets properly",
      "- Added proper error handling and logging for better debugging",
      "- Enhanced admin dashboard with interactive charts using Chart.js",
      "Supported configuring report revision system prompt in Default Prompts tab of Admin page",
      "- Added new Default Prompts tab to admin dashboard for managing AI system instructions",
      "- Fixed knowledge base metrics data issue",
    ],
  },
  {
    date: "2025-09-20",
    changes: [
      "Supported Repair Image Embedding for HTML reports",
      "- Added Repair Image Embedding option to Task Details page alongside Email Friendly HTML",
      "- Automatically detects and fixes broken image links in HTML reports",
      "- Replaces relative image paths with full file paths from available assets",
      "- Ensures all available image files are properly referenced in HTML output",
    ],
  },
  {
    date: "2025-09-02",
    changes: [
      "Fixed issue with header color issue with subscriber emails",
      "- Removed unnecessary styling from email templates to prevent white text visibility issues",
      "- Headers and footers in subscriber emails are now properly visible",
      "- Applied fixes to both agent-engine and backend email services",
    ],
  },
  {
    date: "2025-08-28",
    changes: [
      "Added new image model Nano Banana from Google Gemini",
      "- Users can now select gemini-2.5-flash-image-preview as an alternative to OpenAI and FLUX models",
      "- Nano Banana provides advanced image generation and editing capabilities through Google's Gemini API",
      "- Model selection is available on the Task Details page with a dropdown menu",
      "- Selected model is automatically saved and used for image generation tasks",
    ],
  },
  {
    date: "2025-08-27",
    changes: [
      "Improved Growth Genius chat service",
      "- Added chat interface with ChatGPT-like sidebar and dedicated chat pages",
      "- Improved system prompt to make sure the chatbot is less salesy",
      "- Added startup profile management system for personalized context",
      "- Home page will direct the user to chat page when the user sends a message",
    ],
  },
  {
    date: "2025-08-26",
    changes: [
      "Created Growth Genius chat service",
      "- New AI-powered startup growth assistant chatbot",
      "- Dedicated frontend application with modern UI/UX",
      "- Integration with existing AgentWeb authentication system",
      "- Knowledge base search capabilities via Azure OpenAI function calling",
      "- Chat session management with persistent history",
    ],
  },
  {
    date: "2025-08-20",
    changes: [
      "Added Flux model for image generation",
      "- Users can now select FLUX.1-Kontext-pro (Azure) as an alternative to openai-image-1 (OpenAI)",
      "- FLUX model provides advanced image generation and editing capabilities",
      "- Model selection is available on the Task Details page with a dropdown menu",
      "- Selected model is automatically saved and used for image generation tasks",
    ],
  },
  {
    date: "2025-08-12",
    changes: [
      "Added OpenAI GPT-5 mode via Azure",
      "- Users can now access GPT-5 through Azure integration for enhanced AI capabilities",
      "- This model replaces the openai->openai->gpt-5 model for better performance and cost efficiency",
    ],
  },
  {
    date: "2025-08-07",
    changes: [
      "Added support for GPT-5",
      "- GPT-5 is now available as an advanced reasoning model",
      "- Users can access GPT-5 by selecting openai->openai->gpt-5 model in preferred models",
      "- GPT-5 provides the most advanced AI capabilities for strategic thinking and deep analysis",
    ],
  },
  {
    date: "2025-08-01",
    changes: [
      "Added video model selection on Task Details page",
      "- Users can now choose between VEO 3 from Google or Runway model",
      "- Selected model is displayed as a chip next to the Create Video toggle",
    ],
  },
  {
    date: "2025-07-31",
    changes: [
      "Added Create Video toggle to Task Details",
      "- Users can now enable video generation capabilities for tasks",
      "- Supports both text-to-video and image-to-video generation using Google VEO API",
      "- Generated videos are 8-second MP4 files in 16:9 aspect ratio",
      "- Includes support for negative prompts to avoid unwanted elements",
      "- Videos are automatically saved to downloads folder and can be referenced in task results",
    ],
  },
  {
    date: "2025-07-28",
    changes: [
      "Added support for two new Gemini models: Gemini 2.5 Flash and Gemini 2.5 Flash Lite",
      "- These models are cheaper and faster compared to Gemini 2.5 Pro",
      "- Available for regular tasks with improved cost efficiency",
      "Removed older Gemini models: Gemini 2.0 Flash and Gemini 2.5 Pro Preview 03-25",
      "- These models are no longer useful and have been replaced by newer, more efficient alternatives",
    ],
  },
  {
    date: "2025-07-24",
    changes: [
      "Enhanced Admin page to support showing tasks of a given user:",
      "- Admins can now click on a user's task count in the Users tab to view all tasks for that user in a popup dialog.",
      "- The task list includes Task ID, Name, truncated Prompt, and a 'View Details' link for each task (opens in a new tab).",
    ],
  },
  {
    date: "2025-07-18",
    changes: [
      "Lifted file size limit from 1MB to 5MB for task attachments",
      "- Users can now upload larger files (up to 5MB) as task attachments",
      "- Improved file upload experience for documents, images, and other larger files",
    ],
  },
  {
    date: "2025-06-18",
    changes: [
      "Temporarily removed the 'Perform Deep Research' toggle from the Create Task and Task Details pages to prevent accidental use.",
    ],
  },
  {
    date: "2025-06-17",
    changes: [
      "Enhanced Admin Dashboard with Waitlist Analytics",
      "- Added marketing channels tracking in waitlist management",
      "- Implemented visualization of user acquisition sources",
      "- Added ability to filter and analyze waitlist entries by marketing channel",
      "- Enhanced admin insights for better marketing strategy optimization",
    ],
  },
  {
    date: "2025-06-16",
    changes: [
      "Added support for scalable lead generation list at task level",
      "- Enable Update Lead List option to allow agents to add records to the lead list",
      "- Users can manually maintain the list by editing it",
      "- Each record requires a unique identifier field for tracking",
      "- Records are automatically merged when duplicates are found",
    ],
  },
  {
    date: "2025-06-11",
    changes: [
      "Enhanced Knowledge Base features",
      "- Added support for private knowledge base",
      "- Added Knowledge Base tab to admin page for metrics and management",
      "- Enhanced Task Details page with knowledge base creation and management",
      "- Added automatic knowledge base updates from execution records",
      "- Added support for private knowledge base access to both web agents and Emma chatbot",
    ],
  },
  {
    date: "2025-06-06",
    changes: [
      "Added support for task rerun in Workflows",
      "- Users can now rerun individual tasks with modified prompts after an execution",
      "- Avoids the need to run a complete workflow which could take much longer time and consume more tokens",
      "- Added ability to kill a task when rerunning it",
      "Enhanced Admin capabilities with workflow management",
      "- Added Workflows tab in Admin page for viewing and managing user workflows",
      "- Admins can help users debug by running workflows and rerun tasks on their behalf",
    ],
  },
  {
    date: "2025-06-04",
    changes: [
      "Improved the workflow feature",
      "- Added a Workflow Execution Details page for better visibility",
      "- Enhanced Workflow to support referencing existing tasks of the user",
      "Tasks page shows knowledge size for better knowledge base management",
      "Enhanced admin functions for better customer support",
      "- Added ability for admins to archive and kill task executions",
    ],
  },
  {
    date: "2025-05-30",
    changes: [
      "Added support for Knowledge Base",
      "- Based on Google Vertex AI Search for powerful search capability",
      "- Automatically update knowledge base from good execution records",
      "- Manual knowledge base updates available on Task Details page",
      "- Enable 'Use Knowledge Base' option when running tasks",
      "- Agents can search platform-wide knowledge base during web navigation",
      "- Chatbots now have access to platform-wide knowledge base for more comprehensive support",
    ],
  },
  {
    date: "2025-05-23",
    changes: [
      "Support Turn Off Headless toggle",
      "- Added new toggle in Task Details page of Partner Portal and Templates",
      "- When creating a new task based on a template, this setting will be enabled based on template",
      "- Useful for tasks which visit sites that require headless to be off such as x.com, circle.so",
    ],
  },
  {
    date: "2025-05-22",
    changes: [
      "Added Kill button to Execution Details page",
      "- Users can now terminate a running task execution if not satisfied with its progress",
      "- Provides better control over task execution and resource management",
      "- Helps prevent unnecessary resource usage from unwanted executions",
      "Improved task ownership change notifications",
      "- Fixed a bug",
      "- Single email sent to new owner with old owner and admin CC'd",
      "- Updated email links to point to customer portal instead of partner portal",
    ],
  },
  {
    date: "2025-05-19",
    changes: [
      "Added new models for task runs",
      "- OpenAI GPT-4.1 from Azure",
      "- Google Gemini Pro 2.5 Preview 05-06",
      "Fixed bugs",
    ],
  },
  {
    date: "2025-05-15",
    changes: [
      "Enhanced email notifications",
      "- Updated email notifications to display HTML file content directly in the email",
      "- Added email feature in Execution Details of Partner Portal",
      "- Makes it easier to share task results with clients or team members",
      "- Useful for sending leads detailed results of task runs to help convert them",
    ],
  },
  {
    date: "2025-05-02",
    changes: [
      "Added Agentic Dev Mode to Task Details page",
      "- Enables agents to access current page content",
      "- Allows running JavaScript on the current page",
      "- Enhances developer capabilities for advanced web automation tasks",
    ],
  },
  {
    date: "2025-05-01",
    changes: [
      "Implemented near real-time task execution monitoring",
      "- Execution log updates every 10 seconds on Execution Details page",
      "- Provides near real-time visibility into task progress",
      "- Enhances user experience with live execution updates",
      "Updated Gemini 2.5 Pro model from experimental to preview status",
      "- Resolves rate limit issues with the experimental model",
      "- Improves stability and reliability for Gemini-powered tasks",
    ],
  },
  {
    date: "2025-04-29",
    changes: [
      "Introduced AI Customer Support Agent",
      "- Context-aware support assistant powered by RAG technology",
      "- Real-time access to product documentation and guides",
      "- Page-specific help based on user's current location",
      "- Integration with knowledge base for accurate responses",
      "- Powered by the advanced GPT-4.1 model from OpenAI",
    ],
  },
  {
    date: "2025-04-17",
    changes: [
      "Added Output As JSON option on Task Details page",
      "- When enabled, the agent will output results in structured JSON format",
      "- Useful for programmatic processing of agent outputs",
      "- Task will fail if agent cannot produce valid JSON output",
      "Improved reliability of agent login by providing the list of domains with valid credentials to the agent",
    ],
  },
  {
    date: "2025-03-26",
    changes: [
      "Added support for code management with GitHub",
      "- Agents can now use submit_python_code to submit code to GitHub, subject for admin review",
      "- Once merged, the code can be loaded with get_approved_python_code() and run with run_approved_python_code",
      "Added support for the latest Gemini 2.5 Pro LLM",
      "Fixed various bugs and improved stability",
    ],
  },
  {
    date: "2025-03-18",
    changes: [
      "Added no-code API access via Config page",
      "- Users can now connect to external APIs without writing any code",
      "- Simply provide API name, key, and documentation link in the Config page",
      "- Agents then can use the API in their tasks",
      "- Share API configurations while maintaining security",
    ],
  },
  {
    date: "2025-03-17",
    changes: [
      "Added Extract Page Content option on Task Details page",
      "- Contents on pages can be extracted and saved as JSON files for download",
      "- Enable this option to automatically extract structured data from web pages",
      "Added Validate Output option on Task Details page",
      "- When enabled, the agent will validate its output to ensure higher accuracy",
      "Bug fixes",
    ],
  },
  {
    date: "2025-03-13",
    changes: [
      "Added execution details sharing functionality",
      "- Users can now share execution details via a secure URL",
      "- Share button added to Execution Details page",
      "- Shared executions can be viewed without requiring login",
    ],
  },
  {
    date: "2025-03-11",
    changes: [
      "Added support for output files (CSV, JSON, etc.)",
      "- Agents can now write results directly to files in various formats",
      "- Supported formats include CSV, JSON, TXT, XML, HTML, and more",
      "- Files can be downloaded after task execution is complete",
      "Added Complex Task support with Templates",
      "- Templates can now be configured with Complex Task option",
      "Added new models for running regular tasks: Anthropic 3.7 sonnet and Google Gemini 2.0 flash",
      "- Note: These models are not available for deep research yet",
      "- Expanded model selection provides more options for different task types",
    ],
  },
  {
    date: "2025-03-10",
    changes: [
      "Added Complex Task toggle on Task Details page",
      "- Allows agents to run up to 100 steps (instead of default 25)",
      "- Enables completion of more complex tasks requiring more actions",
    ],
  },
  {
    date: "2025-03-09",
    changes: [
      "Introduced Templates for task creation",
      "- Pre-configured templates with customizable parameters",
      "- Parameter values can be included in task names",
      "- Saves time and ensures consistency across similar tasks",
    ],
  },
  {
    date: "2025-03-07",
    changes: ["Added User Guide page", "Fixed various UI bugs"],
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
      "- It helps easily identify important emails",
    ],
  },
  {
    date: "2025-03-03",
    changes: [
      "Improved Deep Research reports",
      "- Reduced hallucination on citations",
      "- Added support for Azure OpenAI o1-mini model, which offers improved reasoning capabilities",
      "Optimized polling for Task Details page to reduce unnecessary traffic",
    ],
  },
  {
    date: "2025-02-28",
    changes: [
      "Added public credential sharing feature",
      "- Users can share their configured website credentials with everyone in Config page",
      "- Shared credentials remain securely encrypted and protected",
      "- Enhanced security with session isolation for shared credentials",
    ],
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
      "- Automatic fallback to other LLMs if preferred one fails",
    ],
  },
  {
    date: "2025-02-13",
    changes: [
      "Added execution log display for better task debugging visibility",
      "Enhanced user experience with detailed execution logs",
      "Improved error tracking and troubleshooting capabilities",
    ],
  },
  {
    date: "2025-02-12",
    changes: [
      "Added support for file attachments in tasks",
      "Implemented file download functionality for task results",
      "Enhanced task interface to manage attachments and downloads",
    ],
  },
  {
    date: "2025-02-11",
    changes: [
      "Major upgrade: Introduced Workflows feature",
      "Added support for creating workflows using natural programming language",
      "Implemented workflow execution engine",
      "Added workflow management interface",
      "Support for tasks running in predefined order within workflows",
    ],
  },
  {
    date: "2025-02-02",
    changes: [
      "Implemented parallel task execution",
      "Improved task scheduling and management",
      "Enhanced system performance for concurrent tasks",
    ],
  },
  {
    date: "2025-01-31",
    changes: [
      "Added support for editable task prompts",
      "Implemented per-user cookie file system",
      "Enhanced user isolation and security",
      "Improved user experience with customizable tasks",
    ],
  },
  {
    date: "2025-01-30",
    changes: [
      "Added support for multiple LLM providers:",
      "- AWS Anthropic Claude 3.5 Sonnet",
      "- Azure OpenAI GPT-4o",
      "- OpenAI GPT-4o",
      "Enhanced AI model selection and fallback system",
    ],
  },
  {
    date: "2025-01-29",
    changes: [
      "Implemented task subscription system via email",
      "Added email notifications for task results",
      "Support for non-registered users to receive task updates",
      "Enhanced collaboration features for team usage",
    ],
  },
  {
    date: "2025-01-27",
    changes: [
      "Beta launch of AgentWeb",
      "Initial UI implementation",
      "Core backend services deployment",
      "Agent engine development and integration",
      "Basic task management system",
    ],
  },
];

export const getReleases = (req: Request, res: Response) => {
  try {
    return res.status(200).json({ success: true, data: releases });
  } catch (error) {
    console.error("Error fetching release data:", error);
    return res
      .status(500)
      .json({ success: false, message: "Error fetching release data" });
  }
};
