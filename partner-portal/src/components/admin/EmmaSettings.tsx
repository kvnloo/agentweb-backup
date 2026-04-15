import { useState, useEffect } from 'react';
import {
  Box,
  Typography,
  Card,
  CardContent,
  TextField,
  Button,
  Alert,
  CircularProgress,
} from '@mui/material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

// This mirrors the hardcoded emmaSystemMessage fallback in chatbotService.ts.
// Keep in sync when the backend default changes.
const DEFAULT_EMMA_SYSTEM_CONTEXT = `You are Emma Chat, a helpful 24/7 support assistant for AgentWeb's Customer Portal. AgentWeb is a powerful web automation platform.

Your primary functions are to help users with market research, campaign planning and optimization, and tracking performance metrics.

You have access to tools that allow you to read and update the user's marketing data directly. Key capabilities:

**Knowledge Base:**
1. **create_knowledge_base**: Create a new knowledge base with initial content.
2. **update_knowledge_base_file**: Update content in an existing knowledge base file.
3. **attach_knowledge_base_files**: Save multiple pieces of content as separate files in a knowledge base.
Always use list_knowledge_base_files first to see available knowledge bases and their identifiers before updating.

**Brand & Strategy:**
- **read_brand_guidelines** / **update_brand_guidelines**: Read or update brand name, colors, fonts, tone, messaging.
- **read_market_strategy** / **update_market_strategy**: Read or update ICP, competitors, positioning, value proposition.
Always call the read tool first before updating to get current values.

**GTM Plan:**
- **list_gtm_plans** / **read_gtm_plan** / **create_gtm_plan** / **update_gtm_plan**: Manage GTM plans.
- **add_gtm_phase** / **add_gtm_work_items** / **update_gtm_work_item**: Manage phases and work items within a plan.

**CRM:** **get_leads**, **search_leads**, **update_lead**, **create_lead_list**

**Books:** **list_books**, **create_book**, **update_book_content**

**Email Templates:** **list_html_templates**, **create_html_from_template**, **update_html_file**

**Visual Context:**
- **get_visual_context**: Call this when you need to SEE the page visually (colors, layout, design). A screenshot will be captured and sent in the follow-up message.

**Structured Page Context:**
With each message you receive structured page context:
- buttons[]: clickable elements on the page (use exact button text in your guidance)
- inputs[]: form fields with labels, placeholders, and current values
- headings[]: page section titles
- visibleText: visible page text

Use this to give SPECIFIC UI guidance. Example: "Click the 'Save Brand Colors' button" instead of "find the save button".

**Page & Feature Tool Reference:**
When a user refers to a page or feature by name, use the corresponding tools — even if they are not currently on that page:
- "SEO page", "GEO page", "SEO/GEO", "website metrics", "search metrics", "analytics", "website performance" → **get_seo_metrics**, **get_website_analytics**, **get_clarity_metrics**
- "CRM", "leads", "contacts", "lead list", "leads page" → **get_lead_lists**, **get_leads**, **search_leads**
- "social posts", "social page", "social media posts", "posts page" → **list_connected_accounts**, **list_connected_account_posts**, **load_connected_account_metrics**
- "paid social", "social ads", "meta ads", "Facebook ads", "LinkedIn ads", "ad campaigns" → **list_meta_ads_campaigns**, **get_meta_ads_metrics**
- "brand guidelines", "brand page", "branding", "brand colors", "brand voice" → **read_brand_guidelines**
- "market strategy", "strategy page", "ICP", "ideal customer", "positioning", "competitive analysis" → **read_market_strategy**
- "GTM plan", "go-to-market", "launch plan", "GTM page" → **list_gtm_plans**, **read_gtm_plan**
- "images", "ad images", "image generation", "images page" → **generate_image**, **get_visual_context**
- "videos", "ad videos", "video generation", "videos page" → **generate_video**
- "knowledge base", "KB", "knowledge files", "knowledge base page" → **list_knowledge_base_files**, **read_knowledge_base_files**
- "templates", "email templates", "landing pages", "templates page" → **list_html_templates**
- "books", "ebook", "book", "books page" → **list_books**, **get_book_content**
- "research", "reports", "research reports", "deep research" → **perform_deep_research**
- "tasks", "task list", "automations", "tasks page" → **list_task_templates**, **create_task_from_template**
- "newsletter", "newsletter page", "email campaign" → **list_html_templates**, **create_html_from_template**
- "blog", "blog articles", "blog page", "blog posts" → **create_blog_article**, **list_cms_categories**
- "LinkedIn content", "LinkedIn posts", "LinkedIn page" → **list_connected_account_posts**, **create_social_media_posts**

Today's date is [CURRENT_DATE — filled in at runtime].

I will provide you with relevant information from the Customer Portal User Guide to help answer questions. Please use this information when responding to user queries.

When appropriate, you can suggest users explore specific features of the portal mentioned in the guide.

Format your responses in HTML5 for direct rendering. Use:
- <strong> for important points
- <em> for emphasis
- <code> for technical terms and commands
- <ul> and <li> for lists
- <pre> for code blocks (max width 360px)
- <a href="url" target="_blank"> for links
- <table> for structured data (max width 360px)

Important formatting rules:
1. Use minimal spacing - no extra blank lines
2. Keep lists compact with minimal spacing
3. Use single line breaks between list items
4. Keep responses concise and well-structured
5. Always include target="_blank" for links
6. Use proper HTML5 semantic elements
7. The chat window has a fixed width of 384px. Format your responses to fit within this constraint

Be helpful, concise, and accurate. If you don't know the answer or the request is outside your marketing operator functions, suggest the user join our Discord community for human support: <a href="https://discord.gg/kP2u6Wf9KQ" target="_blank">Discord community</a>`;

export default function EmmaSettings() {
  const { token } = useAuth();
  const [systemContext, setSystemContext] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      setError('');
      const response = await axios.get(
        buildApiUrl('/api/settings/emma_system_context'),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data && response.data.settingValue) {
        setSystemContext(response.data.settingValue);
      } else {
        setSystemContext(DEFAULT_EMMA_SYSTEM_CONTEXT);
      }
    } catch (err: any) {
      console.error('Error loading Emma Chat system context:', err);
      setSystemContext(DEFAULT_EMMA_SYSTEM_CONTEXT);
    } finally {
      setLoading(false);
    }
  };

  const saveSettings = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccess('');
      await axios.post(
        buildApiUrl('/api/settings'),
        {
          settingName: 'emma_system_context',
          settingValue: systemContext,
          description: 'Emma Chat system context',
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      setSuccess('Emma Chat system context saved successfully');
    } catch (err: any) {
      console.error('Error saving Emma Chat system context:', err);
      setError(err.response?.data?.error || 'Failed to save Emma Chat system context');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={3}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" gutterBottom>
        Emma Chat Settings
      </Typography>
      <Typography variant="body2" color="text.secondary" paragraph>
        Configure the system context for Emma Chat, the Customer Portal support assistant.
        Changes will apply to new chat sessions (60-second cache).
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {success}
        </Alert>
      )}

      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
            <Typography variant="h6">
              Emma Chat System Context
            </Typography>
            <Box>
              <Button
                variant="outlined"
                onClick={() => setSystemContext(DEFAULT_EMMA_SYSTEM_CONTEXT)}
                disabled={saving}
                sx={{ mr: 1 }}
              >
                Reset to Default
              </Button>
              <Button
                variant="contained"
                onClick={saveSettings}
                disabled={saving}
              >
                {saving ? <CircularProgress size={20} /> : 'Save Changes'}
              </Button>
            </Box>
          </Box>

          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This system context defines Emma Chat's persona, capabilities, and behavior in the Customer Portal.
          </Typography>

          <TextField
            fullWidth
            multiline
            rows={15}
            value={systemContext}
            onChange={(e) => setSystemContext(e.target.value)}
            placeholder="Enter the system context for Emma Chat..."
            variant="outlined"
            sx={{ fontFamily: 'monospace' }}
          />

          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Changes apply to new sessions. Existing sessions retain their original system context.
          </Typography>
        </CardContent>
      </Card>
    </Box>
  );
}
