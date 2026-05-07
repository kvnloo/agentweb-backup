import { agentModeService } from '../services/agentModeService';
import { emmaToolRegistry } from './registry';
import { accountMemoryDb, userDb } from '../services/db';
import { crmDb } from '../services/db';
import { askCrm, AskCrmLead } from '../services/askCrmService';
import { getAccountSummary } from '../services/accountSummaryService';
import { dealDb, DealAuthError, DealNotFoundError, DEAL_STAGES, type DealStage } from '../services/dealDb';
import { contactEventsDb, normalizeContactId } from '../services/contactEventsDb';
import { chatbotDb } from '../services/chatbotService';
import { RESEND_SYSTEM_EMAIL, RESEND_SYSTEM_NAME } from '../config';

// Register browser cookie persistence tools
import './browserCookieTools';

// Register email lookup / find tool (provider-agnostic)
import './emailLookupTool';

emmaToolRegistry.register({
  name: 'install_skills',
  definition: {
    name: 'install_skills',
    description: 'Install skills by their IDs. Pass ALL skill IDs you need in a single call — do not call this tool multiple times. This makes the tools associated with the skills available for use. Use __other_skills__ to install tools that are not part of any specific skill.',
    inputSchema: {
      type: 'object',
      properties: {
        skillIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of ALL skill IDs to install. Include every skill you need in one call.'
        }
      },
      required: ['skillIds']
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;

    if (!userId) {
      throw new Error("Authentication required: no user context");
    }

    if (!Array.isArray(args.skillIds) || args.skillIds.length === 0) {
      return { message: "skillIds must be a non-empty array of skill IDs." };
    }

    // For external MCP clients: validate and update session state
    if (context?.updateInstalledSkills) {
      const { skillService } = await import('../services/skillService');
      const { getAllowedSkills } = await import('../services/subscriptionService');

      const [publishedSkills, userAllowedSkillIds] = await Promise.all([
        skillService.getSkillsAvailableToUser(userId),
        getAllowedSkills(userId)
      ]);

      const isWildcard = userAllowedSkillIds.includes("*");
      const allowedSkillSet = new Set(userAllowedSkillIds);

      const validSkillIds = args.skillIds.filter((id: string) => {
        const skill = publishedSkills.find(s => s.skillId === id);
        const isOwnSkill = skill && (skill as any).ownerId === userId;
        return (id === '__other_skills__' || skill) &&
          (isOwnSkill || isWildcard || allowedSkillSet.has(id));
      });

      if (validSkillIds.length === 0) {
        return {
          message: "No valid skills found. The requested skills may not exist or are not included in your subscription."
        };
      }

      // Update MCP session's installed skills
      context.updateInstalledSkills(validSkillIds);

      const installedNames = validSkillIds.map((id: string) => {
        if (id === '__other_skills__') return 'other_skills';
        const skill = publishedSkills.find(s => s.skillId === id);
        return skill?.name || id;
      });

      return {
        success: true,
        message: `Successfully installed ${installedNames.length} skill(s). Use list_tools to see newly available tools.`,
        installedSkills: installedNames
      };
    }

    // For internal clients (agent mode): use chat session pattern
    if (!context?.sessionId) {
      throw new Error("Missing session context");
    }
    return await agentModeService.installSkills(args.skillIds, userId, context.sessionId, context.isDelegatedAccess === true);
  }
});

emmaToolRegistry.register({
  name: 'list_available_skills',
  definition: {
    name: 'list_available_skills',
    description: 'List all available skills with their descriptions and tool lists. Use this to discover what capabilities Emma offers before installing skills. Returns skill catalog with IDs, names, descriptions, and tool names.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;

    if (!userId) {
      throw new Error("Authentication required");
    }

    const { skillService } = await import('../services/skillService');
    const { getAllowedSkills } = await import('../services/subscriptionService');

    const [publishedSkills, userAllowedSkillIds] = await Promise.all([
      skillService.getSkillsAvailableToUser(userId),
      getAllowedSkills(userId)
    ]);

    const isWildcard = userAllowedSkillIds.includes("*");
    const allowedSkillSet = new Set(userAllowedSkillIds);

    // Filter skills by user's subscription (user's own private skills always pass)
    const availableSkills = publishedSkills
      .filter(skill => isWildcard || allowedSkillSet.has(skill.skillId) || (skill as any).ownerId === userId)
      .map(skill => ({
        skillId: skill.skillId,
        name: skill.name,
        description: skill.description,
        toolNames: skill.toolNames || [],
        toolCount: (skill.toolNames || []).length
      }));

    // Add __other_skills__ virtual skill
    if (isWildcard || allowedSkillSet.has('__other_skills__')) {
      const { agentModeService } = await import('../services/agentModeService');
      const unassociatedTools = agentModeService.getUnassociatedToolNames(publishedSkills);

      availableSkills.push({
        skillId: '__other_skills__',
        name: 'Other Tools',
        description: 'Additional tools not part of any specific skill bundle',
        toolNames: unassociatedTools,
        toolCount: unassociatedTools.length
      });
    }

    // Add __admin_tools__ virtual skill for admin users or admin delegated access
    try {
      const { userDb } = await import('../services/db');
      const currentUser = await userDb.getUserById(userId);
      const hasAdminAccess = currentUser?.isAdmin === true || context?.isDelegatedAdmin === true;
      if (hasAdminAccess) {
        const { agentModeService } = await import('../services/agentModeService');
        const adminToolNamesList = agentModeService.getAdminToolNames();
        availableSkills.push({
          skillId: '__admin_tools__',
          name: 'Admin Tools',
          description: 'Admin-only tools: manage predefined work plans, skill definitions, chat history, and client health assessment. WARNING: These tools modify production configuration — use with extra care.',
          toolNames: adminToolNamesList,
          toolCount: adminToolNamesList.length
        });
      }
    } catch {
      // Skip admin tools if user lookup fails
    }

    return {
      skills: availableSkills,
      totalSkills: availableSkills.length,
      message: `Found ${availableSkills.length} available skill(s). Use install_skills(['skill-id']) to unlock their tools.`
    };
  }
});

emmaToolRegistry.register({
  name: 'linkedin_outreach',
  definition: {
    name: 'linkedin_outreach',
    description: `LinkedIn outreach tool via a connected Unipile account. To find the account_id, call list_connected_accounts(platform='unipile') tool.

Actions:
- search-people: Search LinkedIn for people by any combination of: keywords (free-text), title, company, location, industry, school. Free-text company/location/industry/school are auto-resolved to LinkedIn entity IDs by the backend. Alternatively pass search_url with a LinkedIn search URL copied from the browser. The backend handles Unipile's classic-search keyword requirement automatically — you can pass just structured filters (e.g. {title: "CTO", company: "Microsoft"}) without specifying keywords. Returns paginated results with provider_id for each person.
- get-profile: Get detailed profile info (headline, location, network_distance, is_open_profile, etc.) for a LinkedIn user by provider_id.
- list-connections: List the user's 1st-degree LinkedIn connections. Returns paginated results.
- list-sent-invitations: List pending/sent connection requests with status. Returns paginated results.
- list-received-invitations: (exact action string: "list-received-invitations") List pending connection requests received from others. Returns paginated results with sender info.
- send-invite: Send a connection request. Requires profile_url or provider_id. message optional but recommended.
- send-message: Send a direct message. Requires profile_url or provider_id. message required. Only works for 1st-degree connections or open profiles. When sending to a CRM lead, always provide list_id and lead_id — the system enforces that update-conversation-history was called within the last 24 hours before allowing a send.
- send-inmail: Send a LinkedIn InMail to any profile regardless of connection degree (2nd/3rd-degree connections). Requires profile_url or provider_id, message (body), and subject. Requires a LinkedIn Premium account with available InMail credits. Use this when send-message is not possible due to connection degree restrictions. list_id and lead_id are optional but recommended for CRM persistence.
- get-company: Get a LinkedIn company profile by company_id (the company's LinkedIn identifier/slug).
- cancel-invitation: Cancel a pending invitation by invitation_id (obtain from list-sent-invitations).
- accept-invitation: (exact action string: "accept-invitation") Accept a received connection request. Requires invitation_id and shared_secret — both obtained from list-received-invitations.
- update-conversation-history: Fetch the full message history with a LinkedIn contact from Unipile and persist it to the lead's CRM engagement activities. Also updates the lead's sync timestamp so send-message is unblocked for the next 24 hours. Requires list_id and lead_id in addition to profile_url or provider_id.
- search-parameters: Resolve a free-text query (company name, location, industry, school, service) to LinkedIn entity IDs via Unipile's parameter search. Required: type (one of COMPANY, LOCATION, INDUSTRY, SCHOOL, SERVICE) and keywords. Optional limit. Returns ranked candidates with id/title/subtitle plus fromCache and source metadata. Use the returned id with the matching *_id field on search-people for precise structured filtering.

For target person identification (send-invite, send-message, get-profile, update-conversation-history), pass EITHER:
- profile_url: a full LinkedIn profile URL (e.g. https://www.linkedin.com/in/username/)
- provider_id: the Unipile provider_id directly if you already have it`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['search-people', 'get-profile', 'list-connections', 'list-sent-invitations', 'list-received-invitations', 'send-invite', 'send-message', 'send-inmail', 'get-company', 'cancel-invitation', 'accept-invitation', 'update-conversation-history', 'search-parameters'],
          description: 'The outreach action to perform.'
        },
        account_id: {
          type: 'string',
          description: 'The Unipile account ID for the LinkedIn connection. Optional for search-people and get-profile — the system will automatically use a platform-wide account if the user has no personal account connected. For write actions (send-invite, send-message), must be the user\'s own account. Obtain via list_connected_accounts(platform=\'unipile\') tool.'
        },
        profile_url: {
          type: 'string',
          description: 'Full LinkedIn profile URL (e.g. https://www.linkedin.com/in/username/). For send-invite, send-message, update-conversation-history. Provide this OR provider_id.'
        },
        provider_id: {
          type: 'string',
          description: 'The Unipile provider_id for the target LinkedIn user. For send-invite, send-message, get-profile, update-conversation-history. Provide this OR profile_url.'
        },
        message: {
          type: 'string',
          description: 'Message content. Required for send-message and send-inmail; recommended for send-invite.'
        },
        subject: {
          type: 'string',
          description: 'Subject line for send-inmail. Required for InMail messages.'
        },
        list_id: {
          type: 'string',
          description: 'CRM lead list ID. Required for update-conversation-history. Also required for send-message when enforcing the 24-hour sync gate.'
        },
        lead_id: {
          type: 'string',
          description: 'CRM lead ID. Required for update-conversation-history. Also required for send-message when enforcing the 24-hour sync gate.'
        },
        keywords: {
          type: 'string',
          description: 'Optional free-text search keywords for search-people. Pass when you want a broad match across name/headline/bio. Omit when using structured filters alone — the backend will synthesize a keyword from your most-specific filter (title > company > location > industry > school) so the Unipile classic-search keyword requirement is satisfied transparently.'
        },
        search_url: {
          type: 'string',
          description: 'A LinkedIn search URL copied from the browser for search-people action. Alternative to keyword-based search.'
        },
        title: {
          type: 'string',
          description: 'Job title filter for search-people (e.g. "CTO").'
        },
        company: {
          type: 'string',
          description: 'Company name filter for search-people — free text, auto-resolved to a LinkedIn company id if no company_id is provided.'
        },
        company_id: {
          type: 'string',
          description: 'LinkedIn company identifier/slug. Used for get-company. Optional pre-resolved LinkedIn company entity ID for search-people — when provided, skips the resolver.'
        },
        location: {
          type: 'string',
          description: 'Location filter for search-people — free text, auto-resolved if no location_id is provided.'
        },
        location_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn location entity ID for search-people — when provided, skips the resolver.'
        },
        industry: {
          type: 'string',
          description: 'Industry filter for search-people — free text, auto-resolved if no industry_id is provided.'
        },
        industry_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn industry entity ID for search-people — when provided, skips the resolver.'
        },
        school: {
          type: 'string',
          description: 'School filter for search-people — free text, auto-resolved if no school_id is provided.'
        },
        school_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn school entity ID for search-people — when provided, skips the resolver.'
        },
        type: {
          type: 'string',
          enum: ['COMPANY', 'LOCATION', 'INDUSTRY', 'SCHOOL', 'SERVICE'],
          description: 'Entity type to resolve for search-parameters action.'
        },
        limit: {
          type: 'number',
          description: 'Max number of candidates to return for search-parameters. Optional; the resolver picks a sensible default.'
        },
        invitation_id: {
          type: 'string',
          description: 'Invitation ID for cancel-invitation or accept-invitation actions. Obtain from list-sent-invitations or list-received-invitations respectively.'
        },
        shared_secret: {
          type: 'string',
          description: 'LinkedIn shared_secret token required for accept-invitation. Returned by list-received-invitations alongside each invitation record.'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for search-people, list-connections, list-sent-invitations, list-received-invitations.'
        }
      },
      required: ['action']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error("Missing user context");
    }
    const targetActions = ['send-invite', 'send-message', 'send-inmail', 'get-profile', 'update-conversation-history'];
    if (targetActions.includes(args.action)) {
      if (!args.profile_url && !args.provider_id) {
        return { success: false, message: 'Either profile_url or provider_id is required.' };
      }
      if (args.profile_url && args.provider_id) {
        return { success: false, message: 'Provide only one of profile_url or provider_id, not both.' };
      }
    }
    return await agentModeService.linkedinOutreach(context.userId, args);
  }
});

emmaToolRegistry.register({
  name: 'list_meta_ads_campaigns',
  definition: {
    name: 'list_meta_ads_campaigns',
    description: 'List all Meta ad campaigns for the current user. Returns campaign names, IDs, statuses, and objectives. Works even without a Meta connected account (falls back to legacy adAccount config). Use this first to get campaign IDs, then call get_meta_ads_metrics.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.listMetaAdsCampaignsNew(context?.userId);
  }
});

// --- Tools from marketingTools.ts ---
emmaToolRegistry.register({
  name: "call_meta_marketing_api",
  definition: {
    name: "call_meta_marketing_api",
    description:
      `Manage Meta Ads entities via the Marketing API. Requires account_id from list_connected_accounts(platform='meta').

ACTION MATRIX (entity_type → supported actions):
  CAMPAIGN      → LIST, CREATE, UPDATE, DELETE
  AD_SET        → LIST, CREATE, UPDATE, DELETE
  AD_CREATIVE   → LIST, CREATE, UPLOAD_IMAGE, UPLOAD_VIDEO
  AD            → LIST, CREATE, UPDATE, DELETE, COPY_AD
  CUSTOM_AUDIENCE → LIST, CREATE, UPLOAD_USERS
  TARGETING     → SEARCH
  PAGE          → LIST
  DATASET       → LIST, GET_MATCH_QUALITY

DATASET USAGE:
  LIST              → Returns all pixels and their associated datasets (server event data sources) for the ad account
  GET_MATCH_QUALITY → Returns Event Match Quality (EMQ) scores per event type for a specific dataset. Requires params.dataset_id.
  WORKFLOW: First LIST to discover pixel/dataset IDs, then GET_MATCH_QUALITY with the dataset_id.
  NOTE: Match quality data is only available if the advertiser has Conversions API (CAPI) set up.

REQUIRED IDs PER ACTION:
  CAMPAIGN UPDATE/DELETE  → campaign_id required
  AD_SET CREATE           → campaign_id required
  AD_SET UPDATE/DELETE    → ad_set_id required
  AD CREATE               → ad_set_id required
  AD UPDATE/DELETE        → ad_id required
  AD COPY_AD              → ad_id (source ad to copy) required
  TARGETING SEARCH        → params.q and params.type required

REQUIRED PARAMS PER ENTITY + ACTION:
  CAMPAIGN CREATE:      name, objective, special_ad_categories (e.g. ["NONE"])
  AD_SET CREATE:        name, optimization_goal, billing_event, targeting (with geo_locations), daily_budget OR lifetime_budget (not both; lifetime_budget requires end_time)
  AD_CREATIVE CREATE:   name, page_id, body, title, link_url + exactly one creative type (see below)
  AD CREATE:            name, creative_id (plus ad_set_id top-level param)
  AD COPY_AD:           ad_id = source ad ID. Optional params: name (new ad name), adset_id (target ad set; defaults to source ad's set), link_url (override destination URL), body, title, status (default PAUSED). Automatically copies images — no manual upload needed.
  CUSTOM_AUDIENCE CREATE: name, subtype (CUSTOM or LOOKALIKE)
  TARGETING SEARCH:     q (search query), type (adinterest | adbehavior | addemographics)

COPY_AD WORKFLOW (clone an existing ad with optional overrides):
  1. Use AD LIST to find the source ad and get its ad_id
  2. Call AD COPY_AD with the source ad_id and any overrides (e.g. link_url for new landing page)
  3. The system automatically: reads source creative → copies images (re-uploading from CDN if needed) → creates new creative → creates new ad
  4. Returns new_ad_id and new_creative_id
  NOTE: AD LIST now includes creative.object_story_spec so you can inspect image/video/URL details before copying.

CAMPAIGN OBJECTIVES (valid values for 'objective'):
  OUTCOME_TRAFFIC, OUTCOME_AWARENESS, OUTCOME_ENGAGEMENT, OUTCOME_SALES, OUTCOME_LEADS, OUTCOME_APP_PROMOTION

BUDGET RULES (Campaign & Ad Set):
  - Provide daily_budget OR lifetime_budget, NEVER both
  - lifetime_budget requires end_time (ISO 8601)
  - advantage_campaign_budget=true enables campaign-level budget; use budget_amount instead of ad-set-level budget

CREATIVE SUB-TYPES (mutually exclusive — pick exactly one):
  IMAGE creative:    provide image_hash (from UPLOAD_IMAGE) OR image_url
  VIDEO creative:    provide video_id (from UPLOAD_VIDEO) + REQUIRED thumbnail: image_hash or image_url
                     (Meta API error 1443226 if thumbnail is missing — always upload thumbnail first)
  CAROUSEL creative: provide carousel_cards array with 2–10 items; each card needs at least one of image_hash, image_url, or video_id; plus title, link_url per card
  RULE: Cannot pass both video_id and carousel_cards — they are mutually exclusive.

VIDEO CREATIVE WORKFLOW (3 steps, all required):
  Step 1: UPLOAD_VIDEO → returns video_id
  Step 2: UPLOAD_IMAGE → returns image_hash  (thumbnail — MANDATORY for video creatives)
  Step 3: AD_CREATIVE CREATE with video_id + image_hash (or image_url)

OBJECTIVE → OPTIMIZATION GOAL COMPATIBILITY (common mappings):
  OUTCOME_TRAFFIC   → LINK_CLICKS, LANDING_PAGE_VIEWS
  OUTCOME_AWARENESS → REACH, IMPRESSIONS
  OUTCOME_ENGAGEMENT → POST_ENGAGEMENT, PAGE_LIKES
  OUTCOME_SALES     → OFFSITE_CONVERSIONS, VALUE
  OUTCOME_LEADS     → LEAD_GENERATION, OFFSITE_CONVERSIONS
  OUTCOME_APP_PROMOTION → APP_INSTALLS

AD LIST COMPLETENESS:
  AD LIST returns ALL non-deleted ads including those paused at the campaign or adset level.
  Each ad includes effective_status which shows the true running state:
    ACTIVE           → ad is running
    PAUSED           → ad itself is paused
    CAMPAIGN_PAUSED  → ad's campaign is paused (ad would run if campaign is unpaused)
    ADSET_PAUSED     → ad's adset is paused (ad would run if adset is unpaused)
  To fully pause all spend, you must pause ads/adsets/campaigns in ALL effective statuses, not just ACTIVE.
  When asked to "pause all ads", always LIST first then UPDATE every ad regardless of effective_status.

GETTING DESTINATION URLS / CREATIVE DETAILS:
  AD LIST now returns creative sub-fields directly (name, body, title, image_url, thumbnail_url, object_story_spec).
  Extract link from: image creative → creative.object_story_spec.link_data.link
                     video creative → creative.object_story_spec.video_data.call_to_action.value.link
                     carousel       → creative.object_story_spec.link_data.child_attachments[].link
  If you need creatives for ALL ads in the account without filtering: use AD_CREATIVE LIST.`,
    inputSchema: {
      type: "object",
      properties: {
        entity_type: {
          type: "string",
          enum: ["CAMPAIGN", "AD_SET", "AD_CREATIVE", "AD", "CUSTOM_AUDIENCE", "TARGETING", "PAGE", "DATASET"],
          description: "The Meta Ads entity to operate on."
        },
        action: {
          type: "string",
          enum: ["LIST", "CREATE", "UPDATE", "DELETE", "COPY_AD", "UPLOAD_IMAGE", "UPLOAD_VIDEO", "UPLOAD_USERS", "SEARCH", "GET_MATCH_QUALITY"],
          description: "The operation to perform. Must be valid for the chosen entity_type."
        },
        account_id: {
          type: "string",
          description: "Ad Account ID (without 'act_' prefix). Must be obtained from list_connected_accounts(platform='meta')."
        },
        campaign_id: {
          type: "string",
          description: "Campaign ID. Required for: CAMPAIGN UPDATE/DELETE, AD_SET CREATE, AD_SET LIST (optional filter)."
        },
        ad_set_id: {
          type: "string",
          description: "Ad Set ID. Required for: AD_SET UPDATE/DELETE, AD CREATE, AD LIST (optional filter)."
        },
        ad_id: {
          type: "string",
          description: "Ad ID. Required for: AD UPDATE/DELETE."
        },
        params: {
          type: "object",
          description: "Action-specific parameters. Required fields depend on entity_type + action (see tool description for the full matrix).",
          properties: {
            // --- Common ---
            name: { type: "string", description: "Entity name." },
            status: { type: "string", enum: ["ACTIVE", "PAUSED", "ARCHIVED"], description: "Entity status." },

            // --- Campaign ---
            objective: { type: "string", description: "Campaign objective (e.g., OUTCOME_TRAFFIC, OUTCOME_SALES)." },
            special_ad_categories: { type: "array", items: { type: "string" }, description: 'Special ad categories. Use ["NONE"] if not applicable.' },
            advantage_campaign_budget: { type: "boolean", description: "Enable Advantage Campaign Budget." },
            budget_amount: { type: "number", description: "Campaign-level daily budget in dollars (when advantage_campaign_budget is true)." },

            // --- Ad Set ---
            optimization_goal: { type: "string", description: "Optimization goal (must be compatible with campaign objective)." },
            billing_event: { type: "string", description: "Billing event (must be compatible with optimization_goal)." },
            daily_budget: { type: "number", description: "Daily budget in dollars. Min $1, max $5,000." },
            lifetime_budget: { type: "number", description: "Lifetime budget in dollars. Min $1, max $50,000. Requires end_time." },
            bid_strategy: { type: "string", enum: ["LOWEST_COST_WITHOUT_CAP", "LOWEST_COST_WITH_BID_CAP", "COST_CAP"], description: "Bid strategy." },
            bid_amount: { type: "number", description: "Bid amount in dollars. Required for BID_CAP and COST_CAP strategies." },
            targeting: {
              type: "object",
              description: "Targeting specification. geo_locations is required. targeting_automation.advantage_audience (0 or 1) is auto-injected as 0 if omitted — pass explicitly to override. Example: { geo_locations: { countries: ['US'] }, targeting_automation: { advantage_audience: 0 } }"
            },
            start_time: { type: "string", description: "ISO 8601 start datetime." },
            end_time: { type: "string", description: "ISO 8601 end datetime. Required with lifetime_budget." },
            promoted_object: { type: "object", description: "Promoted object (e.g., { page_id: 'ID' } or { pixel_id: 'ID', custom_event_type: 'PURCHASE' })." },

            // --- Creative ---
            page_id: { type: "string", description: "Facebook Page ID (from list_meta_pages or PAGE LIST)." },
            image_hash: { type: "string", description: "Image hash from UPLOAD_IMAGE." },
            image_url: { type: "string", description: "Image URL (for UPLOAD_IMAGE action or direct creative use)." },
            video_id: { type: "string", description: "Video ID from UPLOAD_VIDEO." },
            video_url: { type: "string", description: "Video URL (for UPLOAD_VIDEO action)." },
            carousel_cards: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_hash: { type: "string" }, video_id: { type: "string" },
                  title: { type: "string" }, description: { type: "string" }, link_url: { type: "string" }
                }
              },
              description: "Carousel card array for multi-card creatives."
            },
            body: { type: "string", description: "Ad body / primary text." },
            title: { type: "string", description: "Ad headline." },
            link_url: { type: "string", description: "Destination URL." },
            call_to_action_type: { type: "string", description: "CTA button (e.g., LEARN_MORE, SHOP_NOW, SIGN_UP)." },
            creative_id: { type: "string", description: "Creative ID for AD CREATE." },

            // --- Custom Audience ---
            subtype: { type: "string", enum: ["CUSTOM", "LOOKALIKE"], description: "Audience subtype." },
            description: { type: "string", description: "Audience description." },
            customer_file_source: { type: "string", description: "Source type for CUSTOM audiences (e.g., USER_PROVIDED_ONLY)." },
            lookalike_spec: { type: "object", description: "Lookalike config: { origin: [{ id, type }], ratio: 0.01, country: 'US' }." },
            id: { type: "string", description: "Audience ID for UPLOAD_USERS." },
            schema: { type: "array", items: { type: "string" }, description: "PII field types for UPLOAD_USERS (e.g., ['EMAIL', 'FN', 'LN'])." },
            payload: { type: "string", description: "User data as JSON array-of-arrays for UPLOAD_USERS." },

            // --- Targeting Search ---
            q: { type: "string", description: "Search query for targeting search." },
            type: { type: "string", enum: ["adinterest", "adbehavior", "addemographics"], description: "Targeting category to search." },

            // --- Dataset ---
            dataset_id: { type: "string", description: "Dataset ID. Required for DATASET GET_MATCH_QUALITY." }
          }
        }
      },
      required: ["entity_type", "action", "account_id"]
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callMetaMarketingApi(
      context?.userId,
      args.entity_type,
      args.action,
      args.account_id,
      args.campaign_id,
      args.ad_set_id,
      args.ad_id,
      args.params,
    );
  }
});

emmaToolRegistry.register({
  name: "call_meta_ads_insights_api",
  definition: {
    name: "call_meta_ads_insights_api",
    description:
      "Fetch performance reporting data from Meta Ads (impressions, clicks, spend, conversions, ROAS, etc.). Use this for custom queries with specific fields, date ranges, breakdowns, or filtering. Handles Meta's async reporting internally — returns an S3 URL to JSON results when ready. You MUST provide either date_preset or time_range (defaults to all-time if omitted, which can be very large). For a quick pre-built dashboard summary of specific campaigns, use get_meta_ads_metrics instead.",
    inputSchema: {
      type: "object",
      properties: {
        account_id: {
          type: "string",
          description:
            "The ad account ID (numeric, without 'act_' prefix). Use list_connected_accounts to retrieve this. DO NOT guess.",
        },
        object_type: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description:
            "Entity level to fetch insights for. Use 'account' for the whole account.",
        },
        object_id: {
          type: "string",
          description:
            "The entity ID. REQUIRED when object_type is campaign, adset, or ad. Omit for account-level.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Metrics to retrieve. Common: impressions, reach, clicks, spend, ctr, cpc, cpm, actions, action_values, purchase_roas, conversions, video_views, cost_per_action_type.",
        },
        date_preset: {
          type: "string",
          enum: [
            "today",
            "yesterday",
            "this_month",
            "last_month",
            "this_quarter",
            "maximum",
            "last_3d",
            "last_7d",
            "last_14d",
            "last_28d",
            "last_30d",
            "last_90d",
            "this_year",
            "last_year"
          ],
          description:
            "Predefined date range. Recommended default: 'last_30d'. Use 'maximum' for lifetime. Mutually exclusive with time_range.",
        },
        time_range: {
          type: "object",
          properties: {
            since: {
              type: "string",
              description: "Start date (YYYY-MM-DD). Must be <= until.",
            },
            until: {
              type: "string",
              description: "End date (YYYY-MM-DD). Must be >= since.",
            },
          },
          required: ["since", "until"],
          description:
            "Custom date range. Both since and until are required. Mutually exclusive with date_preset.",
        },
        level: {
          type: "string",
          enum: ["account", "campaign", "adset", "ad"],
          description:
            "Row aggregation level. Example: object_type='account' + level='campaign' returns one row per campaign.",
        },
        breakdowns: {
          type: "array",
          items: {
            type: "string",
            enum: ["age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform"],
          },
          description:
            "Segment results by dimension. E.g., ['age', 'gender'] splits each row by age+gender.",
        },
        action_breakdowns: {
          type: "array",
          items: {
            type: "string",
            enum: ["action_type", "action_target_id", "action_destination", "action_device", "action_reaction", "action_video_sound", "action_video_type", "action_carousel_card_id", "action_carousel_card_name"],
          },
          description:
            "Segment action/conversion metrics. Use 'action_type' to break down the 'actions' and 'action_values' fields by event type (e.g., purchase, link_click).",
        },
        filtering: {
          type: "array",
          items: {
            type: "object",
            properties: {
              field: { type: "string", description: "Field to filter on (e.g., 'campaign.name', 'adset.name', 'campaign.objective')." },
              operator: { type: "string", enum: ["EQUAL", "NOT_EQUAL", "GREATER_THAN", "LESS_THAN", "IN", "NOT_IN", "CONTAIN", "NOT_CONTAIN"] },
              value: { description: "Filter value. String for EQUAL/CONTAIN, array for IN/NOT_IN." },
            },
            required: ["field", "operator", "value"],
          },
          description:
            "Server-side filters to narrow results before aggregation.",
        },
      },
      required: ["account_id", "object_type", "fields"],
    },
  },
  execute: async (args, context) => {
    return await agentModeService.callMetaAdsInsightsApiWrapper(
      context?.userId,
      args as any,
    );
  },
});

emmaToolRegistry.register({
  name: 'get_meta_ads_metrics',
  definition: {
    name: 'get_meta_ads_metrics',
    description: 'Quick pre-built dashboard: returns a formatted summary of campaign, ad set, and ad performance with demographics, placement, and device breakdowns for specific campaigns. Best for "how are my campaigns doing?" questions. For custom field selection, custom date ranges, or raw data export, use call_meta_ads_insights_api instead.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          description: 'Time period for metrics (7d, 14d, 30d, 90d)',
          enum: ['7d', '14d', '30d', '90d'],
          default: '7d'
        },
        campaign_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'Required list of campaign IDs to filter metrics by. Use list_meta_ads_campaigns to get available campaign IDs (works even without a connected Meta account).'
        }
      },
      required: ['campaign_ids']
    }
  },
  execute: async (args, context) => {
    // Backward-compatible normalization: accept legacy campaign_id or string campaign_ids.
    const normalizedCampaignIds = Array.isArray(args.campaign_ids)
      ? args.campaign_ids
      : (typeof args.campaign_ids === 'string' && args.campaign_ids.trim())
        ? [args.campaign_ids.trim()]
        : (typeof args.campaign_id === 'string' && args.campaign_id.trim())
          ? [args.campaign_id.trim()]
          : [];

    return await agentModeService.getMetaAdsMetrics(args.timeframe || '7d', context?.userId, normalizedCampaignIds);
  }
});

// --- LinkedIn Ads Tools ---
emmaToolRegistry.register({
  name: 'call_linkedin_marketing_api',
  definition: {
    name: 'call_linkedin_marketing_api',
    description: `Manage LinkedIn Ads entities via the Marketing Developer Platform API. Requires account_id from list_connected_accounts(platform='linkedin_ads').

INTERNAL TERMINOLOGY MAPPING (never mention API names in responses):
  User says "campaign"  →  use entity_type = CAMPAIGN_GROUP
  User says "ad set"    →  use entity_type = CAMPAIGN
  User says "ad"        →  use entity_type = CREATIVE
The words CAMPAIGN_GROUP, CAMPAIGN, CREATIVE must NEVER appear in your response to the user. These are internal API values only.
Always say "Campaign", "Ad Set", "Ad" — nothing else.
FORBIDDEN (never say these): "campaign group", "creative", "ad set (campaign)", "ads (creatives)", "campaigns (campaign groups)"

ACTION MATRIX (entity_type → supported actions):
  AD_ACCOUNT      → LIST
  CAMPAIGN_GROUP  → LIST, CREATE, UPDATE
  CAMPAIGN        → LIST, CREATE, UPDATE
  CREATIVE        → LIST, CREATE, CREATE_INLINE, CREATE_DYNAMIC
  POST            → CREATE
  TARGETING       → LIST_FACETS, SEARCH, ESTIMATE_REACH
  MEDIA           → UPLOAD_IMAGE, UPLOAD_VIDEO, UPLOAD_DOCUMENT
  INMAIL          → CREATE_CONTENT, SEND_TEST
  CONVERSATION_AD → CREATE, CREATE_CONTENT, SET_FIRST_CONTENT

ENTITY HIERARCHY: Ad Account → Campaign Group → Campaign → Creative

⚠️ AD FORMAT FLOWS — STRICTLY FOLLOW THESE, NO DEVIATION:

  SINGLE IMAGE AD (campaign type: SPONSORED_UPDATES):
    Ask first: "Show on company page or dark post only?"
    Company page (FLOW A): MEDIA/UPLOAD_IMAGE → POST/CREATE (feed_distribution=MAIN_FEED, image_urn) → CREATIVE/CREATE (post_urn)
    Dark post  (FLOW B): MEDIA/UPLOAD_IMAGE → CREATIVE/CREATE_INLINE (image_urn, commentary, campaign_id)

  CAROUSEL AD (Requires Campaign format: CAROUSEL) — ALWAYS FLOW B, NO EXCEPTIONS. NEVER use POST/CREATE + CREATIVE/CREATE for carousel (causes LinkedIn type conflict):
    MEDIA/UPLOAD_IMAGE (×N, one per card) → CREATIVE/CREATE_INLINE (carousel_cards, commentary, campaign_id)
    carousel_cards format: array of { image_urn, title, landing_page }
    LinkedIn does NOT support carousel as an organic company page post.

  VIDEO AD (campaign type: SPONSORED_UPDATES, Requires Campaign format: SINGLE_VIDEO) — NEVER ask user for file size:
    Ask first: "Show on company page or dark post only?"
    Company page (FLOW A): MEDIA/UPLOAD_VIDEO (video_url) → POST/CREATE (feed_distribution=MAIN_FEED, video_urn) → CREATIVE/CREATE (post_urn)
    Dark post  (FLOW B): MEDIA/UPLOAD_VIDEO (video_url) → CREATIVE/CREATE_INLINE (video_urn, commentary, campaign_id)
    MEDIA/UPLOAD_VIDEO auto-downloads the video, measures its size, handles multipart upload, and returns video_urn.

  ARTICLE AD (campaign type: SPONSORED_UPDATES):
    POST/CREATE (article_url, article_title, article_description, optional thumbnail_urn) → CREATIVE/CREATE (post_urn)
    No media upload needed — LinkedIn fetches the article preview automatically.

  DOCUMENT AD (campaign type: SPONSORED_UPDATES):
    MEDIA/UPLOAD_DOCUMENT (document_url) → POST/CREATE (document_urn, title) → CREATIVE/CREATE_INLINE (commentary, campaign_id) OR CREATIVE/CREATE (post_urn)

  TEXT AD (campaign type: TEXT_AD):
    CREATIVE/CREATE (headline, description, landing_page, optional image_urn, campaign_id)
    No post creation needed — text ads are self-contained in the creative.

  MESSAGE AD (InMail, campaign type: SPONSORED_INMAILS):
    INMAIL/CREATE_CONTENT → CREATIVE/CREATE (inmail_content_urn, campaign_id)
    Optionally send a test: INMAIL/SEND_TEST (inmail_content_urn, recipient_email)
    sender is auto-resolved from the connected account — do NOT ask the user for it.

  CONVERSATION AD (branching message, campaign type: SPONSORED_INMAILS):
    CONVERSATION_AD/CREATE (name) → CONVERSATION_AD/CREATE_CONTENT (×N message nodes with buttons) → CONVERSATION_AD/SET_FIRST_CONTENT → CREATIVE/CREATE (inmail_content_urn=conversation_ad_urn, campaign_id)
    Each button can link to another message node (SEND_MESSAGE action) or a URL (OPEN_URL action).

  JOBS AD (campaign type: DYNAMIC, campaign format: JOBS):
    CREATIVE/CREATE_DYNAMIC (format=JOBS, headline, button_label, campaign_id)
    Campaign must use type=DYNAMIC. Do NOT set objectiveType — it is not supported for JOBS campaigns in LinkedIn API v202603+.

  SPOTLIGHT AD (campaign type: DYNAMIC):
    ⚠️ logo_urn is REQUIRED for SPOTLIGHT — LinkedIn mandates it if the company page has no logo. Upload first with MEDIA/UPLOAD_IMAGE.
    MEDIA/UPLOAD_IMAGE (logo image) → CREATIVE/CREATE_DYNAMIC (format=SPOTLIGHT, headline, call_to_action, landing_page, logo_urn, optional description/background_image_urn, campaign_id)

  FOLLOWER AD (campaign type: DYNAMIC):
    CREATIVE/CREATE_DYNAMIC (format=FOLLOW_COMPANY, headline, optional description/call_to_action, campaign_id)
    Uses LinkedIn pre-approved headline/CTA templates to match member profile.

  EVENT AD (campaign type: SPONSORED_UPDATES):
    POST/CREATE (event_urn from an existing LinkedIn Event) → CREATIVE/CREATE (post_urn, optional pre_event_registration_image)
    Or just CREATIVE/CREATE (post_urn=event_post_urn) if the event post already exists.

  VAST TAG VIDEO AD (third-party video, campaign type: SPONSORED_UPDATES):
    CREATIVE/CREATE (vast_tag_url, campaign_id) — no upload needed; video served by Innovid or approved vendor.

REQUIRED PARAMS PER ENTITY + ACTION:
  CAMPAIGN_GROUP CREATE: name, status (ACTIVE|DRAFT only — LinkedIn does NOT allow PAUSED on creation; if user wants paused, create as DRAFT then UPDATE to PAUSED), run_schedule_start (epoch ms — ask the user when the campaign group should start), totalBudget.amount + totalBudget.currencyCode
  CAMPAIGN CREATE: ⚠️ ALWAYS ask before creating: "What type of ads will run in this campaign?" Then set type accordingly:
    type: SPONSORED_UPDATES (image, video, carousel, article, document, event, VAST) | TEXT_AD | SPONSORED_INMAILS (message/conversation) | DYNAMIC (jobs, spotlight, follower)
    format: ⚠️ REQUIRED for DYNAMIC, VIDEO, and CAROUSEL ads.
      - If type=DYNAMIC: format=JOBS|SPOTLIGHT|FOLLOW_COMPANY
      - If type=SPONSORED_UPDATES for video ads: format=SINGLE_VIDEO
      - If type=SPONSORED_UPDATES for carousel ads: format=CAROUSEL
      - If type=SPONSORED_UPDATES for event ads: format=SPONSORED_UPDATE_EVENT
      - For single image / article / document: omit format (defaults to STANDARD_UPDATE).
    Campaign type is immutable after creation.
    Other required: name, status, campaignGroup (full URN), objectiveType (WEBSITE_VISIT|BRAND_AWARENESS|ENGAGEMENT|VIDEO_VIEWS|LEAD_GENERATION|WEBSITE_CONVERSIONS — omit entirely for DYNAMIC/JOBS campaigns), costType (CPM|CPC|CPV), unitCost, targeting_include (array)
    targeting_include format: array of { "facet_urn": "urn:li:adTargetingFacet:locations", "values": ["urn:li:geo:103644278"] }
    ALWAYS use targeting_include/targeting_exclude — never construct targetingCriteria manually
  CAMPAIGN UPDATE: campaign_id + fields to update
  CREATIVE LIST: params.campaign_id required
  CREATIVE CREATE: campaign_id + one of: post_urn (sponsored content/event/article/document), headline+description+landing_page (text ad), inmail_content_urn (message/conversation ad), vast_tag_url (VAST video). Optional: pre_event_registration_image (event ads).
  CREATIVE CREATE_INLINE: Dark post only. Required: campaign_id, commentary, image_urn OR video_urn OR document_urn OR carousel_cards.
  CREATIVE CREATE_DYNAMIC: campaign_id, format (JOBS|SPOTLIGHT|FOLLOW_COMPANY). JOBS needs headline+button_label. SPOTLIGHT needs headline+call_to_action+landing_page+logo_urn (logo_urn is REQUIRED — upload logo with MEDIA/UPLOAD_IMAGE first). FOLLOW_COMPANY needs headline.
  TARGETING SEARCH: facet (URN like urn:li:adTargetingFacet:locations), query (optional — omit for facets without typeahead like seniorities/industries)
    Common facets: locations, titles (job titles — NOT jobTitles), seniorities, industries, functions, staffCountRanges, memberInterests, skills
  TARGETING ESTIMATE_REACH: targeting_criteria (object)
  MEDIA UPLOAD_IMAGE: image_url (public URL). Returns image_urn.
  MEDIA UPLOAD_VIDEO: video_url (public URL). Auto-downloads, measures size, handles multipart upload. Returns video_urn. NEVER ask the user for file size.
  MEDIA UPLOAD_DOCUMENT: document_url (public URL to PDF/PPT/DOC). Returns document_urn.
  INMAIL CREATE_CONTENT: name, subject, htmlBody, callToActionText (max 20 chars), callToActionLandingPageUrl. Optional: salutationText, senderName, senderTitle, senderCompany. (sender auto-resolved — do NOT pass it)
  INMAIL SEND_TEST: inmail_content_urn, recipient_email
  CONVERSATION_AD CREATE: name
  CONVERSATION_AD CREATE_CONTENT: conversation_ad_urn, body (message text), buttons (array of { text, action: OPEN_URL|SEND_MESSAGE, url? }). Optional: subject, footer.
  CONVERSATION_AD SET_FIRST_CONTENT: conversation_ad_urn, first_content_urn

POST/CREATE params: commentary (text), feed_distribution (NONE=dark post|MAIN_FEED=company page). Media: image_urn | video_urn | document_urn | article_url+article_title+article_description+thumbnail_urn | carousel_cards.

BUDGET FORMAT: decimal string e.g. "10.00" = $10.00 (NOT micro-currency)
SCOPES REQUIRED: r_ads, rw_ads (r_ads_reporting for analytics)`,
    inputSchema: {
      type: 'object',
      properties: {
        entity_type: {
          type: 'string',
          enum: ['AD_ACCOUNT', 'CAMPAIGN_GROUP', 'CAMPAIGN', 'CREATIVE', 'POST', 'TARGETING', 'MEDIA', 'INMAIL', 'CONVERSATION_AD'],
          description: 'The LinkedIn Ads entity to operate on.'
        },
        action: {
          type: 'string',
          enum: ['LIST', 'CREATE', 'CREATE_INLINE', 'CREATE_DYNAMIC', 'UPDATE', 'LIST_FACETS', 'SEARCH', 'ESTIMATE_REACH', 'UPLOAD_IMAGE', 'UPLOAD_VIDEO', 'UPLOAD_DOCUMENT', 'INIT_VIDEO_UPLOAD', 'FINALIZE_VIDEO', 'CREATE_CONTENT', 'SEND_TEST', 'SET_FIRST_CONTENT'],
          description: 'The operation to perform. Must be valid for the chosen entity_type.'
        },
        account_id: {
          type: 'string',
          description: "LinkedIn Ads account ID. Obtain from list_connected_accounts(platform='linkedin_ads')."
        },
        params: {
          type: 'object',
          description: 'Action-specific parameters. See tool description for required fields per entity + action.',
          properties: {
            // Campaign Group / Campaign common
            name: { type: 'string', description: 'Entity name.' },
            status: { type: 'string', enum: ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DRAFT', 'CANCELED', 'COMPLETED'], description: 'Entity status.' },
            campaign_group_id: { type: 'string', description: 'Campaign Group numeric ID. Used for CAMPAIGN LIST.' },
            campaignGroup: { type: 'string', description: 'Campaign Group URN (urn:li:sponsoredCampaignGroup:ID). Required for CAMPAIGN CREATE.' },
            campaign_id: { type: 'string', description: 'Campaign ID. Required for CREATIVE LIST/CREATE and CAMPAIGN UPDATE.' },
            // Campaign
            objectiveType: { type: 'string', description: 'Campaign objective (WEBSITE_VISIT, BRAND_AWARENESS, ENGAGEMENT, VIDEO_VIEWS, LEAD_GENERATION, WEBSITE_CONVERSIONS). Omit entirely for DYNAMIC campaigns with format=JOBS.' },
            costType: { type: 'string', enum: ['CPM', 'CPC', 'CPV'], description: 'Bidding type.' },
            unitCost: { type: 'object', description: '{ amount: "10.00", currencyCode: "USD" }' },
            totalBudget: { type: 'object', description: '{ amount: "1000.00", currencyCode: "USD" }' },
            dailyBudget: { type: 'object', description: '{ amount: "50.00", currencyCode: "USD" }' },
            runSchedule: { type: 'object', description: '{ start: <epoch_ms>, end?: <epoch_ms> }' },
            targeting_include: {
              type: 'array',
              description: 'CAMPAIGN CREATE targeting (include). Each item: { facet_urn: string, values: string[] }. Use TARGETING SEARCH first to get value URNs.',
              items: {
                type: 'object',
                properties: {
                  facet_urn: { type: 'string' },
                  values: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            targeting_exclude: {
              type: 'array',
              description: 'CAMPAIGN CREATE targeting (exclude). Same format as targeting_include.',
              items: {
                type: 'object',
                properties: {
                  facet_urn: { type: 'string' },
                  values: { type: 'array', items: { type: 'string' } }
                }
              }
            },
            // Creative
            type: { type: 'string', enum: ['TEXT_AD', 'SPONSORED_UPDATES', 'SPONSORED_INMAILS', 'DYNAMIC'], description: 'Campaign/creative type.' },
            format: { type: 'string', description: 'Campaign or creative format. DYNAMIC campaigns: JOBS|SPOTLIGHT|FOLLOW_COMPANY. Event campaigns: SPONSORED_UPDATE_EVENT.' },
            reference: { type: 'string', description: 'Post URN for SPONSORED_UPDATES creatives.' },
            // Creative — text ad
            headline: { type: 'string', description: 'Text ad headline. Required for CREATIVE/CREATE text ads.' },
            description: { type: 'string', description: 'Text ad description.' },
            landing_page: { type: 'string', description: 'Landing page URL for text ads.' },
            // Creative — VAST Tag Video Ad
            vast_tag_url: { type: 'string', description: 'VAST tag URL for third-party video ads (e.g. from Innovid). Required for CREATIVE/CREATE VAST video.' },
            // Creative — Event Ad
            pre_event_registration_image: { type: 'string', description: 'Image URN for pre-event registration. Optional for event ad creatives.' },
            // Creative — Dynamic Ad (Jobs / Spotlight / Follower)
            button_label: { type: 'string', description: 'CTA button text for Jobs dynamic ads (CREATIVE/CREATE_DYNAMIC format=JOBS).' },
            call_to_action: { type: 'string', description: 'CTA text for Spotlight/Follower dynamic ads.' },
            background_image_urn: { type: 'string', description: 'Background image URN for Spotlight dynamic ads.' },
            logo_urn: { type: 'string', description: 'Logo image URN for Spotlight dynamic ads.' },
            // Post
            commentary: { type: 'string', description: 'Post text content.' },
            visibility: { type: 'string', enum: ['PUBLIC', 'CONNECTIONS', 'LOGGED_IN'], description: 'Post visibility.' },
            feed_distribution: { type: 'string', enum: ['NONE', 'MAIN_FEED'], description: 'NONE = dark post (ad only, not shown on company page). MAIN_FEED = visible on company page AND runs as sponsored ad.' },
            // Post — Article Ad
            article_url: { type: 'string', description: 'URL of the article to feature. Required for POST/CREATE article ads.' },
            article_title: { type: 'string', description: 'Article title override for article ads.' },
            article_description: { type: 'string', description: 'Article description override for article ads.' },
            thumbnail_urn: { type: 'string', description: 'Image URN to use as article thumbnail. Optional — LinkedIn auto-fetches if omitted.' },
            // Targeting search
            facet: { type: 'string', description: 'Targeting facet URN (e.g. urn:li:adTargetingFacet:locations).' },
            query: { type: 'string', description: 'Search query for TARGETING SEARCH.' },
            // Post media
            image_url: { type: 'string', description: 'Public URL of the image to upload. Required for MEDIA/UPLOAD_IMAGE.' },
            image_urn: { type: 'string', description: 'Image URN returned by MEDIA/UPLOAD_IMAGE. Use in CREATIVE/CREATE_INLINE or POST/CREATE.' },
            carousel_cards: {
              type: 'array',
              description: 'Carousel ad cards. Each: { image_urn, title, landing_page }.',
              items: {
                type: 'object',
                properties: {
                  image_urn: { type: 'string' },
                  title: { type: 'string' },
                  landing_page: { type: 'string' },
                }
              }
            },
            // Media upload — video
            video_url: { type: 'string', description: 'Public URL of the video file. Required for MEDIA/UPLOAD_VIDEO. File size is auto-detected — do NOT ask the user.' },
            video_urn: { type: 'string', description: 'Video URN returned by MEDIA/UPLOAD_VIDEO. Use in CREATIVE/CREATE_INLINE.' },
            file_size: { type: 'number', description: 'Video file size in bytes. Required for MEDIA/INIT_VIDEO_UPLOAD only (legacy — prefer UPLOAD_VIDEO instead).' },
            // Media upload — document
            document_url: { type: 'string', description: 'Public URL of the document (PDF, PPT, DOC). Required for MEDIA/UPLOAD_DOCUMENT.' },
            document_urn: { type: 'string', description: 'Document URN returned by MEDIA/UPLOAD_DOCUMENT. Use in POST/CREATE for document ads.' },
            // InMail / Message Ad
            subject: { type: 'string', description: 'InMail subject line.' },
            htmlBody: { type: 'string', description: 'InMail body content (HTML allowed).' },
            callToActionText: { type: 'string', description: 'CTA button text (max 20 characters).' },
            callToActionLandingPageUrl: { type: 'string', description: 'URL the CTA button links to.' },
            salutationText: { type: 'string', description: 'Optional salutation (e.g. "Hi %FIRSTNAME%,").' },
            senderName: { type: 'string', description: 'Optional display name for the sender.' },
            senderTitle: { type: 'string', description: 'Optional job title of the sender.' },
            senderCompany: { type: 'string', description: 'Optional company name of the sender.' },
            inmail_content_urn: { type: 'string', description: 'InMail content URN (INMAIL/CREATE_CONTENT result). Use in CREATIVE/CREATE.' },
            recipient_email: { type: 'string', description: 'Email address to send test InMail to. Required for INMAIL/SEND_TEST.' },
            // Conversation Ad
            conversation_ad_urn: { type: 'string', description: 'Conversation Ad URN from CONVERSATION_AD/CREATE. Used in CREATE_CONTENT and SET_FIRST_CONTENT.' },
            body: { type: 'string', description: 'Message body text for CONVERSATION_AD/CREATE_CONTENT.' },
            footer: { type: 'string', description: 'Optional footer text for conversation ad messages.' },
            buttons: {
              type: 'array',
              description: 'CTA buttons for CONVERSATION_AD/CREATE_CONTENT. Each: { text, action: OPEN_URL|SEND_MESSAGE, url? }.',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  action: { type: 'string', enum: ['OPEN_URL', 'SEND_MESSAGE'] },
                  url: { type: 'string' },
                }
              }
            },
            first_content_urn: { type: 'string', description: 'First message node URN. Required for CONVERSATION_AD/SET_FIRST_CONTENT.' },
          }
        }
      },
      required: ['entity_type', 'action', 'account_id']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callLinkedInMarketingApi(
      context?.userId,
      args.entity_type,
      args.action,
      args.account_id,
      args.params,
    );
  }
});

emmaToolRegistry.register({
  name: 'call_linkedin_ads_insights_api',
  definition: {
    name: 'call_linkedin_ads_insights_api',
    description: `Fetch LinkedIn Ads performance analytics (impressions, clicks, spend, conversions, etc.).
Analytics are synchronous — results return immediately, no polling needed.

INTERNAL TERMINOLOGY MAPPING (never mention API names in responses):
  User says "campaign"  →  use pivot = CAMPAIGN_GROUP
  User says "ad set"    →  use pivot = CAMPAIGN
  User says "ad"        →  use pivot = CREATIVE
The words CAMPAIGN_GROUP, CAMPAIGN, CREATIVE must NEVER appear in your response to the user. These are internal API values only.
Always say "Campaign", "Ad Set", "Ad" — nothing else.
FORBIDDEN (never say these): "campaign group", "creative", "ad set (campaign)", "ads (creatives)", "campaigns (campaign groups)"

PIVOT OPTIONS:
  CAMPAIGN_GROUP, CAMPAIGN, CREATIVE, COMPANY, ACCOUNT, MEMBER_COMPANY_SIZE,
  MEMBER_INDUSTRY, MEMBER_SENIORITY, MEMBER_JOB_FUNCTION, MEMBER_COUNTRY_V2,
  MEMBER_REGION_V2, PLACEMENT_NAME, IMPRESSION_DEVICE_TYPE

TIME_GRANULARITY: ALL (totals only), DAILY, MONTHLY, YEARLY

COMMON FIELDS: impressions, clicks, costInLocalCurrency, totalEngagements, videoViews,
  videoCompletions, leadGenerationMailContactInfoShares, oneClickLeads`,
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: "LinkedIn Ads account ID from list_connected_accounts(platform='linkedin_ads')."
        },
        pivot: {
          type: 'string',
          description: 'Dimension to group results by (e.g. CAMPAIGN, CREATIVE, MEMBER_COUNTRY_V2).'
        },
        dateRange: {
          type: 'object',
          description: 'Date range. { start: { year, month, day }, end: { year, month, day } }',
          properties: {
            start: { type: 'object', properties: { year: { type: 'number' }, month: { type: 'number' }, day: { type: 'number' } }, required: ['year', 'month', 'day'] },
            end: { type: 'object', properties: { year: { type: 'number' }, month: { type: 'number' }, day: { type: 'number' } }, required: ['year', 'month', 'day'] }
          },
          required: ['start', 'end']
        },
        timeGranularity: {
          type: 'string',
          enum: ['ALL', 'DAILY', 'MONTHLY', 'YEARLY'],
          description: 'Time aggregation. Default: ALL (totals only).'
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Metrics to return. Common: impressions, clicks, costInLocalCurrency, totalEngagements.'
        },
        campaign_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of campaign group URNs (or numeric IDs) to filter by. Use this to get insights for a specific user-facing "Campaign".'
        },
        campaigns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of campaign URNs (or numeric IDs) to filter by. Use this to get insights for a specific user-facing "Ad Set".'
        },
        creatives: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of creative URNs (or numeric IDs) to filter by. Use this to get insights for a specific user-facing "Ad".'
        }
      },
      required: ['account_id', 'pivot', 'dateRange']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.callLinkedInAdsInsightsApi(
      context?.userId,
      args.account_id,
      {
        pivot: args.pivot,
        dateRange: args.dateRange,
        timeGranularity: args.timeGranularity,
        fields: args.fields,
        campaign_groups: args.campaign_groups,
        campaigns: args.campaigns,
        creatives: args.creatives,
      }
    );
  }
});

emmaToolRegistry.register({
  name: 'get_post_analytics',
  definition: {
    name: 'get_post_analytics',
    description: 'Get detailed analytics for specific posts from a connected social media account. Returns engagement metrics including likes, comments, shares, impressions, and clicks.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'The connected account ID (must belong to the authenticated user)'
        },
        post_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of post IDs to fetch analytics for (e.g., LinkedIn URNs like "urn:li:share:123")'
        }
      },
      required: ['account_id', 'post_ids']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.getPostAnalytics(context?.userId, args.account_id, args.post_ids);
  }
}
);

emmaToolRegistry.register({
  name: 'read_brand_guidelines',
  definition: {
    name: 'read_brand_guidelines',
    description: 'Read the current user\'s brand guidelines (brand data and attachments). Returns exists=false if not set.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.readBrandGuidelines(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_brand_guidelines',
  definition: {
    name: 'update_brand_guidelines',
    description: 'Update the user\'s brand guidelines. IMPORTANT: Use read_brand_guidelines first to fetch the latest data, then only update the fields that need to be changed. Can update both brand data and brand assets (logos, brand guides, etc.). NOTE: SVG files are NOT allowed for logo or secondaryLogo uploads. If the user provides an SVG file, ask them to convert it to PNG or another raster format first.',
    inputSchema: {
      type: 'object',
      properties: {
        brandData: {
          type: 'object',
          description: 'Brand data object with only the fields that need to be updated',
          properties: {
            brandName: { type: 'string', description: 'Brand name' },
            tagline: { type: 'string', description: 'Brand tagline or slogan' },
            domain: { type: 'string', description: 'Website domain (e.g. example.com)' },
            primaryColor: { type: 'string', description: 'Primary brand color (hex code)' },
            primaryColorEnd: { type: 'string', description: 'End color for gradient (hex code)' },
            secondaryColor: { type: 'string', description: 'Secondary brand color (hex code)' },
            fontFamily: { type: 'string', description: 'Primary font family' },
            toneOfVoice: { type: 'string', description: 'Brand tone of voice' },
            brandPersonality: { type: 'string', description: 'Brand personality description' },
            targetAudience: { type: 'string', description: 'Target audience description' },
            valueProposition: { type: 'string', description: 'Brand-level value proposition — single most compelling promise the company makes to its customers, in one sentence. Used as the seed for the onboarding value-prop review screen.' },
            logoUrl: { type: 'string', description: 'Direct URL to the brand logo as discovered on the company website (e.g. https://example.com/logo.svg). Used by the onboarding review screens and downstream creative/ad surfaces.' },
            keyMessages: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of key brand messages'
            },
            brandValues: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of brand values'
            },
            isGradient: { type: 'boolean', description: 'Whether primary color uses gradient' },
            founders: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: 'Founder name' },
                  jobTitle: { type: 'string', description: 'Founder job title' },
                  styleTone: { type: 'string', description: 'Founder communication style and tone' },
                  signaturePosts: { type: 'string', description: 'Notable posts or content the founder is known for' },
                  voiceExamples: { type: 'string', description: 'Actual post examples (verbatim) written by or for this founder. Emma uses these as a direct style reference when generating LinkedIn and social posts — paste 2–3 real posts separated by blank lines.' }
                },
                required: ['name']
              },
              description: 'Array of founder profiles'
            }
          }
        },
        brandAssets: {
          type: 'array',
          description: 'Brand assets to update (logos, brand guides, etc.) - array of asset objects with type, url, filename',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['logo', 'secondaryLogo', 'brandGuide', 'additionalAsset'], description: 'Type of brand asset' },
              url: { type: 'string', description: 'URL of the brand asset' },
              filename: { type: 'string', description: 'Original filename of the brand asset' }
            }
          }
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.updateBrandGuidelines(args, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'read_market_strategy',
  definition: {
    name: 'read_market_strategy',
    description: 'Read the current user\'s market strategy (business overview, competitors, and ideal customer profiles). Returns exists=false if not set.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.readMarketStrategy(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_market_strategy',
  definition: {
    name: 'update_market_strategy',
    description: 'Update the user\'s market strategy. IMPORTANT: Use read_market_strategy first to fetch the latest data, then only update the fields that need to be changed. Can update business overview, competitors, and ideal customer profiles.',
    inputSchema: {
      type: 'object',
      properties: {
        businessOverview: {
          type: 'string',
          description: 'Comprehensive business overview including mission, vision, and value propositions'
        },
        competitors: {
          type: 'array',
          description: 'Array of competitor objects with name and description',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Competitor name' },
              description: { type: 'string', description: 'Competitor description or analysis' }
            },
            required: ['name']
          }
        },
        icp: {
          type: 'array',
          description: 'Array of Ideal Customer Profile objects with title, description, value proposition, and buyer personas',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'ICP title or name' },
              description: { type: 'string', description: 'ICP description or characteristics' },
              valueProposition: { type: 'string', description: 'Value proposition for this customer type' },
              buyerPersonas: { type: 'array', description: 'List of buyer personas for this customer type', items: { type: 'string' } }
            },
            required: ['title']
          }
        }
      },
      required: []
    }
  },
  execute: async (args, context) => {
    return await agentModeService.updateMarketStrategy(args, context?.userId);
  }
});

const visualContextTool = {
  name: 'get_visual_context',
  definition: {
    name: 'get_visual_context',
    description: 'Request a screenshot of the current page to understand visual layout, colors, design elements, UI structure. Use when the user asks about visual aspects, colors, design, or when you need to see the page to answer accurately.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Why you need the screenshot'
        }
      },
      required: []
    }
  },
  execute: async (args: any) => {
    return {
      needs_screenshot: true,
      reason: args.reason || 'Visual context requested',
      message: 'Screenshot will be captured from the browser and included in the next message.'
    };
  }
};

emmaToolRegistry.register(visualContextTool);


emmaToolRegistry.register({
  name: 'perform_deep_research',
  definition: {
    name: 'perform_deep_research',
    description: 'Perform comprehensive deep research on any topic using Gemini Deep Research. Uploads the research content to S3 and returns a URL to the markdown file. Use this for whitepapers, reports, executive summaries, or research documents. NOT for blog articles - use create_blog_article with deep_research=true instead. Takes several minutes to complete. The response includes research_url (S3 URL), title, summary, and word_count.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'The main topic or subject to research'
        },
        prompt: {
          type: 'string',
          description: 'Additional instructions for the research (e.g., "Include executive summary", "Focus on competitive analysis", "Structure as a whitepaper")'
        },
        tone: {
          type: 'string',
          description: 'The tone of the research output',
          enum: ['professional', 'casual', 'technical', 'executive'],
          default: 'professional'
        },
        depth: {
          type: 'string',
          description: 'How thorough the research should be. "overview" for 1-2 pages, "detailed" for 3-5 pages, "comprehensive" for 5-10 pages.',
          enum: ['overview', 'detailed', 'comprehensive'],
          default: 'detailed'
        },
        focus_areas: {
          type: 'array',
          items: { type: 'string' },
          description: 'Specific areas to focus on in the research (e.g., ["market trends", "competitor analysis", "implementation strategies"])'
        }
      },
      required: ['topic']
    }
  },
  execute: async (args, context) => {
    return await agentModeService.performDeepResearchTool(
      args.topic,
      args.prompt,
      args.tone || 'professional',
      args.depth || 'detailed',
      args.focus_areas,
      context?.userId
    );
  }
});

// --- Tools from contentTools.ts ---
emmaToolRegistry.register({
  name: 'list_books',
  definition: {
    name: 'list_books',
    description: 'List all books and white papers for the current user. Returns a list of books with their IDs, titles, types, authors, status, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['book', 'whitepaper'],
          description: 'Optional filter by type: "book" or "whitepaper". If not provided, returns all types.'
        },
        status: {
          type: 'string',
          enum: ['draft', 'published', 'archived'],
          description: 'Optional filter by status: "draft", "published", or "archived". If not provided, returns all statuses.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listBooks(context?.userId, args.type, args.status);
  }
});

emmaToolRegistry.register({
  name: 'get_book_details',
  definition: {
    name: 'get_book_details',
    description: 'Get detailed information about a specific book or white paper including its outline (sections and chapters structure), characters (for books), and other metadata. Returns book metadata, characters, and the complete outline hierarchy.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to retrieve'
        }
      },
      required: ['book_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getBookDetails(args.book_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_book_content',
  definition: {
    name: 'get_book_content',
    description: 'Get the markdown content for a specific section or chapter in a book. If chapter_id is provided, returns chapter content. Otherwise, returns section content.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, returns chapter content. If not provided, returns section content.'
        }
      },
      required: ['book_id', 'section_id']
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.getBookContent(args.book_id, args.section_id, args.chapter_id, context?.userId);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

emmaToolRegistry.register({
  name: 'update_book_content',
  definition: {
    name: 'update_book_content',
    description: 'Update the markdown content for a specific section or chapter in a book using partial replacements. This function performs partial content updates only. For generating full content, use generate_book_content instead. IMPORTANT: Always use get_book_content first to retrieve the current content, then provide the exact old_content to replace. Note: Full content replacement will not work if the current content is empty - use generate_book_content to create new content instead.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, updates chapter content. If not provided, updates section content.'
        },
        replacement_json: {
          type: 'string',
          description: 'JSON string containing a list of replacement instructions: [{"old_content": "## Old Heading\\n\\nOld text...", "new_content": "## New Heading\\n\\nNew text...", "expected_count": 1}]. Use empty string for new_content to delete the specified content.'
        }
      },
      required: ['book_id', 'section_id', 'replacement_json']
    }
  },
  execute: async (args: any, context?: any) => {
    // Parse replacement_json
    let bookReplacementInstructions = [];
    try {
      if (args.replacement_json) {
        bookReplacementInstructions = JSON.parse(args.replacement_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in replacement_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
    return await agentModeService.updateBookContent(
      args.book_id,
      args.section_id,
      args.chapter_id,
      bookReplacementInstructions,
      context?.userId
    );
  }
});

emmaToolRegistry.register({
  name: 'generate_book_content',
  definition: {
    name: 'generate_book_content',
    description: 'Generate content for a book section/chapter. For BOOKS: short (1000-2000 words), medium (2000-3000 words), long (3000-4000 words). For WHITEPAPERS: short (300-600 words, ~1 page), medium (600-1000 words, ~2 pages), long (1000-1500 words, ~3 pages). IMPORTANT for whitepapers: Pass the relevant deep research content in content_description - the AI will reformat it for that section rather than generating new content. If existing content exists, it will be used as a base.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book'
        },
        section_id: {
          type: 'string',
          description: 'The unique identifier (sectionId) of the section'
        },
        chapter_id: {
          type: 'string',
          description: 'Optional: The unique identifier (chapterId) of the chapter. If provided, generates chapter content. If not provided, generates section content.'
        },
        content_description: {
          type: 'string',
          description: 'Detailed description of what content should be generated for this section or chapter. Be as detailed as possible about the topics, themes, key points, and structure that should be included. IMPORTANT: Content from other sections of the book is not available to this function, so any relevant context, information, or details from other sections that should be referenced or built upon must be explicitly included in this description.'
        },
        length: {
          type: 'string',
          enum: ['short', 'medium', 'long'],
          description: 'Desired length of the content: short (1000-2000 words), medium (2000-3000 words), long (3000-4000 words)',
          default: 'medium'
        },
        imagine: {
          type: 'boolean',
          description: 'Whether to allow creative imagination and details that do not exist. Defaults to true. When false, the AI will stick strictly to facts and avoid inventing details.',
          default: true
        },
        research_url: {
          type: 'string',
          description: 'Optional S3 URL to deep research content (from perform_deep_research). For WHITEPAPERS: pass the research_url here instead of copying full content into content_description. The function will fetch the research and use it as context. When using this, content_description should focus on section-specific instructions (e.g., "Write the Executive Summary focusing on key strategic implications").'
        }
      },
      required: ['book_id', 'section_id', 'chapter_id', 'content_description']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateBookContent(
      args.book_id,
      args.section_id,
      args.chapter_id,
      args.content_description,
      args.length || 'medium',
      args.imagine !== undefined ? args.imagine : true,
      context?.userId,
      args.research_url,
      context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'create_book',
  definition: {
    name: 'create_book',
    description: 'Create a new book or white paper with metadata. Returns the created book with bookId for use in other operations.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the book or white paper'
        },
        description: {
          type: 'string',
          description: 'Description or summary of the book'
        },
        type: {
          type: 'string',
          enum: ['book', 'whitepaper'],
          description: 'Type: "book" or "whitepaper"'
        },
        author: {
          type: 'string',
          description: 'Author name'
        },
        language: {
          type: 'string',
          description: 'Language of the book (e.g., "English", "中文")',
          default: 'English'
        },
        genre: {
          type: 'string',
          description: 'Genre of the book (only applicable when type is "book"). Can be one of the predefined genres (Fiction, Non-Fiction, Science Fiction, Fantasy, Mystery, Thriller, Romance, Horror, Biography, Autobiography, History, Self-Help, Business, Technology, Science, Philosophy, Religion, Health & Fitness, Travel, Cooking, Art, Music, Poetry, Drama, Comedy, Education, Reference, Children\'s, Young Adult, Other) or a custom genre string. If not provided and type is "book", defaults to "Other".'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of tags for categorization',
          default: []
        }
      },
      required: ['title', 'description', 'type', 'author']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBook(args.title, args.description, args.type, args.author, args.language, args.genre, args.tags || [], context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_book_outline',
  definition: {
    name: 'create_book_outline',
    description: 'Create the complete outline structure (sections and chapters) for a book. This replaces any existing outline. Each section can have multiple chapters. Sections and chapters will be ordered by their order field.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to create outline for'
        },
        outline_json: {
          type: 'string',
          description: 'JSON string containing the outline structure: [{"title": "Section Title", "description": "Optional section description", "order": 1, "chapters": [{"title": "Chapter Title", "description": "Optional chapter description", "order": 1}]}]'
        }
      },
      required: ['book_id', 'outline_json']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBookOutline(args.book_id, args.outline_json, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'add_characters',
  definition: {
    name: 'add_characters',
    description: 'Add one or more characters to a book. Each character must have a name and description. Characters are appended to the existing list of characters for the book.',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: {
          type: 'string',
          description: 'The unique identifier (bookId) of the book to add characters to'
        },
        characters_json: {
          type: 'string',
          description: 'JSON string containing an array of characters: [{"name": "Character Name", "description": "Character description"}]'
        }
      },
      required: ['book_id', 'characters_json']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addCharacters(args.book_id, args.characters_json, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_blog_article',
  definition: {
    name: 'create_blog_article',
    description: 'Create a blog article intended for CMS publishing (Basehub, Webflow, etc.). Generates article content, a hero image, and a blog-styled HTML file. Use ONLY for blog posts — NOT for reports, summaries, analyses, audits, or other documents. For non-blog HTML documents, use create_html_file instead.',
    inputSchema: {
      type: 'object',
      properties: {
        title_draft: {
          type: 'string',
          description: 'A draft title for the blog article. The final title will be generated and optimized from this draft.'
        },
        content_draft: {
          type: 'string',
          description: 'The blog article content in markdown format'
        },
        length: {
          type: 'string',
          description: 'The desired length of the article',
          enum: ['short', 'medium', 'long'],
          default: 'medium'
        },
        researchContext: {
          type: 'string',
          description: 'Optional research context or background information to include in the article',
          default: ''
        },
        requirements: {
          type: 'string',
          description: 'Specific requirements for the blog article (e.g., internal links, CTAs, branding guidelines)',
          default: ''
        },
        style: {
          type: 'string',
          description: 'The writing style of the blog article. Use "substack" for a personal, newsletter-like writing style with first-person perspective, engaging hooks, and conversational tone. Use "default" for standard blog post style.',
          enum: ['default', 'substack'],
          default: 'default'
        },
        deep_research: {
          type: 'boolean',
          description: 'When true, performs Gemini Deep Research for comprehensive information and includes 3-5 inline images. When false, uses standard content generation with hero image only. Takes several minutes when enabled.',
          default: false
        }
      },
      required: ['title_draft', 'content_draft']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createBlogArticle(
      args.title_draft,
      args.content_draft,
      args.length || 'medium',
      args.researchContext || '',
      args.requirements || '',
      context?.userId,
      context?.sessionId,
      args.style || 'default',
      args.deep_research || false
    );
  }
});

emmaToolRegistry.register({
  name: 'publish_blog_article',
  definition: {
    name: 'publish_blog_article',
    description: 'Publish a blog article to CMS (Basehub or Webflow) based on the user\'s configured CMS type. Takes the title, description, hero image URL, and blog HTML URL from a previously created blog article (via create_blog_article), extracts the HTML body content, then publishes to the appropriate CMS. Articles are published as draft by default unless status is set to "published". IMPORTANT: When status is "published", at least one category must be provided. CRITICAL: Always review the article content with the user and get explicit approval before publishing, especially when status is "published" for live publication.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the blog article'
        },
        description: {
          type: 'string',
          description: 'The description/meta description of the blog article'
        },
        hero_image_url: {
          type: 'string',
          description: 'The URL of the hero image for the blog article'
        },
        blog_html_url: {
          type: 'string',
          description: 'The URL of the HTML file created by create_blog_article function'
        },
        status: {
          type: 'string',
          description: 'Publication status of the article. Default is "draft". Set to "published" to publish immediately.',
          enum: ['draft', 'published'],
          default: 'draft'
        },
        author: {
          type: 'string',
          description: 'Optional author name or ID for the article'
        },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional array of category names. Category names will be mapped to Webflow IDs using the "categories" mapping in secrets manager. Maps to multi-reference field "categories" by default. Defaults to empty array. REQUIRED when status is "published" - must provide at least one category.',
          default: []
        }
      },
      required: ['title', 'description', 'hero_image_url', 'blog_html_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.publishBlogArticle(
      args.title,
      args.description,
      args.hero_image_url,
      args.blog_html_url,
      context?.userId,
      context?.sessionId,
      args.status,
      args.author,
      args.categories
    );
  }
});

emmaToolRegistry.register({
  name: 'list_cms_categories',
  definition: {
    name: 'list_cms_categories',
    description: 'List the available CMS categories for the current user. Returns category names configured in the user\'s Webflow CMS settings. Use this to discover valid category values before calling publish_blog_article.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (_args: any, context?: any) => {
    const userId = context?.userId;
    if (!userId) {
      return { success: false, message: 'User context required' };
    }
    try {
      const { userDb } = await import('../services/db');
      const user = await userDb.getUserById(userId);
      const cmsType = user?.cmsType;

      if (cmsType === 'Webflow') {
        const { getWebflowConfig } = await import('../controllers/blog');
        const config = await getWebflowConfig(userId);
        const categoryNames = config.categories ? Object.keys(config.categories) : [];
        return { success: true, cmsType, categories: categoryNames };
      }

      if (cmsType === 'WordPress') {
        const { getWordPressConfig } = await import('../controllers/blog');
        const config = await getWordPressConfig(userId);
        const categoryNames = config.categories ? Object.keys(config.categories) : [];
        return { success: true, cmsType, categories: categoryNames };
      }

      return { success: true, cmsType: cmsType || null, categories: [] };
    } catch (error: any) {
      return { success: false, message: 'Failed to fetch CMS categories', error: error.message };
    }
  }
});

emmaToolRegistry.register({
  name: 'repair_blog_article',
  definition: {
    name: 'repair_blog_article',
    description: 'Repairs a blog article by creating a new version with optimized images. Automatically finds and resizes all images (including hero images with class="hero-image") that exceed file size limits. Creates a new HTML file with updated image URLs without modifying the original. Call this function when publish_blog_article fails due to image size errors. Returns a new article URL and hero image URL that can be used to retry publishing.',
    inputSchema: {
      type: 'object',
      properties: {
        article_url: {
          type: 'string',
          description: 'The URL of the HTML file created by create_blog_article function'
        }
      },
      required: ['article_url']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.repairBlogArticle(
      args.article_url,
      context?.userId,
      context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'create_social_media_posts',
  definition: {
    name: 'create_social_media_posts',
    description: 'Create a list of social media posts and generate an HTML file containing all posts. Each post includes type (linkedin, x/twitter, instagram, facebook, or custom), rich text content that can be transformed to HTML for display and copied for use, and optional image URL. The output is an HTML file stored in S3 with all posts formatted for easy viewing and copying.',
    inputSchema: {
      type: 'object',
      properties: {
        posts: {
          type: 'array',
          description: 'Array of social media posts to create',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['linkedin', 'x/twitter', 'instagram', 'facebook', 'custom'],
                description: 'The social media platform type for this post'
              },
              content: {
                type: 'string',
                description: 'Rich text content for the post. IMPORTANT: Do not include image URLs in the content text as the format will not look good. Use the image_url parameter separately for images. CRITICAL FOR LINKEDIN POSTS: LinkedIn does NOT support markdown rendering. Never use markdown syntax like **bold**, *italic*, - bullet lists, [links](url), or # headings. Instead use LinkedIn-native plain text formatting: line breaks for structure, unicode bullets (•) or dashes (—) for lists, UPPERCASE or emojis for emphasis, and paste full URLs directly (LinkedIn auto-links them). Markdown will appear as raw text and look unprofessional.'
              },
              image_url: {
                type: 'string',
                description: 'Optional image URL for posts that include images'
              }
            },
            required: ['type', 'content']
          }
        }
      },
      required: ['posts']
    }
  },
  execute: async (args: any, context?: any) => {
    // Note: The backend createSocialMediaPosts currently expects an array of posts.
    // If the tool is supposed to generate them first, we might need a middle layer.
    // For now, mirroring the existing (buggy?) behavior but ensuring we pass sessionId.
    return await agentModeService.createSocialMediaPosts(args.posts, context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'list_html_templates',
  definition: {
    name: 'list_html_templates',
    description: "Get a list of all available HTML templates for the user (email and/or landing page templates). Use the optional 'type' filter to narrow results. IMPORTANT: If multiple templates share the same template_name, ask the user to choose which one to use and confirm by template_id (or by created_at/updated_at and isPublic if needed).",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: "Filter by template type: 'email' or 'landing_page'. Omit to list all templates."
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listHtmlTemplates(context?.userId, args.type);
  }
});

emmaToolRegistry.register({
  name: 'create_html_from_template',
  definition: {
    name: 'create_html_from_template',
    description: 'Create final HTML from a template by providing variable values and array variable values as JSON strings, then upload to S3. If the user refers to a template by name and multiple templates share that name, you MUST ask which template_id to use before calling this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description: 'ID of the HTML template to use (from list_html_templates)'
        },
        variable_values_json: {
          type: 'string',
          description: 'JSON string containing regular variable values where keys are variable names and values are the actual values. Example: {"title": "Hello", "company_name": "Acme Corp"}'
        },
        array_variable_values_json: {
          type: 'string',
          description: 'JSON string containing array variable values where keys are array variable names and values are arrays of strings. If there is no data for an array variable, provide an empty array for that variable. Example: {"features_n": ["Feature 1", "Feature 2"], "links_n": []} for when links_n has no data.'
        }
      },
      required: ['template_id', 'variable_values_json', 'array_variable_values_json']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!args.template_id) {
      return {
        success: false,
        message: 'template_id is required'
      };
    }

    // Parse JSON strings
    let variableValues = {};
    let arrayVariableValues = {};

    try {
      if (args.variable_values_json) {
        variableValues = JSON.parse(args.variable_values_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in variable_values_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    try {
      if (args.array_variable_values_json) {
        arrayVariableValues = JSON.parse(args.array_variable_values_json);
      }
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in array_variable_values_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return await agentModeService.createHtmlFromTemplate(context?.llmModel, args.template_id, variableValues, arrayVariableValues, context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'update_html_file',
  definition: {
    name: 'update_html_file',
    description: 'Update an HTML file using CSS selectors to target elements (preferred), or full file replacement with hash verification. ' +
      'CSS mode (update_type="css"): Use CSS selectors to precisely target and modify HTML elements without needing to reproduce exact content. ' +
      'jQuery-style selectors are supported: use :eq(n) (0-indexed) to select by position within matched set (e.g. ".step-block:eq(1)" for the 2nd .step-block), ' +
      ':contains("text") to match by text content (e.g. "h3:contains(\\"Step 2\\")"), and :has() for parent matching. ' +
      'IMPORTANT: Do NOT use :nth-of-type or :nth-child to target elements by class — these count by element type, not class. Use :eq(n) instead. ' +
      'Operations that fail (no selector match) are skipped and reported; successful operations still apply. ' +
      'Full mode (update_type="full"): Replace entire file content using hash verification.',
    inputSchema: {
      type: 'object',
      properties: {
        file_url: {
          type: 'string',
          description: 'URL of the HTML file to update (S3 URL)'
        },
        update_type: {
          type: 'string',
          enum: ['css', 'full'],
          description: 'Type of update: "css" (recommended) for CSS-selector-based editing, "full" for entire file replacement with hash'
        },
        operations_json: {
          type: 'string',
          description: 'JSON string containing operations. ' +
            'For CSS mode: [{"action": "remove", "selector": ".card[data-id=\\"123\\"]"}, ' +
            '{"action": "replace", "selector": "h1.title", "html": "<h1 class=\\"title\\">New Title</h1>"}, ' +
            '{"action": "replaceInner", "selector": ".bio", "html": "New bio text"}, ' +
            '{"action": "append", "selector": "#grid", "html": "<div>New item</div>"}, ' +
            '{"action": "prepend", "selector": "#grid", "html": "<div>First item</div>"}, ' +
            '{"action": "insertBefore", "selector": ".item:last-child", "html": "<div>Before last</div>"}, ' +
            '{"action": "insertAfter", "selector": ".item:first-child", "html": "<div>After first</div>"}, ' +
            '{"action": "setAttribute", "selector": "img.hero", "attribute": "src", "value": "new.jpg"}, ' +
            '{"action": "removeAttribute", "selector": "a", "attribute": "target"}]. ' +
            'For full mode: [{"old_content_hash": "abc123...", "new_content": "<!DOCTYPE html>...", "expected_count": 1}]'
        }
      },
      required: ['file_url', 'update_type', 'operations_json']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!args.file_url) {
      return { success: false, message: 'file_url is required' };
    }
    if (!args.update_type) {
      return { success: false, message: 'update_type is required' };
    }

    // Accept both operations_json (new) and replacement_json (legacy) parameter names
    const jsonStr = args.operations_json || args.replacement_json;
    if (!jsonStr) {
      return { success: false, message: 'operations_json is required' };
    }

    let operations;
    try {
      operations = JSON.parse(jsonStr);
    } catch (error) {
      return {
        success: false,
        message: 'Invalid JSON in operations_json',
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }

    return await agentModeService.updateHtmlFile(args.file_url, args.update_type, operations, context?.userId, context?.sessionId);
  }
});

// --- Tools from leadGtmTools.ts ---
emmaToolRegistry.register({
  name: 'list_gtm_plans',
  definition: {
    name: 'list_gtm_plans',
    description: 'List all Go-To-Market (GTM) plans for the current user. Returns a list of plans with their IDs, titles, descriptions, phase counts, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listGTMPlans(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'read_gtm_plan',
  definition: {
    name: 'read_gtm_plan',
    description: 'Read a specific GTM plan by its plan ID. Returns the complete plan details including all phases and work items with their statuses, durations, and completion times.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan to read'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.readGTMPlan(args.plan_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_gtm_plan',
  definition: {
    name: 'create_gtm_plan',
    description: 'Create a new Go-To-Market (GTM) plan with a title, optional description, optional DRI (Directly Responsible Individual) email, and optional phases with work items. Each phase can have multiple work items. DRI can be specified at plan level, phase level, or item level. Returns the created plan with its unique identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'The title of the GTM plan (e.g., "Q1 2024 Launch Plan")'
        },
        description: {
          type: 'string',
          description: 'Optional description of the GTM plan'
        },
        dri: {
          type: 'string',
          description: 'Optional DRI (Directly Responsible Individual) email address at the plan level'
        },
        phases: {
          type: 'array',
          description: 'Optional array of phases to include in the plan. Each phase should have a title, description, duration (in days), optional DRI email, and workItems array.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'The title of the phase (e.g., "Pre-Launch", "Launch", "Post-Launch")'
              },
              description: {
                type: 'string',
                description: 'Optional description of the phase'
              },
              duration: {
                type: 'number',
                description: 'Duration of the phase in days'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI (Directly Responsible Individual) email address at the phase level'
              },
              workItems: {
                type: 'array',
                description: 'Array of work items for this phase',
                items: {
                  type: 'object',
                  properties: {
                    title: {
                      type: 'string',
                      description: 'Title of the work item'
                    },
                    description: {
                      type: 'string',
                      description: 'Optional description of the work item'
                    },
                    duration: {
                      type: 'number',
                      description: 'Optional duration of the work item in days'
                    },
                    dri: {
                      type: 'string',
                      description: 'Optional DRI (Directly Responsible Individual) email address at the work item level'
                    }
                  },
                  required: ['title']
                }
              }
            },
            required: ['title', 'duration']
          }
        }
      },
      required: ['title']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createGTMPlan(
      args.title, args.description || '', args.dri || undefined, args.phases || [], context?.userId, context?.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'update_gtm_plan',
  definition: {
    name: 'update_gtm_plan',
    description: 'Update a GTM plan\'s title, description, DRI (Directly Responsible Individual), or due date. Only provided fields will be updated.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan to update'
        },
        title: {
          type: 'string',
          description: 'New title for the plan'
        },
        description: {
          type: 'string',
          description: 'New description for the plan'
        },
        dri: {
          type: 'string',
          description: 'New DRI (Directly Responsible Individual) email address. Pass empty string to remove.'
        },
        due_date: {
          type: 'string',
          description: 'New due date for the plan (ISO date string). Pass empty string to remove.'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateGTMPlan(args.plan_id, {
      title: args.title,
      description: args.description,
      dri: args.dri,
      dueDate: args.due_date,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'add_gtm_phase',
  definition: {
    name: 'add_gtm_phase',
    description: 'Add a new phase to an existing GTM plan. Optionally include work items for the phase.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        title: {
          type: 'string',
          description: 'Title of the new phase'
        },
        description: {
          type: 'string',
          description: 'Optional description of the phase'
        },
        dri: {
          type: 'string',
          description: 'Optional DRI email address for the phase'
        },
        due_date: {
          type: 'string',
          description: 'Optional due date for the phase (ISO date string)'
        },
        work_items: {
          type: 'array',
          description: 'Optional array of work items to add to the phase',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the work item'
              },
              description: {
                type: 'string',
                description: 'Optional description of the work item'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI email address for the work item'
              },
              due_date: {
                type: 'string',
                description: 'Optional due date for the work item (ISO date string)'
              }
            },
            required: ['title']
          }
        }
      },
      required: ['plan_id', 'title']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addGTMPhase(args.plan_id, {
      title: args.title,
      description: args.description,
      dri: args.dri,
      dueDate: args.due_date,
      workItems: args.work_items,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'add_gtm_work_items',
  definition: {
    name: 'add_gtm_work_items',
    description: 'Add one or more work items to an existing phase in a GTM plan.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'The unique identifier of the phase to add work items to'
        },
        work_items: {
          type: 'array',
          description: 'Array of work items to add',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the work item'
              },
              description: {
                type: 'string',
                description: 'Optional description of the work item'
              },
              dri: {
                type: 'string',
                description: 'Optional DRI email address for the work item'
              },
              due_date: {
                type: 'string',
                description: 'Optional due date for the work item (ISO date string)'
              }
            },
            required: ['title']
          }
        }
      },
      required: ['plan_id', 'phase_id', 'work_items']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addGTMWorkItems(args.plan_id, args.phase_id, args.work_items, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_gtm_work_item',
  definition: {
    name: 'update_gtm_work_item',
    description: 'Update a specific work item in a GTM plan. Can change status, notes, DRI, title, description, or due date. Optionally send notifications about the changes.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'The unique identifier of the phase containing the work item'
        },
        work_item_id: {
          type: 'string',
          description: 'The unique identifier of the work item to update'
        },
        status: {
          type: 'string',
          description: 'New status: "pending", "in_progress", "completed", or "skipped"'
        },
        notes: {
          type: 'string',
          description: 'Notes for the work item. Pass empty string to clear.'
        },
        dri: {
          type: 'string',
          description: 'New DRI email address. Pass empty string to remove.'
        },
        title: {
          type: 'string',
          description: 'New title for the work item'
        },
        description: {
          type: 'string',
          description: 'New description for the work item. Pass empty string to clear.'
        },
        due_date: {
          type: 'string',
          description: 'New due date (ISO date string). Pass empty string to remove.'
        },
        notify_user: {
          type: 'boolean',
          description: 'Whether to notify the plan owner about the change'
        },
        notify_item_poc: {
          type: 'boolean',
          description: 'Whether to notify the work item DRI about the change'
        },
        notify_phase_poc: {
          type: 'boolean',
          description: 'Whether to notify the phase DRI about the change'
        },
        notify_plan_poc: {
          type: 'boolean',
          description: 'Whether to notify the plan DRI about the change'
        },
        notification_message: {
          type: 'string',
          description: 'Optional custom message to include in the notification'
        }
      },
      required: ['plan_id', 'phase_id', 'work_item_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateGTMWorkItem(args.plan_id, args.phase_id, args.work_item_id, {
      status: args.status,
      notes: args.notes,
      dri: args.dri,
      title: args.title,
      description: args.description,
      dueDate: args.due_date,
    }, {
      notifyUser: args.notify_user,
      notifyItemPoc: args.notify_item_poc,
      notifyPhasePoc: args.notify_phase_poc,
      notifyPlanPoc: args.notify_plan_poc,
      message: args.notification_message,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_gtm_phase',
  definition: {
    name: 'update_gtm_phase',
    description: 'Update a phase in a GTM plan. Can change title, description, DRI, or due date. Phase status is auto-calculated from work items and cannot be set manually.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'The unique identifier of the phase to update'
        },
        title: {
          type: 'string',
          description: 'New title for the phase'
        },
        description: {
          type: 'string',
          description: 'New description for the phase. Pass empty string to clear.'
        },
        dri: {
          type: 'string',
          description: 'New DRI email address. Pass empty string to remove.'
        },
        due_date: {
          type: 'string',
          description: 'New due date (ISO date string). Pass empty string to remove.'
        }
      },
      required: ['plan_id', 'phase_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateGTMPhase(args.plan_id, args.phase_id, {
      title: args.title,
      description: args.description,
      dri: args.dri,
      dueDate: args.due_date,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'delete_gtm_items',
  definition: {
    name: 'delete_gtm_items',
    description: 'Delete a GTM plan, phase, or work item. Provide only plan_id to delete the entire plan. Add phase_id to delete a specific phase. Add both phase_id and work_item_id to delete a specific work item.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'Optional phase ID. If provided with plan_id, deletes the phase. If provided with work_item_id, targets the work item in this phase.'
        },
        work_item_id: {
          type: 'string',
          description: 'Optional work item ID. Requires phase_id. Deletes the specific work item from the phase.'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteGTMItems(args.plan_id, args.phase_id, args.work_item_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_gtm_common_items',
  definition: {
    name: 'get_gtm_common_items',
    description: 'Fetch the catalog of common GTM items (template work items) organized by category. Users can select items from this catalog to add to their plans.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getGTMCommonItems();
  }
});

emmaToolRegistry.register({
  name: 'add_gtm_common_items',
  definition: {
    name: 'add_gtm_common_items',
    description: 'Import selected template items from the common items catalog into a GTM plan phase. Items can be added to an existing phase or a new phase.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        items: {
          type: 'array',
          description: 'Array of items to add (each with title and optional description)',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Title of the item'
              },
              description: {
                type: 'string',
                description: 'Optional description of the item'
              }
            },
            required: ['title']
          }
        },
        target_phase_id: {
          type: 'string',
          description: 'ID of an existing phase to add items to. Either this or new_phase_name must be provided.'
        },
        new_phase_name: {
          type: 'string',
          description: 'Name for a new phase to create and add items to. Either this or target_phase_id must be provided.'
        }
      },
      required: ['plan_id', 'items']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addGTMCommonItems(args.plan_id, args.items, args.target_phase_id, args.new_phase_name, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'send_gtm_status_report',
  definition: {
    name: 'send_gtm_status_report',
    description: 'Send a status report email for a GTM plan or a specific phase. Choose recipients from plan owner, plan DRI, phase DRI(s). Omit phase_id for a plan-level report.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: {
          type: 'string',
          description: 'The unique identifier (planId) of the GTM plan'
        },
        phase_id: {
          type: 'string',
          description: 'Optional phase ID. If provided, sends a phase-level report. If omitted, sends a plan-level report.'
        },
        notify_user: {
          type: 'boolean',
          description: 'Whether to send the report to the plan owner'
        },
        notify_plan_poc: {
          type: 'boolean',
          description: 'Whether to send the report to the plan DRI'
        },
        notify_phase_poc: {
          type: 'boolean',
          description: 'For phase reports: whether to send to the phase DRI'
        },
        notify_phase_pocs: {
          type: 'boolean',
          description: 'For plan reports: whether to send to all phase DRIs'
        },
        message: {
          type: 'string',
          description: 'Optional custom message to include in the status report'
        }
      },
      required: ['plan_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.sendGTMStatusReport(args.plan_id, args.phase_id, {
      notifyUser: args.notify_user,
      notifyPlanPoc: args.notify_plan_poc,
      notifyPhasePoc: args.notify_phase_poc,
      notifyPhasePocs: args.notify_phase_pocs,
      message: args.message,
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_lead_lists',
  definition: {
    name: 'get_lead_lists',
    description: 'Get all lead lists for the current user. Returns a list of lead lists with their IDs, names, descriptions, lead counts, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
      }
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadLists(context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_lead_list',
  definition: {
    name: 'create_lead_list',
    description: 'Create a new lead list with a name and optional description. Returns the created lead list with its ID. You can specify a list_type to determine default pipeline stages.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the lead list'
        },
        description: {
          type: 'string',
          description: 'Optional description of the lead list'
        },
        list_type: {
          type: 'string',
          enum: ['sales', 'customers'],
          description: 'Type of the list. "sales" lists use sales pipeline stages (new, contacted, qualified, etc.). "customers" lists use customer lifecycle stages (onboarding, active, at_risk, churned). Determines default status configuration.'
        }
      },
      required: ['name']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createLeadList(args.name, args.description || '', context?.userId, args.list_type);
  }
});

emmaToolRegistry.register({
  name: 'add_leads_to_list',
  definition: {
    name: 'add_leads_to_list',
    description: 'Add one or more leads to an existing lead list. Each lead is a flexible object that can contain any fields you want to store. Common fields include: email (used for deduplication and merging), firstName, lastName, phone, company, title, notes, linkedin, and any custom fields. You can use any field names that make sense for your data. If a lead with the same email already exists, it will be merged with the new data. Returns counts of new and merged leads, plus any errors.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to add leads to'
        },
        leads: {
          type: 'array',
          items: {
            type: 'object',
            description: 'A lead object with any fields you want to store. Use field names that make sense for your data. The email field (if provided) is used for deduplication and merging.',
            additionalProperties: true,
            properties: {
              email: {
                type: 'string',
                description: 'Email address (optional, but recommended for deduplication and merging existing leads)'
              }
            }
          },
          description: 'Array of lead objects to add to the list. Each lead can have any fields you want to store.'
        }
      },
      required: ['list_id', 'leads']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addLeadsToList(args.list_id, args.leads || [], context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_email_draft_for_lead',
  definition: {
    name: 'update_email_draft_for_lead',
    description: 'Create or update an email draft for a specific lead. This function loads the lead record, engagement history, brand guidelines, and market strategy, then uses AI to generate a personalized email draft (subject and HTML content) based on the instruction provided. If a draft already exists, it will be included in the prompt for refinement. The draft is saved to the lead record along with the current session ID for future updates.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to create/update email draft for'
        },
        instruction: {
          type: 'string',
          description: 'Instructions for creating the email draft (e.g., "welcome email", "follow-up on their interest in our product", "introduce our new feature"). The AI will use this along with lead data, engagement history, brand guidelines, and market strategy to create a personalized email.'
        },
        email_format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'Optional. The format for the email draft: "text" for plain text or "html" for HTML. If not provided, uses the lead\'s saved format preference (defaults to "text").'
        }
      },
      required: ['list_id', 'lead_id', 'instruction']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateEmailDraftForLead(
      args.list_id,
      args.lead_id,
      args.instruction,
      context?.sessionId,
      context?.userId,
      args.email_format
    );
  }
});

emmaToolRegistry.register({
  name: 'get_leads',
  definition: {
    name: 'get_leads',
    description: 'Browse and list leads from a lead list with optional text search, status, and ICP/engaged filters. Returns compact lead summaries including status and deal value. Use search_leads for structured field-level filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to browse'
        },
        search: {
          type: 'string',
          description: 'Optional text search query to filter leads across all fields (name, email, company, title, etc.)'
        },
        status: {
          type: 'string',
          description: 'Optional status filter — only return leads with this exact status (e.g. "qualified", "won", "lost")'
        },
        icp_only: {
          type: 'boolean',
          description: 'If true, only return leads that match ICP criteria'
        },
        engaged_only: {
          type: 'boolean',
          description: 'If true, only return leads that have engagement activity'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of leads to return (default 20, max 100)'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned as next_cursor from a previous call. Pass this to retrieve the next page of results.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeads(args.list_id, context?.userId, {
      search: args.search,
      status: args.status,
      icpOnly: args.icp_only,
      engagedOnly: args.engaged_only,
      limit: args.limit,
      cursor: args.cursor
    });
  }
});

emmaToolRegistry.register({
  name: 'search_leads',
  definition: {
    name: 'search_leads',
    description: 'Find leads matching structured field-level criteria within one or more lead lists. Pass list_id for a single list (legacy) or list_ids for up to 5 lists at once — each returned lead carries its listId/listName so you can attribute results. Supports standard fields (email, firstName, lastName, company, title, phone, notes, linkedin, status, dealValue, dealCurrency, createdAt, updatedAt), ICP fields (icpScore, icpMatch), engagementCount, custom field names, and dot-notation paths (e.g. "customFields.createdAt"). Use greater_than/less_than with ISO date strings for date filtering. All filters use AND logic. Optionally combine with a keyword search across all fields. For cross-CRM strategic questions ("who should I reach out to?"), prefer ask_crm.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of a single lead list to search. Use this OR list_ids, not both.'
        },
        list_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of up to 5 lead lists to search across. Each returned lead includes its listId/listName. Inaccessible lists are silently skipped. Use this OR list_id, not both. For broader cross-CRM scope, prefer ask_crm.'
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Field name to filter on (standard: email, firstName, lastName, company, title, phone, notes, linkedin, status, dealValue, dealCurrency, createdAt, updatedAt; ICP: icpScore, icpMatch; engagement: engagementCount; dot-notation paths like "customFields.createdAt"; or any custom field name). When searching multiple lists, missing fields on a list silently fail to match (no error).'
              },
              operator: {
                type: 'string',
                enum: ['equals', 'contains', 'starts_with', 'greater_than', 'less_than', 'not_equals', 'is_empty', 'is_not_empty', 'ilike'],
                description: 'Comparison operator. ilike supports SQL-style wildcards: % matches any sequence of characters, _ matches any single character (case-insensitive). Example: "%@gmail.com" matches any Gmail address.'
              },
              value: {
                description: 'The value to compare against (not required for is_empty/is_not_empty)'
              }
            },
            required: ['field', 'operator']
          },
          description: 'Array of filter criteria (AND logic — all must match)'
        },
        search: {
          type: 'string',
          description: 'Optional keyword search across all fields (name, email, company, title, notes, custom fields, etc.). Applied in addition to filters (AND logic).'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of matching leads to return (default 20, max 100)'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor returned as next_cursor from a previous call. Pass this verbatim to retrieve the next page; the cursor freezes the list_ids set so paging is stable even if your list_ids change between calls.'
        }
      },
      required: ['filters']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchLeads(args.list_id, args.filters, context?.userId, args.limit, {
      search: args.search,
      cursor: args.cursor,
      listIds: args.list_ids,
    });
  }
});

emmaToolRegistry.register({
  name: 'ask_crm',
  definition: {
    name: 'ask_crm',
    description: 'Answer a free-form question about the CRM (hot leads, at-risk customers, deals closing, paying customers, specific contact). Returns a structured answer with intent classification, a summary line, and a ranked list of relevant leads with citation URLs. Use this when the user asks strategic pipeline questions like "who should I reach out to today", "which deals are about to close", "who is at risk", or "is Jane at Acme paying us". For single-list browsing, prefer get_leads/search_leads.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The free-form question to answer. Examples: "Who should I reach out to today?", "Which deals are close to closing?", "Is Jane at Acme paying us?", "Who are my at-risk customers?"'
        },
        limit: {
          type: 'number',
          description: 'Max number of leads in the response list (default 10, max 25)'
        },
        load_limit: {
          type: 'number',
          description: 'Max number of leads to scan across the user\'s lists (default 500). Rarely needed — only raise if the user has tons of lists.'
        }
      },
      required: ['question']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId;
    if (!userId) {
      return { error: 'Missing userId context. ask_crm is only available inside an authenticated Emma session.' };
    }

    const resultLimit = Math.min(Math.max(args.limit ?? 10, 1), 25);
    const loadLimit = Math.max(args.load_limit ?? 500, 1);

    // Lazy lead iteration across all of the user's lists. We flatten into the
    // AskCrmLead shape so askCrm doesn't have to know about the underlying
    // storage layout.
    const loadLeadsForUser = async (uid: string, opts: { limit: number }): Promise<AskCrmLead[]> => {
      const lists = (await crmDb.getLeadListsForUser(uid)) || [];
      const out: AskCrmLead[] = [];
      for (const list of lists as any[]) {
        if (out.length >= opts.limit) break;
        const remaining = opts.limit - out.length;
        const page = await crmDb.getLeadsByListId(list.listId, Math.min(remaining, 200));
        const items: any[] = (page && (page as any).items) || [];
        for (const it of items) {
          out.push({
            leadId: it.leadId,
            listId: it.listId,
            email: it.email || null,
            firstName: it.firstName || null,
            lastName: it.lastName || null,
            company: it.company || null,
            title: it.title || null,
            status: it.status || null,
            dealValue: typeof it.dealValue === 'number' ? it.dealValue : null,
            lifecycle: it.lifecycle || null,
            heatScore: typeof it.heatScore === 'number' ? it.heatScore : null,
            healthScore: typeof it.healthScore === 'number' ? it.healthScore : null,
            isICP: typeof it.isICP === 'boolean' ? it.isICP : null,
            lastEngagementAt: it.lastEngagementAt || null,
            openDealStages: Array.isArray(it.openDealStages) ? it.openDealStages : null,
            contactStatus: it.contactStatus || null,
          });
          if (out.length >= opts.limit) break;
        }
      }
      return out;
    };

    try {
      const answer = await askCrm(
        String(args.question || ''),
        userId,
        { loadLeadsForUser },
        { resultLimit, loadLimit }
      );
      return answer;
    } catch (err: any) {
      return { error: err?.message || 'ask_crm failed' };
    }
  }
});

emmaToolRegistry.register({
  name: 'get_lead_details',
  definition: {
    name: 'get_lead_details',
    description: 'Get full details for a single lead including all fields, ICP match info, email drafts, and recent engagement history.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to get details for'
        }
      },
      required: ['list_id', 'lead_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadDetails(args.list_id, args.lead_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_lead',
  definition: {
    name: 'update_lead',
    description: 'Update fields on a lead. Supports standard fields (email, firstName, lastName, phone, company, title, notes, linkedin, status, dealValue, dealCurrency) and any custom fields. Changing status auto-creates a status.changed engagement event.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to update'
        },
        updates: {
          type: 'object',
          description: 'Object with field names and new values. Standard fields: email, firstName, lastName, phone, company, title, notes, linkedin, status, dealValue, dealCurrency. Any other fields are stored as custom fields.',
          additionalProperties: true
        }
      },
      required: ['list_id', 'lead_id', 'updates']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateLead(args.list_id, args.lead_id, args.updates, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'set_lead_contact_status',
  definition: {
    name: 'set_lead_contact_status',
    description: 'Set the contact status for one or more leads. Use "do-not-contact" to flag leads that should not receive any emails or outreach. Use "active" to clear the flag and allow contact again. Leads flagged as do-not-contact will be blocked from all email sends, draft creation, and group emails.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the leads'
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of lead IDs to update (max 200)'
        },
        contact_status: {
          type: 'string',
          enum: ['active', 'do-not-contact', 'unsubscribed'],
          description: 'The contact status to set. "do-not-contact" blocks all outreach, "unsubscribed" marks as opted out, "active" clears the flag.'
        },
        reason: {
          type: 'string',
          enum: ['opted-out', 'bounced', 'requested-removal', 'admin-flagged', 'compliance', 'other'],
          description: 'Reason for the status change (optional but recommended for do-not-contact/unsubscribed)'
        },
        note: {
          type: 'string',
          description: 'Optional free-text note explaining the status change'
        }
      },
      required: ['list_id', 'lead_ids', 'contact_status']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.setLeadContactStatus(
      args.list_id,
      args.lead_ids,
      args.contact_status,
      args.reason,
      args.note,
      context?.userId
    );
  }
});

emmaToolRegistry.register({
  name: 'delete_leads',
  definition: {
    name: 'delete_leads',
    description: 'Delete one or more leads from a lead list. Maximum 100 leads per call.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the leads'
        },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of lead IDs to delete (max 100)'
        }
      },
      required: ['list_id', 'lead_ids']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeads(args.list_id, args.lead_ids, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'delete_leads_by_filter',
  definition: {
    name: 'delete_leads_by_filter',
    description: 'Delete all leads matching filter criteria from a lead list. Use this instead of search_leads + delete_leads when deleting many leads by condition (e.g. all leads without a certain field, all leads with low ICP score). TWO-PHASE WORKFLOW: (1) First call without confirm=true to see count and preview of matching leads. (2) If user approves, call again with confirm=true to actually delete them. This prevents accidental mass deletions.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list'
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: {
                type: 'string',
                description: 'Field name: standard fields (email, firstName, lastName, company, title, phone, notes, linkedin, status, dealValue, dealCurrency, icpScore, icpMatch, engagementCount) or any custom field name'
              },
              operator: {
                type: 'string',
                enum: ['equals', 'not_equals', 'contains', 'starts_with', 'is_empty', 'is_not_empty', 'greater_than', 'less_than'],
                description: 'Comparison operator'
              },
              value: {
                description: 'Value to compare against (not needed for is_empty/is_not_empty)'
              }
            },
            required: ['field', 'operator']
          },
          description: 'Array of filter conditions (all must match for a lead to be deleted)'
        },
        confirm: {
          type: 'boolean',
          description: 'Set to true to actually delete leads. Omit or set to false to preview count and sample leads first. ALWAYS preview first before setting confirm=true.'
        }
      },
      required: ['list_id', 'filters']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeadsByFilter(args.list_id, args.filters, context?.userId, args.confirm);
  }
});

emmaToolRegistry.register({
  name: 'update_lead_list',
  definition: {
    name: 'update_lead_list',
    description: 'Update a lead list\'s name, description, filter settings, auto-draft configuration, or status pipeline configuration.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to update'
        },
        name: {
          type: 'string',
          description: 'New name for the lead list'
        },
        description: {
          type: 'string',
          description: 'New description for the lead list'
        },
        icps_only: {
          type: 'boolean',
          description: 'If true, list only shows ICP-matching leads by default'
        },
        engaged_only: {
          type: 'boolean',
          description: 'If true, list only shows engaged leads by default'
        },
        auto_draft_enabled: {
          type: 'boolean',
          description: 'Enable or disable automatic email draft generation for new leads'
        },
        auto_draft_instruction: {
          type: 'string',
          description: 'Instructions for automatic email draft generation'
        },
        status_config: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Machine key (e.g. "qualified")' },
              label: { type: 'string', description: 'Display name (e.g. "Qualified")' },
              color: { type: 'string', description: 'Tailwind color name (e.g. "blue")' },
              type: { type: 'string', enum: ['active', 'won', 'lost', 'churned'], description: 'Status category' }
            },
            required: ['value', 'label', 'color', 'type']
          },
          description: 'Configure the status pipeline stages for this list. Each entry defines a pipeline stage with value, label, color, and type (active/won/lost/churned).'
        },
        list_type: {
          type: 'string',
          enum: ['sales', 'customers'],
          description: 'Set the list type. Can only be set once — once defined, it cannot be changed. "sales" lists track prospects through a sales pipeline; "customers" lists track existing customers through lifecycle stages.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateLeadList(args.list_id, {
      name: args.name,
      description: args.description,
      icpsOnly: args.icps_only,
      engagedOnly: args.engaged_only,
      autoDraftEnabled: args.auto_draft_enabled,
      autoDraftInstruction: args.auto_draft_instruction,
      statusConfig: args.status_config,
      listType: args.list_type
    }, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'delete_lead_list',
  definition: {
    name: 'delete_lead_list',
    description: 'Permanently delete a lead list and all its leads. This action cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to delete'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.deleteLeadList(args.list_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'update_lead_status',
  definition: {
    name: 'update_lead_status',
    description: 'Update a lead\'s pipeline status (e.g. new → contacted → qualified → won/lost). Auto-creates a status.changed engagement event for audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to update'
        },
        status: {
          type: 'string',
          description: 'The new status value (must match a value from the list\'s statusConfig, e.g. "qualified", "won", "lost")'
        },
        deal_value: {
          type: 'number',
          description: 'Optional monetary deal amount (relevant for won/lost/negotiating statuses)'
        },
        deal_currency: {
          type: 'string',
          description: 'ISO 4217 currency code (default: USD)'
        },
        notes: {
          type: 'string',
          description: 'Optional notes about this status change'
        }
      },
      required: ['list_id', 'lead_id', 'status']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.updateLeadStatus(
      args.list_id, args.lead_id, args.status, context?.userId,
      args.deal_value, args.deal_currency, args.notes
    );
  }
});

emmaToolRegistry.register({
  name: 'get_lead_list_statuses',
  definition: {
    name: 'get_lead_list_statuses',
    description: 'Get the configured pipeline status stages for a lead list. Returns the status options with their labels, colors, and types (active/won/lost/churned).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadListStatuses(args.list_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'configure_lead_statuses',
  definition: {
    name: 'configure_lead_statuses',
    description: 'Configure the pipeline status stages for a lead list. Replaces the entire status configuration. Each status has a machine key (value), display name (label), color, and type (active/won/lost/churned).',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list to configure'
        },
        statuses: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: 'Machine key (e.g. "qualified")' },
              label: { type: 'string', description: 'Display name (e.g. "Qualified")' },
              color: { type: 'string', description: 'Tailwind color name (e.g. "blue", "green", "red")' },
              type: { type: 'string', enum: ['active', 'won', 'lost', 'churned'], description: 'Status category for grouping/reporting' }
            },
            required: ['value', 'label', 'color', 'type']
          },
          description: 'Array of status stage definitions in pipeline order'
        }
      },
      required: ['list_id', 'statuses']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.configureLeadStatuses(args.list_id, args.statuses, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_lead_engagements',
  definition: {
    name: 'get_lead_engagements',
    description: 'Get engagement history for a lead including emails sent/received, LinkedIn messages, and manual engagement events.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to get engagements for'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of engagement events to return (default 20)'
        }
      },
      required: ['list_id', 'lead_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getLeadEngagements(args.list_id, args.lead_id, context?.userId, args.limit);
  }
});

emmaToolRegistry.register({
  name: 'add_lead_engagement',
  definition: {
    name: 'add_lead_engagement',
    description: 'Record a manual engagement event for a lead (e.g., phone calls, meetings, notes). The event_type must start with "custom." prefix.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to record engagement for'
        },
        event_type: {
          type: 'string',
          description: 'Type of engagement event (must start with "custom.", e.g., "custom.phone_call", "custom.meeting", "custom.note")'
        },
        event_data: {
          type: 'object',
          description: 'Optional data associated with the event (e.g., { "notes": "Discussed pricing", "duration": "30 min" })',
          additionalProperties: true
        },
        event_date: {
          type: 'string',
          description: 'Optional ISO date string for when the engagement occurred (defaults to now)'
        }
      },
      required: ['list_id', 'lead_id', 'event_type']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.addLeadEngagement(
      args.list_id, args.lead_id, args.event_type,
      context?.userId, args.event_data, args.event_date
    );
  }
});

emmaToolRegistry.register({
  name: 'send_email_to_lead',
  definition: {
    name: 'send_email_to_lead',
    description: 'Send the existing email draft to a lead using the configured CRM sender. The lead must have an email address and an email draft already created.',
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The ID of the lead list containing the lead'
        },
        lead_id: {
          type: 'string',
          description: 'The ID of the lead to send the email to'
        }
      },
      required: ['list_id', 'lead_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.sendEmailToLead(args.list_id, args.lead_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'list_connected_accounts',
  definition: {
    name: 'list_connected_accounts',
    description: 'Returns list of social media accounts connected by the user. PLATFORM MAPPING: use platform="linkedin" for standard LinkedIn posting accounts; use platform="unipile" for LinkedIn Outreach accounts (sending connection invites and direct messages via the linkedin_outreach tool).',
    inputSchema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          description: 'Filter by platform. Common values: "linkedin" (standard LinkedIn posts), "facebook", "meta", "twitter", "youtube" (YouTube channels - for uploading videos and viewing channel metrics), "unipile" (LinkedIn Outreach - use this when the user asks about sending connection requests or direct messages on LinkedIn), or "all" for every platform.',
          default: 'all'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listConnectedAccounts(context?.userId, args.platform);
  }
});

emmaToolRegistry.register({
  name: 'list_connected_account_posts',
  definition: {
    name: 'list_connected_account_posts',
    description: 'List posts from a connected social media account with optional metrics',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The connected account ID' },
        limit: { type: 'number', description: 'Maximum number of posts to return', default: 10 },
        include_metrics: { type: 'boolean', description: 'Whether to include per-post metrics (likes, comments, etc.)', default: false }
      },
      required: ['account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.loadConnectedAccountPosts(
      context?.userId,
      args.account_id,
      {
        limit: args.limit,
        include_metrics: args.include_metrics
      }
    );
  }
});

emmaToolRegistry.register({
  name: 'load_connected_account_metrics',
  definition: {
    name: 'load_connected_account_metrics',
    description: 'Load performance metrics for a specific connected account (e.g., page statistics, follower counts, engagement). Optionally filter by a date range using start_date and end_date. Note: YouTube metrics are always lifetime totals and are not affected by the date range.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'The unique identifier (id) of the connected account to load metrics for'
        },
        start_date: {
          type: 'string',
          description: 'Optional start date for metrics in ISO 8601 format (e.g. "2024-01-01"). Both start_date and end_date must be provided together — specifying only one has no effect.'
        },
        end_date: {
          type: 'string',
          description: 'Optional end date for metrics in ISO 8601 format (e.g. "2024-01-31"). Both start_date and end_date must be provided together — specifying only one has no effect.'
        }
      },
      required: ['account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    const parseDate = (val: string | undefined): Date | undefined => {
      if (!val) return undefined;
      const d = new Date(val);
      if (isNaN(d.getTime())) throw new Error(`Invalid date: "${val}"`);
      return d;
    };
    const startDate = parseDate(args.start_date);
    const endDate = parseDate(args.end_date);
    return await agentModeService.loadConnectedAccountMetrics(context?.userId, args.account_id, startDate, endDate);
  }
});

emmaToolRegistry.register({
  name: 'post_on_connected_account',
  definition: {
    name: 'post_on_connected_account',
    description: 'Create a post on a connected social media account. Supports LinkedIn, Instagram, and YouTube. For YouTube: this UPLOADS a video — you MUST provide a video URL in media_urls. The content becomes the video title (first 100 chars) and description. CRITICAL: Always review the post content with the user and get explicit approval before publishing to social media. IMPORTANT: The content parameter must contain the COMPLETE, FULL post text exactly as approved by the user. Never truncate, abbreviate, summarize, or use placeholders like "..." in the content.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'The connected account ID' },
        content: { type: 'string', description: 'The COMPLETE post text content. MUST include the full, untruncated text exactly as approved by the user. Do NOT abbreviate, summarize, or omit any part of the content. Include all paragraphs, hashtags, emojis, and formatting. Length limits depend on the specific platform. CRITICAL FOR LINKEDIN: LinkedIn does NOT render markdown. Never use **bold**, *italic*, - bullets, [links](url), or # headings — they appear as raw text. Use LinkedIn-native plain text: line breaks, unicode bullets (•), emojis for emphasis, and full URLs (LinkedIn auto-links them).' },
        media_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional URLs of images/videos to attach. REQUIRED for YouTube — must be a direct video file URL (e.g. .mp4). The video will be downloaded and uploaded to YouTube.'
        }
      },
      required: ['account_id', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.postOnConnectedAccount(context?.userId, args.account_id, args.content, args.media_urls);
  }
});

emmaToolRegistry.register({
  name: 'linkedin_manage_post',
  definition: {
    name: 'linkedin_manage_post',
    description: 'Manage LinkedIn post interactions using a connected LinkedIn account. Supports reposting, commenting, listing comments, reacting, and fetching analytics — all in one tool.\n\nActions:\n- repost: Reshare an existing LinkedIn post, optionally adding your own commentary. Requires post_urn. CRITICAL: Always get explicit user approval before reposting.\n- comment: Create a comment on a post, or a nested reply when parent_comment_urn is provided. Requires post_urn and comment_text. CRITICAL: Always get explicit user approval before commenting.\n- list_comments: Fetch all comments on a post with their URNs (useful for finding parent_comment_urn for replies). Requires post_urn.\n- react: React to a post (LIKE/PRAISE/EMPATHY/INTEREST/APPRECIATION/ENTERTAINMENT). Requires post_urn. CRITICAL: Always get explicit user approval before reacting.\n- get_analytics: Fetch engagement metrics (likes, comments, shares, impressions, clicks) for one or more posts. Requires post_ids array.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['repost', 'comment', 'list_comments', 'react', 'get_analytics'],
          description: 'The operation to perform'
        },
        account_id: {
          type: 'string',
          description: 'The connected LinkedIn account ID'
        },
        post_urn: {
          type: 'string',
          description: 'LinkedIn post URN — required for repost, comment, list_comments, react (e.g., "urn:li:ugcPost:123456789" or "urn:li:share:987654321" or "urn:li:activity:123456789")'
        },
        commentary: {
          type: 'string',
          description: 'Optional text to add alongside a repost. Only used with action=repost. LinkedIn plain text only — no markdown.'
        },
        comment_text: {
          type: 'string',
          description: 'The comment text. Required for action=comment. LinkedIn plain text only — no markdown.'
        },
        parent_comment_urn: {
          type: 'string',
          description: 'Optional. URN of a parent comment to reply to (e.g., "urn:li:comment:(urn:li:ugcPost:123,456)"). Only used with action=comment. When provided, posts a nested reply instead of a top-level comment.'
        },
        reaction_type: {
          type: 'string',
          enum: ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'],
          description: 'Reaction type for action=react. LIKE=👍 PRAISE=👏 EMPATHY=❤️ INTEREST=💡 APPRECIATION=🙌 ENTERTAINMENT=😂. Defaults to LIKE.'
        },
        post_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of post URNs to fetch analytics for. Required for action=get_analytics.'
        }
      },
      required: ['action', 'account_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.linkedinManagePost(context?.userId, args);
  }
});

emmaToolRegistry.register({
  name: 'list_task_templates',
  definition: {
    name: 'list_task_templates',
    description: '[DEPRECATED] List all available web automation task templates. Returns template names, IDs, descriptions, categories, and parameters. Use this only if you need to use create_task_from_template for a task that cannot be done via direct browser control.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listTaskTemplates();
  }
});

// --- Tools from taskTools.ts ---
emmaToolRegistry.register({
  name: 'create_task_from_template',
  definition: {
    name: 'create_task_from_template',
    description: '[DEPRECATED] Create a web automation task using a specific template. Only use this for tasks that cannot be accomplished via direct browser control with Playwright browser tools. If you need to do web automation (browsing, clicking, filling forms, scraping), prefer using the browser_* Playwright tools directly instead. IMPORTANT: You must call list_task_templates first to get the available template IDs before using this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        template_id: {
          type: 'string',
          description: 'The template ID obtained from list_task_templates. Do not guess or fabricate template IDs.'
        },
        parameters_json: {
          type: 'string',
          description: 'JSON string containing parameter values where keys are parameter names and values are the actual values. Example: {"site_url": "example.com", "business_area": "e-commerce"}'
        },
        attach_previous_task_results: {
          type: 'boolean',
          default: true,
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
        },
        attached_file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
          default: []
        },
        async: {
          type: 'boolean',
          description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
          default: false
        }
      },
      required: ['template_id', 'parameters_json']
    }
  },
  execute: async (args: any, context?: any) => {
    let parameters = args.parameters_json;
    if (typeof parameters === 'string') {
      try { parameters = JSON.parse(args.parameters_json); } catch (e) { }
    }
    return await agentModeService.createTaskFromTemplate(
      args.template_id,
      parameters,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async ?? false
    );
  }
});

emmaToolRegistry.register({
  name: 'create_task_from_prompt',
  definition: {
    name: 'create_task_from_prompt',
    description: '[DEPRECATED] Create a web automation task using a raw prompt when no suitable template is available. Web automation via agent engine is being phased out. Do not use this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Name for the task'
        },
        prompt: {
          type: 'string',
          description: 'The raw prompt/instructions for the task'
        },
        category: {
          type: 'string',
          description: 'Category for the task (e.g., Research, Marketing, Analysis)'
        },
        attach_previous_task_results: {
          type: 'boolean',
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
          default: true
        },
        attached_file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of file URLs to attach to this task. These should be URLs from files uploaded in the current conversation.',
          default: []
        },
        async: {
          type: 'boolean',
          description: 'Whether to execute the task asynchronously. If false, the function will wait for task completion before returning the final result.',
          default: false
        }
      },
      required: ['task_name', 'prompt', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results,
      args.attached_file_urls || [],
      args.async ?? false
    );
  }
});

emmaToolRegistry.register({
  name: 'create_image_task_from_prompt',
  definition: {
    name: 'create_image_task_from_prompt',
    description: '[DEPRECATED] Create an image generation task using a raw prompt for creating visual content. Use \'generate_image\' instead for creating and revising images.',
    inputSchema: {
      type: 'object',
      properties: {
        task_name: {
          type: 'string',
          description: 'Name for the image generation task'
        },
        prompt: {
          type: 'string',
          description: 'The detailed prompt describing what images to generate, including style, content, and specifications'
        },
        category: {
          type: 'string',
          description: 'Category for the task (e.g., Creatives, Marketing, Social Media)',
          default: 'Creatives'
        },
        attach_previous_task_results: {
          type: 'boolean',
          description: 'Whether to attach previous task results to this task. Set to true for follow-up tasks that need to reference previous work.',
          default: true
        }
      },
      required: ['task_name', 'prompt']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createImageTaskFromPrompt(
      args.task_name,
      args.prompt,
      args.category,
      context?.userId,
      context?.sessionId,
      args.attach_previous_task_results
    );
  }
});

emmaToolRegistry.register({
  name: 'create_revision',
  definition: {
    name: 'create_revision',
    description: '[DEPRECATED] Create a revision of an existing completed task execution (supports both reports and images). For image revision, use \'generate_image\' instead. For HTML report revision, use \'update_html_file\' instead.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to revise'
        },
        execution_id: {
          type: 'string',
          description: 'The ID of the execution to revise'
        },
        revision_prompt: {
          type: 'string',
          description: 'Detailed instructions for the revision'
        },
        target_result_name: {
          type: 'string',
          description: 'Name of the specific result file to revise (if execution has multiple results). If not provided, will use the first available result.',
          default: null
        }
      },
      required: ['task_id', 'execution_id', 'revision_prompt']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createRevision(
      args.task_id,
      args.execution_id,
      args.revision_prompt,
      context?.userId,
      args.target_result_name
    );
  }
});

emmaToolRegistry.register({
  name: 'get_task_subscriber_metrics',
  definition: {
    name: 'get_task_subscriber_metrics',
    description: 'Get comprehensive email metrics for all subscribers of a specific task, including open rates, click-through rates, and engagement data',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to get subscriber metrics for'
        }
      },
      required: ['task_id']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getTaskSubscriberMetrics(args.task_id, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'get_task_subscriber_engagement_events',
  definition: {
    name: 'get_task_subscriber_engagement_events',
    description: 'Get email engagement events for a specific task and email subject, showing detailed event history like delivered, opened, clicked, bounced, etc.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'string',
          description: 'The ID of the task to get engagement events for'
        },
        email_subject: {
          type: 'string',
          description: 'The email subject line to filter events by'
        }
      },
      required: ['task_id', 'email_subject']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.getTaskSubscriberEngagementEvents(args.task_id, args.email_subject, context?.userId);
  }
});

// --- Tools from mediaTools.ts ---
emmaToolRegistry.register({
  name: "describe_image",
  definition: {
    name: "describe_image",
    description: 'Analyze and describe an image from a URL. Use this when the user mentions an image, asks to "read" an image, or when you need to understand visual content (jpg, jpeg, png, gif, webp, svg, etc.). Always prefer this over read_file_content for image files.',
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: 'string',
          description: 'Image URL to analyze and describe. Include the complete file URL in request.'
        },
        prompt: {
          type: 'string',
          description: 'Custom prompt/instructions for analyzing the image. Specify what aspects to focus on (e.g., colors, composition, text, branding, marketing elements, etc.)',
          default: 'Please analyze and describe this image in detail. Focus on visual elements, composition, colors, text, and any marketing or branding elements you can identify.'
        }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.describeImage(args.llmModel, args.image_url, args.prompt);
  }
});

emmaToolRegistry.register({
  name: "describe_video",
  definition: {
    name: "describe_video",
    description: 'Analyze and describe a video from a URL using Gemini. Use this when the user mentions a video, asks to "read" a video, or when you need to understand video content (mp4, mov, avi, webm, mkv, etc.). Always prefer this over read_file_content for video files.',
    inputSchema: {
      type: "object",
      properties: {
        video_file_url: {
          type: 'string',
          description: 'Video URL to analyze and describe. Include the complete file URL in request.'
        },
        prompt: {
          type: 'string',
          description: 'Custom prompt/instructions for analyzing the video. Specify what aspects to focus on (e.g., key events, narration, visual details, or timing).',
          default: 'Please describe this video in detail. Focus on key events, visual elements, and any spoken content.'
        }
      },
      required: ["video_file_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.describeVideo(args.video_file_url, args.prompt);
  }
});

emmaToolRegistry.register({
  name: "remove_c2pa_from_image",
  definition: {
    name: "remove_c2pa_from_image",
    description: 'Remove C2PA metadata from an image by downloading it from a URL, stripping metadata, and uploading the cleaned image to S3. Returns the new S3 URL.',
    inputSchema: {
      type: "object",
      properties: {
        image_url: {
          type: 'string',
          description: 'URL of the image to process (can be S3 URL, data URL, or any accessible image URL)'
        },
        filename: {
          type: 'string',
          description: 'Optional filename for the cleaned image. If not provided, will generate a filename based on the original URL'
        }
      },
      required: ["image_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.removeC2PAFromImage(args.image_url, args.filename, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'generate_image',
  definition: {
    name: 'generate_image',
    description: 'Generate or edit images using AI image generation models. Supports both text-to-image generation and image editing with input images. IMPORTANT: When adding a logo to an image, always provide the logo URL in the dedicated logo_image parameter (NOT in inputImages). The logo_image parameter ensures the logo is reproduced with exact precision in text, shape, and color.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the image to generate or edit, including style, content, and visual specifications'
        },
        filename: {
          type: 'string',
          description: 'Name for the generated image file (should include .png extension)'
        },
        size: {
          type: 'string',
          description: 'Image size or ratio. For GPT models: 1024x1024, 1536x1024, 1024x1536, or auto. For Runway models: use ratio format like 1344:768, 768:1344, 1024:1024, 832x1248, etc. For Gemini 3 Pro Image (gemini-3-pro-image-preview): use ratio format like 1:1, 9:16, 16:9, 3:4, 4:3, 3:2, 2:3, 5:4, 4:5, 21:9, or auto. Use "auto" for automatic sizing.',
          default: 'auto'
        },
        quality: {
          type: 'string',
          description: 'Image quality setting (low, medium, high). Defaults to medium if not specified.',
          enum: ['low', 'medium', 'high'],
          default: 'medium'
        },
        inputImages: {
          type: 'array',
          description: 'List of input image URLs to use for image editing (e.g., background images, base images to modify). Do NOT put logo images here — use the logo_image parameter instead for logos.',
          items: {
            type: 'string'
          }
        },
        logo_image: {
          type: 'string',
          description: 'URL of a logo image to add to the generated/edited image. ALWAYS use this parameter when the user wants to add a logo. The logo will be reproduced with strict precision — its exact text, shape, and colors will be preserved faithfully. This is the preferred way to include logos instead of putting them in inputImages.'
        },
        imageModel: {
          type: 'string',
          description: 'Optional: Specific image generation model to use. Must be one of: gemini-3-pro-image-preview (by Google), gemini-3.1-flash-image-preview (Nano Banana 2 by Google), gpt-image-1 (by Azure), gpt-image-2 (by Azure), gemini-2.5-flash-image (by Google), gen4_image (by Runway), gemini_2.5_flash (by Runway).',
          enum: ['gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview', 'gpt-image-1', 'gpt-image-2', 'gemini-2.5-flash-image', 'gen4_image', 'gemini_2.5_flash']
        }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    // If the LLM didn't specify a model, fall back to the admin-configured image API default
    const imageModel = args.imageModel || await agentModeService.getImageApiDefaultModel();
    return await agentModeService.generateImage(
      args.prompt,
      args.filename,
      args.size || '1024x1024',
      args.quality || 'medium',
      args.inputImages || [],
      context?.userId,
      context?.sessionId,
      imageModel,
      args.logo_image
    );
  }
});

emmaToolRegistry.register({
  name: 'generate_video',
  definition: {
    name: 'generate_video',
    description: 'Generate videos using AI video generation models. Supports text-to-video generation and video generation with optional start and end frames for interpolation. Can optionally post-process the generated clip with Remotion to add brand overlays (headline, tagline, logo, CTA). IMPORTANT: For multi-clip videos (e.g. 24s = 3 clips), ALWAYS use a single generate_video call with durationSeconds=24 and compose=true — do NOT generate clips separately and stitch later. To stitch already-generated clips, use compose_video instead.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Detailed description of the video to generate, including style, content, motion, and visual specifications'
        },
        filename: {
          type: 'string',
          description: 'Name for the generated video file (should include .mp4 extension, will be added automatically if missing)'
        },
        videoModel: {
          type: 'string',
          description: 'Optional: Specific video generation model to use. Currently supports: veo-3.1-generate-preview (by Google). Defaults to veo-3.1-generate-preview if not specified.',
          enum: ['veo-3.1-generate-preview']
        },
        durationSeconds: {
          type: 'number',
          description: 'Optional: Requested total duration of the generated video in seconds. For durations up to 8s, a single Veo clip is generated. For durations 9–32s, multiple 8s clips are generated in parallel and concatenated by Remotion. Defaults to 8 if not specified. Common values: 8 (default), 16 (2 clips), 24 (3 clips). Requires compose:true for multi-clip videos.'
        },
        useKeyframes: {
          type: 'boolean',
          description: 'Optional: When true and durationSeconds > 8 (multiple clips), automatically generate AI keyframe images (f0, f1, ... fN) to guide each clip. Clip i gets startFrame=f[i] and endFrame=f[i+1], so Veo interpolates between visually coherent waypoints. This greatly improves visual continuity across clip boundaries. Recommended for multi-clip videos. Defaults to false.'
        },
        startFrame: {
          type: 'string',
          description: 'Optional: URL of the first frame image to use as the starting point for video generation. If provided, the video will start from this frame.'
        },
        endFrame: {
          type: 'string',
          description: 'Optional: URL of the last frame image to use as the ending point for video generation. If provided, the video will end at this frame. Can be used together with startFrame for interpolation between two frames.'
        },
        compose: {
          type: 'boolean',
          description: 'Optional: When true, post-process the generated clip with Remotion to add branded overlays (brand name headline, tagline, logo, and optional CTA card). Requires composeParams. Use this when the user wants a polished, branded video rather than the raw AI-generated clip.'
        },
        composeParams: {
          type: 'object',
          description: 'Optional: Brand overlay configuration for Remotion post-processing. Required when compose is true.',
          properties: {
            brandName: {
              type: 'string',
              description: 'Brand display name shown as the headline overlay on the video'
            },
            tagline: {
              type: 'string',
              description: 'Optional tagline or subtitle shown under the brand name'
            },
            primaryColor: {
              type: 'string',
              description: 'Primary hex color for the gradient bar and background tint (e.g. "#1a73e8")'
            },
            secondaryColor: {
              type: 'string',
              description: 'Secondary hex color for accent elements like the divider line (e.g. "#fbbc04")'
            },
            logoUrl: {
              type: 'string',
              description: 'Optional URL of the brand logo image to display in the overlay'
            },
            ctaText: {
              type: 'string',
              description: 'Optional call-to-action text for the outro card (e.g. "Get started today")'
            },
            ctaUrl: {
              type: 'string',
              description: 'Optional URL shown alongside the CTA text (e.g. "agentweb.pro")'
            },
            clipDurationSeconds: {
              type: 'number',
              description: 'Optional: Duration of the source clip in seconds. Defaults to 8 (Veo default). Used to set correct composition duration.'
            }
          },
          required: ['brandName', 'primaryColor', 'secondaryColor']
        }
      },
      required: ['prompt', 'filename']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.generateVideo(
      args.prompt,
      args.filename,
      context?.userId,
      context?.sessionId,
      args.videoModel,
      args.startFrame,
      args.endFrame,
      args.compose,
      args.composeParams,
      args.durationSeconds,
      args.useKeyframes
    );
  }
});

emmaToolRegistry.register({
  name: 'compose_video',
  definition: {
    name: 'compose_video',
    description: 'Stitch pre-existing video clips together and add brand overlays using Remotion. Use this when you have already generated individual clips and need to combine them into a single branded video. For new multi-clip videos, prefer a single generate_video call with durationSeconds instead.',
    inputSchema: {
      type: 'object',
      properties: {
        clip_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ordered list of S3/HTTPS URLs of the pre-generated video clips to stitch together (first to last)'
        },
        filename: {
          type: 'string',
          description: 'Output filename for the composed video (e.g. "final_branded_video.mp4")'
        },
        clip_duration_seconds: {
          type: 'number',
          description: 'Duration of each individual clip in seconds (all clips must have the same duration). Defaults to 8.'
        },
        brand_name: {
          type: 'string',
          description: 'Brand display name shown as the headline overlay'
        },
        tagline: {
          type: 'string',
          description: 'Optional tagline or subtitle shown under the brand name'
        },
        primary_color: {
          type: 'string',
          description: 'Primary hex color for the gradient bar and background tint (e.g. "#1a73e8")'
        },
        secondary_color: {
          type: 'string',
          description: 'Secondary hex color for accent elements (e.g. "#fbbc04")'
        },
        logo_url: {
          type: 'string',
          description: 'Optional URL of the brand logo image'
        },
        cta_text: {
          type: 'string',
          description: 'Optional call-to-action text for the outro card'
        },
        cta_url: {
          type: 'string',
          description: 'Optional website URL shown alongside the CTA text'
        }
      },
      required: ['clip_urls', 'filename', 'brand_name', 'primary_color', 'secondary_color']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.composeVideo(
      args.clip_urls,
      args.filename,
      context?.userId,
      context?.sessionId,
      {
        brandName: args.brand_name,
        tagline: args.tagline,
        primaryColor: args.primary_color,
        secondaryColor: args.secondary_color,
        logoUrl: args.logo_url,
        ctaText: args.cta_text,
        ctaUrl: args.cta_url,
      },
      args.clip_duration_seconds
    );
  }
});

// --- Tools from searchTools.ts ---
emmaToolRegistry.register({
  name: "search_web",
  definition: {
    name: "search_web",
    description: 'Search the web for information from the internet',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant information on the web'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of search results to return (default: 5, max: 10)',
          default: 5
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchWeb(args.query, args.max_results || 10);
  }
});

emmaToolRegistry.register({
  name: "search_knowledge_base",
  definition: {
    name: "search_knowledge_base",
    description: 'Search the knowledge base for relevant information. The knowledge base contains private knowledge (user-specific), public knowledge (shared by all users and the platform), Google Drive shared folders, and ClickUp docs. This is complementary to web search - use knowledge base for stored information and web search for information from the internet.',
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: 'The search query to find relevant information in the knowledge base'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of search results to return (default: 5, max: 10)',
          default: 5
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchKnowledgeBase(args.query, args.max_results || 5, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "search_ads_knowledge_base",
  definition: {
    name: "search_ads_knowledge_base",
    description: "Search the user's Foreplay ad library (swipefile + boards) for ads the user has SAVED/bookmarked. Use this for ad creative inspiration or finding specific saved ads by brand, headline, or description. IMPORTANT: This only searches the user's own saved collection — it does NOT search the public Meta/Facebook Ads Library for ads currently running by any company. For finding a specific company's currently-running Meta ads, use Playwright to browse https://www.facebook.com/ads/library/ with the company's Facebook Page ID (view_all_page_id=PAGE_ID) — do NOT use keyword search (q=) as that returns false positives. Do NOT use search_knowledge_base for Foreplay ad searches.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g. brand name, headline keyword, ad type)"
        },
        max_results: {
          type: "number",
          description: "Max results to return (default 5)",
          default: 5
        }
      },
      required: ["query"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.searchForeplayAds(args.query, args.max_results || 5, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "list_knowledge_base_files",
  definition: {
    name: "list_knowledge_base_files",
    description: 'List available knowledge base files for the current user, including private/public task KBs, Google Drive shared folders, ClickUp docs, and Foreplay boards. Google Drive entries have identifiers starting with "gdrive:". ClickUp doc entries start with "clickup:" and include a docId field — use docId as parent_doc_id in write_clickup_doc to nest content inside that doc. ClickUp folder entries start with "clickup-folder:" (these are task-hierarchy folders, for reference only — not writable doc parents). Use modified_after/modified_before to filter by date (ISO format, e.g. "2026-04-15") — this is the most efficient way to find recent files. Use limit/offset to paginate through large folders (default limit is 100). Use kb_type to narrow to a specific source ("google-drive", "private", "public", "clickup", "clickup-tasks", "foreplay-swipefile", "foreplay-board"). Returns file names, identifiers, sizes, types, and last modified timestamps. IMPORTANT: Use this tool (not search_knowledge_base) when you need to browse or list files by name or date.',
    inputSchema: {
      type: "object",
      properties: {
        modified_after: {
          type: "string",
          description: 'Only return files modified on or after this date. ISO 8601 date string, e.g. "2026-04-15". Applies to Google Drive files.'
        },
        modified_before: {
          type: "string",
          description: 'Only return files modified on or before this date. ISO 8601 date string, e.g. "2026-04-22". Applies to Google Drive files.'
        },
        limit: {
          type: "number",
          description: 'Maximum number of files to return per knowledge base source (default: 100). Use with offset for pagination.'
        },
        offset: {
          type: "number",
          description: 'Number of files to skip within each knowledge base source (default: 0). Use with limit for pagination.'
        },
        kb_type: {
          type: "string",
          enum: ["google-drive", "private", "public", "clickup", "clickup-tasks", "foreplay-swipefile", "foreplay-board"],
          description: 'Filter to only return a specific type of knowledge base. Omit to return all types.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.listKnowledgeBaseFiles(context?.userId, {
      modified_after: args?.modified_after,
      modified_before: args?.modified_before,
      limit: args?.limit,
      offset: args?.offset,
      kb_type: args?.kb_type,
    });
  }
});

emmaToolRegistry.register({
  name: "read_knowledge_base_files",
  definition: {
    name: "read_knowledge_base_files",
    description: 'Read one or more knowledge base files. Each entry requires a knowledge base identifier (kb_identifier) and a file name (file_name). For Google Drive shared folders, use the identifier from list_knowledge_base_files (e.g., "gdrive:FOLDER_ID") and the file name. For ClickUp docs, use the identifier (e.g., "clickup:WORKSPACE_ID") and the doc name. Public knowledge base files can be accessed by any user, while private files require ownership. Returns the content for each requested file.',
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: 'array',
          description: 'List of files to read',
          items: {
            type: 'object',
            properties: {
              kb_identifier: {
                type: 'string',
                description: 'Knowledge base identifier (taskId)'
              },
              file_name: {
                type: 'string',
                description: 'Name of the file to read (e.g., knowledge-base.txt or uploaded filename)'
              }
            },
            required: ['kb_identifier', 'file_name']
          }
        }
      },
      required: ["files"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.readKnowledgeBaseFiles(args.files, context?.userId);
  }
});

emmaToolRegistry.register({
  name: 'create_knowledge_base',
  definition: {
    name: 'create_knowledge_base',
    description: 'Create a new knowledge base with initial content. This creates a new task with a knowledge base file. Use this when the user wants to start a new knowledge base for research, documentation, or data collection. Returns the new taskId which can be used with update_knowledge_base_file and attach_knowledge_base_files.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name for the new knowledge base (e.g., "Market Research Q1", "Competitor Analysis")'
        },
        content: {
          type: 'string',
          description: 'Initial content to write to the knowledge base'
        },
        knowledgeBaseType: {
          type: 'string',
          enum: ['public', 'private'],
          description: 'Whether the knowledge base is public or private. Default: private'
        }
      },
      required: ['name', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.createKnowledgeBase(
      args.name,
      args.content,
      args.knowledgeBaseType || 'private',
      context.userId,
      context.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'update_knowledge_base_file',
  definition: {
    name: 'update_knowledge_base_file',
    description: 'Update or append content to a specific file in a task\'s knowledge base. Use this to save information that should persist across executions, like research findings, data collected, or documentation. The user must own the task to update its knowledge base. IMPORTANT: Use list_knowledge_base_files first to see available knowledge bases and their identifiers (taskIds). Use fileName "knowledge-base.txt" for the main knowledge base file, or specify an attached file\'s name.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID (kb_identifier) whose knowledge base to update. Get this from list_knowledge_base_files.'
        },
        fileName: {
          type: 'string',
          description: 'The name of the file to update. Use "knowledge-base.txt" for the main KB file, or the filename of an attached file. If the file does not exist, a new one will be created.'
        },
        content: {
          type: 'string',
          description: 'The content to write to the file'
        },
        mode: {
          type: 'string',
          enum: ['replace', 'append'],
          description: 'Whether to replace the entire file or append to it. Default: append'
        }
      },
      required: ['taskId', 'fileName', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.updateKnowledgeBaseFile(
      args.taskId,
      args.fileName,
      args.content,
      args.mode || 'append',
      context.userId,
      context.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'attach_knowledge_base_files',
  definition: {
    name: 'attach_knowledge_base_files',
    description: 'Attach one or more files to a task\'s knowledge base. Use this to save multiple pieces of content as separate named files. The user must own the task. IMPORTANT: Use list_knowledge_base_files first to see available knowledge bases and their identifiers (taskIds).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID (kb_identifier) to attach files to. Get this from list_knowledge_base_files.'
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Filename for the attached file (e.g., "research-summary.txt", "competitor-data.csv")'
              },
              content: {
                type: 'string',
                description: 'The file content'
              }
            },
            required: ['name', 'content']
          },
          description: 'Array of files to attach, each with a name and content'
        }
      },
      required: ['taskId', 'files']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.attachKnowledgeBaseFiles(
      args.taskId,
      args.files,
      context.userId,
      context.sessionId
    );
  }
});

emmaToolRegistry.register({
  name: 'write_clickup_doc',
  definition: {
    name: 'write_clickup_doc',
    description: 'Create a new document in the user\'s ClickUp workspace. Use this when the user wants to save content (research, reports, documentation) directly to ClickUp. The workspace_id can be obtained from list_knowledge_base_files (ClickUp entries have identifiers like "clickup:WORKSPACE_ID"). To place content inside an existing ClickUp doc (e.g. a doc that acts as a folder/container), pass parent_doc_id using the docId from list_knowledge_base_files. NOTE: ClickUp task-hierarchy folders (clickup-folder: entries) cannot be used as doc parents — only existing doc IDs work.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: {
          type: 'string',
          description: 'ClickUp workspace ID (get from list_knowledge_base_files, e.g., the part after "clickup:" in the identifier)'
        },
        name: {
          type: 'string',
          description: 'Document or page title'
        },
        content: {
          type: 'string',
          description: 'Document content (markdown)'
        },
        parent_doc_id: {
          type: 'string',
          description: 'Optional: ID of an existing ClickUp doc to create this content inside as a page. Get the docId from list_knowledge_base_files (each file entry under a "clickup:" knowledge base has a docId). If omitted, the document is created at the workspace root.'
        }
      },
      required: ['workspace_id', 'name', 'content']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId) {
      throw new Error("Missing user context");
    }
    return await agentModeService.writeClickUpDoc(
      args.workspace_id,
      args.name,
      args.content,
      context.userId,
      args.parent_doc_id
    );
  }
});

emmaToolRegistry.register({
  name: "read_file_content",
  definition: {
    name: "read_file_content",
    description: 'Read and extract text content from a file URL. Supports text files, PDFs, HTML, Markdown, CSV, and other common formats. Do NOT use this for image files (jpg, jpeg, png, gif, webp, svg) — use describe_image instead. Do NOT use this for video files (mp4, mov, avi, webm, mkv) — use describe_video instead.',
    inputSchema: {
      type: "object",
      properties: {
        file_url: {
          type: 'string',
          description: 'The URL of the file to read and extract content from'
        }
      },
      required: ["file_url"]
    }
  },
  execute: async (args: any, context?: any) => {
    const result = await agentModeService.readFileContent(args.file_url);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

emmaToolRegistry.register({
  name: "read_page_source",
  definition: {
    name: "read_page_source",
    description: 'Read and extract the HTML source code from any webpage URL. By default returns raw HTML. When extractDesignTokens is true, uses a headless browser to extract CSS design tokens (colors, typography, visual effects), brand identity (logo, name, tagline), and suggested brand tokens. Use extractDesignTokens when the user wants to extract design elements or brand identity from a website.',
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the webpage to read and extract HTML source from'
        },
        extractDesignTokens: {
          type: 'boolean',
          description: 'When true, extracts CSS design tokens, brand identity, and suggested brand tokens in addition to HTML. Use update_brand_guidelines to apply the suggested tokens. Default: false'
        }
      },
      required: ["url"]
    }
  },
  execute: async (args: any, context?: any) => {
    // If extractDesignTokens is true, use CSS extraction
    if (args.extractDesignTokens) {
      return await agentModeService.extractCSSFromURL(args, context?.userId);
    }

    // Default: read raw HTML
    const result = await agentModeService.readFileContent(args.url);
    if (result.success === false) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${result.message}\n${result.error || ''}`
          }
        ],
        isError: true
      };
    }
    return {
      content: [
        {
          type: "text",
          text: result.content
        }
      ]
    };
  }
});

// --- Tools from utilityTools.ts ---
emmaToolRegistry.register({
  name: "analyze_crm_data",
  definition: {
    name: "analyze_crm_data",
    description: "Analyze CRM lead data and email engagement metrics (open rate, bounce rate, click rate, top leads, trends, etc.) using AI-powered code execution. Fetches all leads and email events for the specified list, then runs analysis per the instruction. Data files are cached for 30 minutes so repeated analysis on the same list is fast.",
    inputSchema: {
      type: "object",
      properties: {
        list_id: {
          type: "string",
          description: "The CRM lead list ID to analyze"
        },
        instruction: {
          type: "string",
          description: "What to analyze or compute from the CRM data (e.g. 'Calculate open rate, click rate, and bounce rate', 'Which leads are most engaged?', 'Show email activity trend by week')"
        },
        time_range_days: {
          type: "number",
          description: "Optional: limit email events to the last N days (e.g. 30, 90). Defaults to all-time if omitted."
        }
      },
      required: ["list_id", "instruction"]
    }
  },
  execute: async (args: any, context?: any) => {
    const { mcpFetch } = await import('../mcp/server/httpClient');
    const ctx = { userId: context?.userId, agentUserId: context?.agentUserId, isDelegatedAccess: context?.isDelegatedAccess };
    const data = await mcpFetch({
      method: 'POST',
      path: `/api/crm/lists/${args.list_id}/analyze`,
      body: { instruction: args.instruction, time_range_days: args.time_range_days },
      context: ctx,
      timeoutMs: 5 * 60 * 1000, // 5 min — Gemini code execution can take a while
    });
    return { content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] };
  }
});

emmaToolRegistry.register({
  name: "perform_data_analysis",
  definition: {
    name: "perform_data_analysis",
    description: 'Perform data analysis with code execution on files from URLs. If no files are attached, treat the information in the instruction as the complete dataset.',
    inputSchema: {
      type: "object",
      properties: {
        file_urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of file URLs to analyze (URLs from uploaded files or previous task results)'
        },
        analysis_instruction: {
          type: 'string',
          description: 'Description of the analysis task to perform on the provided files'
        }
      },
      required: ['file_urls', 'analysis_instruction']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.performDataAnalysis(args.file_urls, args.analysis_instruction, context?.userId);
  }
});

emmaToolRegistry.register({
  name: "create_html_file",
  definition: {
    name: "create_html_file",
    description: "Create a well-formatted HTML report, summary, analysis, audit, or any non-blog document. Use this for reports, weekly summaries, performance analyses, audits, GTM plans, or any structured HTML document that is NOT a blog article. For blog articles intended for CMS publishing, use create_blog_article instead. For a deployable landing page with a public URL hosted on Vercel, use generate_landing_page instead.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content_draft: { type: "string" },
        format_requirements: { type: "string" }
      },
      required: ["title", "content_draft"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createHtmlFile(args.title, args.content_draft, args.format_requirements || '', context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: "create_html_template",
  definition: {
    name: "create_html_template",
    description: "Create an HTML template from an existing HTML file or HTML content. The template will be saved to the Templates section where it can be edited and previewed. Use this when you want to convert HTML into a reusable template with variables like {{user_name}} or {{items_n}} for dynamic content. NOTE: Do NOT use this to create a new landing page from scratch — use generate_landing_page for deployable landing pages hosted on Vercel.",
    inputSchema: {
      type: "object",
      properties: {
        template_id: {
          type: "string",
          description: "Optional ID of an existing template to update. If provided, the template with this ID will be updated."
        },
        html_source: {
          type: "string",
          description: "Either an S3 URL to an HTML file, or raw HTML content string"
        },
        template_name: {
          type: "string",
          description: "Unique name for this template (e.g., 'welcome_email', 'product_landing_page')"
        },
        subject: {
          type: "string",
          description: "Email subject line (only required for email templates). Can include variables like {{user_name}}"
        },
        additional_instructions: {
          type: "string",
          description: "Optional instructions for how to process the HTML (e.g., 'Add variables for company name and logo', 'Make it more professional', 'Convert product list to array variables')"
        },
        types: {
          type: "array",
          items: { type: "string" },
          description: "Template types, e.g. ['email'], ['landing_page'], or ['email', 'landing_page']. Defaults to ['email']."
        }
      },
      required: ["html_source", "template_name"]
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createHtmlTemplate(
      args.html_source,
      args.template_id,
      args.template_name,
      args.subject,
      args.additional_instructions || '',
      context?.userId,
      context?.sessionId,
      args.types
    );
  }
});

emmaToolRegistry.register({
  name: "save_file",
  definition: {
    name: "save_file",
    description: 'Create and save a file with the provided content to S3, then return the file URL for sharing or reference. IMPORTANT: You must provide the COMPLETE file content as a string in the file_content parameter. This tool does NOT retrieve previously generated content - you must include the full content in this call.',
    inputSchema: {
      type: "object",
      properties: {
        file_name: {
          type: 'string',
          description: 'Name of the file to create (include appropriate extension like .txt, .md, .json, .csv, etc.)'
        },
        file_content: {
          type: 'string',
          description: 'REQUIRED: The complete content of the file to save as a string. You must provide the full file content - this tool cannot retrieve content from previous operations.'
        }
      },
      required: ["file_name", "file_content"]
    }
  },
  execute: async (args: any, context?: any) => {
    // Log parameters for debugging
    console.log('save_file tool called with args:', {
      file_name: args.file_name,
      file_content_type: typeof args.file_content,
      file_content_length: args.file_content?.length,
      has_file_content: args.file_content !== undefined,
      all_arg_keys: Object.keys(args)
    });

    return await agentModeService.saveFile(args.file_name, args.file_content, context?.userId, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'convert_to_pdf',
  definition: {
    name: 'convert_to_pdf',
    description: 'Convert an HTML file (or any URL) to a PDF and upload it to S3. Use this when the user wants a PDF version of a previously generated HTML file or checklist. Pass the direct S3 URL of the HTML file as source_url.',
    inputSchema: {
      type: 'object',
      properties: {
        source_url: {
          type: 'string',
          description: 'The URL of the HTML file to convert to PDF (e.g. an S3 URL from a previously saved HTML file)',
        },
        output_filename: {
          type: 'string',
          description: 'Desired filename for the PDF (without extension, e.g. "sentriq-readiness-checklist-v5")',
        },
      },
      required: ['source_url', 'output_filename'],
    },
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.convertToPdf(args.source_url, args.output_filename, context?.userId);
  },
});

// --- Tools from workflowTools.ts ---
emmaToolRegistry.register({
  name: 'create_work_plan',
  definition: {
    name: 'create_work_plan',
    description: 'Create a multi-step work plan for the current chat session. Use this to organize complex projects like client onboarding, campaign planning, or content creation workflows. IMPORTANT: Check if a work plan already exists in the session context before creating a new one. If a work plan already exists, use modify_work_plan instead to add or update steps.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the work plan (e.g., "Client Onboarding", "Q1 Campaign")'
        },
        steps: {
          type: 'array',
          description: 'Array of steps in the plan, each with stepCount (starting from 1), title, and optional description',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number starting from 1'
              },
              title: {
                type: 'string',
                description: 'Step title'
              },
              description: {
                type: 'string',
                description: 'Optional detailed description of the step'
              },
              requiredFunctionCalls: {
                type: 'array',
                description: 'Optional array of function names that must be called before marking this step as completed',
                items: {
                  type: 'string'
                }
              }
            },
            required: ['stepCount', 'title']
          }
        },
        autocomplete: {
          type: 'boolean',
          description: 'When true, Emma runs all steps automatically without pausing to ask the user for confirmation between steps. Defaults to false (Emma will present results after each step and wait for user approval before proceeding).'
        }
      },
      required: ['title', 'steps']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.createWorkPlan(args.title, args.steps, context?.sessionId, args.autocomplete);
  }
});

emmaToolRegistry.register({
  name: 'modify_work_plan',
  definition: {
    name: 'modify_work_plan',
    description: 'Add new steps or modify existing step details in the current work plan. Does not change step status - use set_work_plan_status for that.',
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          description: 'Array of steps to add or update',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number'
              },
              title: {
                type: 'string',
                description: 'Step title'
              },
              description: {
                type: 'string',
                description: 'Optional detailed description'
              },
              requiredFunctionCalls: {
                type: 'array',
                description: 'Optional array of function names that must be called before marking this step as completed',
                items: {
                  type: 'string'
                }
              }
            },
            required: ['stepCount', 'title']
          }
        },
        removeStepCounts: {
          type: 'array',
          description: 'Optional array of step numbers to remove',
          items: {
            type: 'number'
          }
        },
        autocomplete: {
          type: 'boolean',
          description: 'Optional. Update the autocomplete setting. When true, Emma runs all steps automatically without asking for user confirmation between steps.'
        }
      },
      required: ['steps']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.modifyWorkPlan(args.steps, args.removeStepCounts || [], context?.sessionId, args.autocomplete);
  }
});

emmaToolRegistry.register({
  name: 'set_work_plan_status',
  definition: {
    name: 'set_work_plan_status',
    description: 'Update the status of one or more steps in the work plan. Use this to track progress as you complete steps. You can update multiple steps at once.',
    inputSchema: {
      type: 'object',
      properties: {
        updates: {
          type: 'array',
          description: 'Array of step status updates',
          items: {
            type: 'object',
            properties: {
              stepCount: {
                type: 'number',
                description: 'Step number to update (1, 2, 3, etc.)'
              },
              status: {
                type: 'string',
                enum: ['pending', 'completed', 'skipped'],
                description: 'New status for the step'
              },
              notes: {
                type: 'string',
                description: 'Optional notes about what was accomplished or why the step was skipped'
              }
            },
            required: ['stepCount', 'status']
          }
        }
      },
      required: ['updates']
    }
  },
  execute: async (args: any, context?: any) => {
    return await agentModeService.setWorkPlanStatus(args.updates, context?.sessionId);
  }
});

emmaToolRegistry.register({
  name: 'send_for_review',
  definition: {
    name: 'send_for_review',
    description: 'Send the generated result content to the configured reviewer for approval. Sends a review email with a link to view and send the final result. You MUST call this after generating the content.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Email subject line for the result.'
        },
        content_url: {
          type: 'string',
          description: 'Optional URL to the generated content (e.g., S3 link to HTML file, image, or video).'
        },
        content_html: {
          type: 'string',
          description: 'Optional inline HTML content to include in the email body.'
        }
      },
      required: ['subject']
    }
  },
  execute: async (args: any, context?: any) => {
    if (!context?.userId || !context?.sessionId) {
      throw new Error("Missing user or session context");
    }
    return await agentModeService.sendForReview(
      args.subject,
      context.sessionId,
      context.userId,
      args.content_url,
      args.content_html
    );
  }
});

// ── Email Tool (unified, multi-provider) ───────────────────────────────────

emmaToolRegistry.register({
  name: 'email',
  definition: {
    name: 'email',
    description:
      'Read, search, and send emails across connected email accounts (Gmail, and more providers in the future). ' +
      'Always call list_connected_accounts first to get the account_id for the user\'s email account. ' +
      'Actions:\n' +
      '  \u2022 search \u2014 find emails by query. Gmail syntax: "from:alice@example.com subject:invoice newer_than:7d is:unread has:attachment"\n' +
      '  \u2022 list   \u2014 list recent emails from a folder (INBOX, SENT, TRASH, SPAM, or custom label)\n' +
      '  \u2022 get    \u2014 read full body of one or more emails using message_ids from search/list results\n' +
      '  \u2022 send   \u2014 send a new email or reply to an existing thread',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Email account ID from list_connected_accounts (e.g. the user\'s Gmail address)'
        },
        action: {
          type: 'string',
          enum: ['search', 'list', 'get', 'send'],
          description: 'Action to perform: search, list, get, or send'
        },
        query: {
          type: 'string',
          description: 'search action only \u2014 provider-specific search query. Gmail: "from:alice@example.com subject:invoice newer_than:7d"'
        },
        folder: {
          type: 'string',
          description: 'list action only \u2014 folder or label to list. Defaults to INBOX. Gmail examples: INBOX, SENT, TRASH, SPAM, or a custom label name'
        },
        message_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'get action only \u2014 one or more message IDs from search or list results. Pass all IDs you need in one call.'
        },
        max_results: {
          type: 'number',
          description: 'search/list actions \u2014 max emails to return (default 10 for search, 20 for list, max 50)'
        },
        to: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'send action \u2014 recipient email address(es)'
        },
        subject: {
          type: 'string',
          description: 'send action \u2014 email subject line'
        },
        body: {
          type: 'string',
          description: 'send action \u2014 email body content (plain text by default; set is_html=true for HTML)'
        },
        cc: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'send action \u2014 CC recipient(s)'
        },
        bcc: {
          type: ['string', 'array'],
          items: { type: 'string' },
          description: 'send action \u2014 BCC recipient(s)'
        },
        reply_to_message_id: {
          type: 'string',
          description: 'send action \u2014 message ID to reply to. Sets the thread and In-Reply-To/References headers automatically.'
        },
        is_html: {
          type: 'boolean',
          description: 'send action \u2014 set to true if body contains HTML. Defaults to false (plain text).'
        }
      },
      required: ['account_id', 'action']
    }
  },
  execute: async (args: any, context?: any) => {
    const { bootstrapEmailProviders, resolveEmailAccount } = await import('../services/emailProviderService');
    const { GmailNotConnectedError, GmailTokenRevokedError, GmailQuotaError, GmailBodyTooLargeError, GmailSendNotAuthorizedError } = await import('../services/gmailService');

    const userId = context?.userId;
    if (!userId) throw new Error('Missing user context');

    await bootstrapEmailProviders();

    try {
      const { provider } = await resolveEmailAccount(userId, args.account_id);

      switch (args.action) {
        case 'search': {
          if (!args.query) return { error: 'search action requires a query parameter.' };
          const maxResults = Math.min(args.max_results || 10, 50);
          const results = await provider.searchEmails(userId, args.account_id, args.query, maxResults);
          if (results.length === 0) return { message: 'No emails found matching your search.' };
          return { emails: results, count: results.length };
        }

        case 'list': {
          const maxResults = Math.min(args.max_results || 20, 50);
          const results = await provider.listEmails(userId, args.account_id, args.folder || 'INBOX', maxResults);
          if (results.length === 0) return { message: 'No emails found.' };
          return { emails: results, count: results.length };
        }

        case 'get': {
          const ids: string[] = Array.isArray(args.message_ids) ? args.message_ids : [];
          if (ids.length === 0) return { error: 'get action requires a message_ids array with at least one ID.' };
          const emails = await provider.getEmails(userId, args.account_id, ids);
          return { emails, count: emails.length };
        }

        case 'send': {
          if (!args.to) return { error: 'send action requires a "to" parameter.' };
          if (!args.subject) return { error: 'send action requires a "subject" parameter.' };
          if (!args.body) return { error: 'send action requires a "body" parameter.' };
          const result = await provider.sendEmail(userId, args.account_id, {
            to: args.to,
            subject: args.subject,
            body: args.body,
            cc: args.cc,
            bcc: args.bcc,
            replyToMessageId: args.reply_to_message_id,
            isHtml: args.is_html,
          });
          return { success: true, messageId: result.messageId, threadId: result.threadId };
        }

        default:
          return { error: `Unknown action "${args.action}". Valid actions: search, list, get, send.` };
      }
    } catch (err: any) {
      if (err instanceof GmailBodyTooLargeError) return { error: err.message };
      if (err instanceof GmailNotConnectedError || err instanceof GmailTokenRevokedError) return { error: err.message };
      if (err instanceof GmailQuotaError) return { error: err.message };
      if (err instanceof GmailSendNotAuthorizedError) return { error: err.message };
      if (err.message?.includes('not found') || err.message?.includes('not an email account')) return { error: err.message };
      throw err;
    }
  }
});

// ─── Account Memory Tools ────────────────────────────────────────

emmaToolRegistry.register({
  name: 'save_memory',
  definition: {
    name: 'save_memory',
    description: 'Save a fact about this account for future sessions. Use this when you learn something important about the user, their preferences, business context, or workflow patterns. Categories: preference (user likes/dislikes), history (past actions/decisions), insight (business learnings), workflow (process patterns).',
    inputSchema: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The fact to remember (max 2000 chars). Be specific and actionable.'
        },
        category: {
          type: 'string',
          enum: ['preference', 'history', 'insight', 'workflow'],
          description: 'Category for the memory fact.'
        }
      },
      required: ['content', 'category']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { userDb } = await import('../services/db');
    const user = await userDb.getUserById(userId);
    if (user?.memoryEnabled === false) {
      return { success: false, message: 'Memory is disabled for this account.' };
    }

    const memory = await accountMemoryDb.addMemory(
      userId,
      args.category,
      args.content,
      context?.sessionId
    );
    return {
      success: true,
      memoryId: memory.memoryId,
      message: `Saved memory: "${args.content.substring(0, 80)}${args.content.length > 80 ? '...' : ''}"`
    };
  }
});

emmaToolRegistry.register({
  name: 'delete_memory',
  definition: {
    name: 'delete_memory',
    description: 'Delete a specific memory by its ID. Use this when a fact is no longer accurate or relevant.',
    inputSchema: {
      type: 'object',
      properties: {
        memoryId: {
          type: 'string',
          description: 'The ID of the memory to delete.'
        }
      },
      required: ['memoryId']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    await accountMemoryDb.deleteMemory(userId, args.memoryId);
    return { success: true, message: `Memory ${args.memoryId} deleted.` };
  }
});

emmaToolRegistry.register({
  name: 'account_summary',
  definition: {
    name: 'account_summary',
    description: 'Get a full account overview. Returns: (1) account state — connected account count, knowledge base file count, saved config count, task count, active schedule count; (2) activity over the time period — sessions, assets (images, videos, reports, social posts, blogs), and results (published count, leads added, email delivery/clicks/replies/bounced, social media posts published/impressions/engagements/clicks).',
    inputSchema: {
      type: 'object',
      properties: {
        time_range: {
          type: 'string',
          enum: ['1d', '7d', '30d', '90d'],
          description: 'Time range for the summary. Defaults to 7d.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const timeRange = args.time_range || '7d';
    return await getAccountSummary(userId, timeRange);
  }
});

// --- SEO & Analytics Tools ---
emmaToolRegistry.register({
  name: 'get_seo_metrics',
  definition: {
    name: 'get_seo_metrics',
    description: 'Get SEO metrics for the user\'s configured domains. Returns Google Search Console data (clicks, impressions, CTR, average position, top queries, top pages, daily trends) and technical SEO score (PageSpeed). If the user has multiple domains configured, returns metrics for all domains unless a specific domain is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          enum: ['7d', '14d', '30d', '90d'],
          description: 'Time period for metrics. Default: 30d'
        },
        domain: {
          type: 'string',
          description: 'Specific domain to fetch metrics for (e.g. "example.com"). If omitted, returns metrics for all configured domains.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { fetchSearchConsoleMetrics } = await import('../services/seoService');
    return await fetchSearchConsoleMetrics(userId, args.timeframe || '30d', args.domain);
  }
});

emmaToolRegistry.register({
  name: 'get_website_analytics',
  definition: {
    name: 'get_website_analytics',
    description: 'Get Google Analytics (GA4) website analytics data. Returns sessions, users, page views, bounce rate, average session duration, traffic sources, top pages by engagement, and daily trends. If the user has multiple GA4 properties configured, returns analytics for all properties unless a specific property is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        timeframe: {
          type: 'string',
          enum: ['7d', '14d', '30d', '90d'],
          description: 'Time period for analytics. Default: 30d'
        },
        property_id: {
          type: 'string',
          description: 'Specific GA4 property ID to fetch analytics for (e.g. "123456789"). If omitted, returns analytics for all configured properties.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { fetchGoogleAnalyticsMetrics } = await import('../services/seoService');
    return await fetchGoogleAnalyticsMetrics(userId, args.timeframe || '30d', args.property_id);
  }
});

emmaToolRegistry.register({
  name: 'get_clarity_metrics',
  definition: {
    name: 'get_clarity_metrics',
    description: 'Get Microsoft Clarity project information and dashboard links for the user\'s configured projects. Returns project IDs, labels, and direct links to Clarity dashboards. If the user has multiple Clarity projects, returns info for all unless a specific project is requested.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: {
          type: 'string',
          description: 'Specific Clarity project ID to get info for. If omitted, returns info for all configured projects.'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const { fetchClarityProjectInfo } = await import('../services/seoService');
    return await fetchClarityProjectInfo(userId, args.project_id);
  }
});

// ─── CRM Enrichment tools ────────────────────────────────────────────────────

emmaToolRegistry.register({
  name: 'enrich_leads_preview',
  definition: {
    name: 'enrich_leads_preview',
    description: `Preview a CRM lead enrichment job. Processes 2 sample leads to show what the enrichment will produce before committing to the full batch.

Returns: totalLeads (total in list), leadsToProcess (would be enriched), alreadyEnriched (already have all fields), and samples (up to 2 leads with their enrichedFields). In enrichedFields, a null value means nothing was found for that field — tell the user "not found" rather than showing null. Show the sample results to the user and ask them to confirm quality before proceeding.

After showing the preview, ask the user to confirm before calling enrich_leads_execute.

Field and source guidance:
- output_fields: one snake_case field per distinct data point. Numeric values (dates, counts, amounts), categorical values (industry, funding stage), URLs (linkedin_url), and prose summaries (company_profile) each get their own field. When a prose request names sub-items ("profile describing industry, employee count, products"), create the prose field PLUS a separate field for each named item.
- sources_per_field: map each field to its source. Use "web_search" for company info, funding, tech stack, company LinkedIn URL. Use "linkedin" ONLY for the lead's personal LinkedIn profile (field name: linkedin_url). Use "existing_data" for fields derivable from existing lead data.
- field_descriptions: short natural-language description of each output field (what to find / where it lives). Required for any field that isn't a well-known canonical field — these descriptions guide the per-field web search. Common fields like industry, funding_stage, employee_count are auto-grouped and don't need a description; uncommon or domain-specific fields do (e.g. {"product_certifications": "ISO/SOC2/HIPAA certifications the company holds"}).
- linkedin_search_template: set to "{{firstName}} {{lastName}} {{company}}" when any field uses the "linkedin" source; omit otherwise.

Search queries are now built automatically per field group — do not pass a single global query template.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The CRM lead list ID to enrich.'
        },
        instruction: {
          type: 'string',
          description: 'Natural language instruction for what to enrich (e.g. "Determine company size and industry").'
        },
        output_fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of custom field names to populate in snake_case. One field per distinct data point — numeric values, categorical values, URLs, and prose summaries each get their own field.'
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['web_search', 'linkedin', 'existing_data'] },
          description: 'Union of all data sources used across all fields. web_search: searches the web. linkedin: looks up personal LinkedIn profiles. existing_data: infers from existing lead fields.'
        },
        sources_per_field: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string', enum: ['web_search', 'linkedin', 'existing_data'] }
          },
          description: 'Per-field source mapping. Key: field name, Value: array of sources for that field. "linkedin" source is ONLY for the lead\'s personal LinkedIn profile (linkedin_url). All other fields use "web_search". Falls back to job-level sources when absent for a field.'
        },
        field_descriptions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Short natural-language description of each output field. Key: field name (snake_case), Value: 1-line description of what to find. Required for fields that are not well-known canonical fields. Used by the clustering service to build per-field web searches. Example: {"product_certifications": "ISO/SOC2/HIPAA certifications the company holds", "ideal_customer_profile": "type of customer the company sells to"}'
        },
        linkedin_search_template: {
          type: 'string',
          description: 'LinkedIn person search query. Set to "{{firstName}} {{lastName}} {{company}}" when any field uses the "linkedin" source. Omit if no LinkedIn fields.'
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'] },
              value: {}
            },
            required: ['field', 'operator']
          },
          description: 'Optional filters to narrow which leads to enrich.'
        },
        force_overwrite: {
          type: 'boolean',
          description: 'If true, re-enrich leads that already have these fields populated. Default false.'
        },
        force_refresh_cache: {
          type: 'boolean',
          description: 'If true, bypass the raw data cache and re-fetch from web search / LinkedIn APIs. Use when cached data is known to be stale. Default false.'
        }
      },
      required: ['list_id', 'instruction', 'output_fields', 'sources']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const service = new CrmEnrichmentService();
    return await service.preview({
      listId: args.list_id,
      userId: context.userId,
      instruction: args.instruction,
      outputFields: args.output_fields,
      sources: args.sources,
      sourcesPerField: args.sources_per_field,
      linkedinSearchTemplate: args.linkedin_search_template,
      fieldDescriptions: args.field_descriptions,
      filters: args.filters,
      forceOverwrite: args.force_overwrite,
      forceRefreshCache: args.force_refresh_cache,
    });
  }
});

emmaToolRegistry.register({
  name: 'enrich_leads_execute',
  definition: {
    name: 'enrich_leads_execute',
    description: `Execute a CRM lead enrichment job. Processes all matching leads in parallel, enriching custom fields using AI and the specified data sources.

Progress updates are sent via Socket.IO in real-time. This call blocks until the full job completes, then returns final counts: processedCount, failedCount, skippedCount, and failureBreakdown. A lead is skipped when it has only a personal email (gmail, etc.) and no company name — check warnings for details.

Call enrich_leads_preview first to show the user what will happen before executing.

Pass the same output_fields, sources_per_field, field_descriptions, and linkedin_search_template used in the preview call.`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The CRM lead list ID to enrich.'
        },
        instruction: {
          type: 'string',
          description: 'Natural language instruction for what to enrich.'
        },
        output_fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of custom field names to populate in snake_case. One field per distinct data point — numeric values, categorical values, URLs, and prose summaries each get their own field.'
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['web_search', 'linkedin', 'existing_data'] },
          description: 'Union of all data sources used across all fields.'
        },
        sources_per_field: {
          type: 'object',
          additionalProperties: {
            type: 'array',
            items: { type: 'string', enum: ['web_search', 'linkedin', 'existing_data'] }
          },
          description: 'Per-field source mapping. Key: field name, Value: array of sources for that field. "linkedin" source is ONLY for the lead\'s personal LinkedIn profile (linkedin_url). All other fields use "web_search".'
        },
        field_descriptions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Short natural-language description of each output field. Key: field name (snake_case), Value: 1-line description of what to find. Required for non-canonical fields. Used by the clustering service to build per-field web searches.'
        },
        linkedin_search_template: {
          type: 'string',
          description: 'LinkedIn person search query. Set to "{{firstName}} {{lastName}} {{company}}" when any field uses the "linkedin" source. Omit if no LinkedIn fields.'
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string', enum: ['equals', 'not_equals', 'contains', 'is_empty', 'is_not_empty'] },
              value: {}
            },
            required: ['field', 'operator']
          },
          description: 'Optional filters to narrow which leads to enrich.'
        },
        force_overwrite: {
          type: 'boolean',
          description: 'If true, re-enrich leads that already have these fields populated. Default false.'
        },
        force_refresh_cache: {
          type: 'boolean',
          description: 'If true, bypass the raw data cache and re-fetch from web search / LinkedIn APIs. Use when cached data is known to be stale. Default false.'
        }
      },
      required: ['list_id', 'instruction', 'output_fields', 'sources']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const service = new CrmEnrichmentService();
    return await service.execute({
      listId: args.list_id,
      userId: context.userId,
      instruction: args.instruction,
      outputFields: args.output_fields,
      sources: args.sources,
      sourcesPerField: args.sources_per_field,
      linkedinSearchTemplate: args.linkedin_search_template,
      fieldDescriptions: args.field_descriptions,
      filters: args.filters,
      forceOverwrite: args.force_overwrite,
      forceRefreshCache: args.force_refresh_cache,
    }, context.socketId, context.socketEmit ? { socketEmit: context.socketEmit } : undefined);
  }
});

emmaToolRegistry.register({
  name: 'enrich_lead_custom',
  definition: {
    name: 'enrich_lead_custom',
    description: `Enrich a single CRM lead with custom fields on demand, without needing to kick off a whole-list enrichment job.

Use this when the user wants to fill in specific missing information on one lead (e.g. "find this person's LinkedIn headline and company size") rather than a bulk batch. It wraps the existing CRM enrichment pipeline with a batch of 1, sourcing from web_search and linkedin by default.

Pass one entry in custom_field_prompts per field you want populated. Each prompt is a natural-language description of what to find. The response includes enrichedValues — a map of field name to the found value (or null if nothing was found). Values are also persisted to the lead's customFields in DynamoDB. Always show enrichedValues to the user; if a value is null, tell them nothing was found for that field. Check warnings for skip reasons (e.g. personal email with no company).`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The CRM lead list ID containing the lead.'
        },
        lead_id: {
          type: 'string',
          description: 'The specific lead to enrich.'
        },
        custom_field_prompts: {
          type: 'array',
          description: 'One entry per custom field to populate. Each entry has a field_name (snake_case) and a prompt describing what to find.',
          items: {
            type: 'object',
            properties: {
              field_name: { type: 'string', description: 'Snake_case custom field name to populate, e.g. "company_size".' },
              prompt: { type: 'string', description: 'Natural language description of what to find for this field.' },
              data_type: { type: 'string', enum: ['text', 'number', 'date'], description: 'Expected data type. Defaults to text.' }
            },
            required: ['field_name', 'prompt']
          },
          minItems: 1
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ['web_search', 'linkedin', 'existing_data'] },
          description: 'Data sources to use. Defaults to ["web_search", "linkedin"] if omitted.'
        },
        force_overwrite: {
          type: 'boolean',
          description: 'If true, re-enrich fields that are already populated. Default true (custom enrichment is intentional).'
        }
      },
      required: ['list_id', 'lead_id', 'custom_field_prompts']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) {
      throw new Error('Authentication required: no user context');
    }
    const prompts: Array<{ field_name: string; prompt: string; data_type?: string }> = args.custom_field_prompts || [];
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error('custom_field_prompts must be a non-empty array');
    }

    const outputFields = prompts.map(p => p.field_name);
    const instruction = prompts
      .map(p => {
        const type = p.data_type && p.data_type !== 'text' ? ` (${p.data_type})` : '';
        return `- ${p.field_name}${type}: ${p.prompt}`;
      })
      .join('\n');
    // Pass per-field prompts to the cluster service as field descriptions so
    // any ungrouped fields get a search query tuned to what we're looking for.
    const fieldDescriptions: Record<string, string> = {};
    for (const p of prompts) {
      if (p.field_name && p.prompt) fieldDescriptions[p.field_name] = p.prompt;
    }
    const sources = Array.isArray(args.sources) && args.sources.length > 0
      ? args.sources
      : ['web_search', 'linkedin'];

    const { CrmEnrichmentService } = await import('../services/crmEnrichmentService');
    const { crmDb } = await import('../services/db');
    const service = new CrmEnrichmentService();
    const result = await service.execute({
      listId: args.list_id,
      userId: context.userId,
      instruction,
      outputFields,
      sources,
      leadIds: [args.lead_id],
      fieldDescriptions,
      forceOverwrite: args.force_overwrite !== false,
    }, context.socketId, context.socketEmit ? { socketEmit: context.socketEmit } : undefined);

    // Fetch the lead after enrichment so we can return the actual enriched values
    let enrichedValues: Record<string, string | null> = {};
    if (result.processedCount > 0) {
      try {
        const lead = await crmDb.getLeadById(args.list_id, args.lead_id);
        if (lead?.customFields) {
          for (const field of outputFields) {
            enrichedValues[field] = lead.customFields[field] ?? null;
          }
        }
      } catch {
        // Non-fatal — enrichment succeeded, values are in DB
      }
    }

    return {
      leadId: args.lead_id,
      listId: args.list_id,
      outputFields,
      enrichedValues,
      processedCount: result.processedCount,
      failedCount: result.failedCount,
      skippedCount: result.skippedCount,
      failureBreakdown: result.failureBreakdown,
      warnings: result.warnings,
      jobId: result.jobId,
    };
  }
});

// ─── Scheduled Chat tools (bridged from mcpToolRegistry / apiTools.ts) ───────
// These tools wrap REST endpoints via mcpFetch. Rather than duplicating
// definitions, we re-register them from the MCP server registry.
// Ensure apiTools has registered its tools before we try to bridge them.
import '../mcp/server/apiTools';
import { mcpToolRegistry } from '../mcp/server/registry';

// Also register get_visual_context in mcpToolRegistry (after the import above, which is needed
// for mcpToolRegistry to be available).
mcpToolRegistry.register(visualContextTool);

const bridgedToolNames = [
  // Scheduled Chat tools
  'list_scheduled_chats',
  'manage_scheduled_chat',
  'test_scheduled_chat',
  'get_scheduled_chat_test_history',
  'submit_scheduled_chat_variables',
  // Schedule Template tools
  'list_schedule_templates',
  'manage_schedule_template',
  'create_schedule_from_template',
  // Landing Page tools (v0 generation + management — file editing delegated to coding_agent)
  'generate_landing_page',
  'deploy_landing_page',
  'list_landing_pages',
  'get_landing_page',
  'delete_landing_page',
  'enable_lead_list_public_access',
  'duplicate_landing_page',
  'get_deployment_status',
  // 'list_landing_page_files' — removed: coding_agent handles file listing internally
  'get_landing_page_preview_url',
  'publish_landing_page_changes',
];

// ─── Admin-only tools (bridged from mcpToolRegistry / apiTools.ts) ───────────
const adminToolNames = [
  'list_predefined_work_plans',
  'manage_predefined_work_plan',
  'list_skills',
  'manage_skill',
  'get_chat_history',
  'list_all_clients',
  'assess_client_health',
  'manage_user_guide',
  'get_pr_digest',
  'freeze_user_account',
  'manage_scoring_judges',
  'manage_user_notes',
  'get_users_by_lifecycle_stage',
];

for (const toolName of bridgedToolNames) {
  const handler = mcpToolRegistry.getTool(toolName);
  if (handler) {
    emmaToolRegistry.register({
      name: handler.name,
      definition: handler.definition,
      execute: handler.execute,
    });
  } else {
    console.warn(`[emma/tools] Failed to bridge tool "${toolName}" — not found in mcpToolRegistry`);
  }
}

// ─── Coding Agent tool (sub-agent for code editing tasks) ───────────────────
emmaToolRegistry.register({
  name: 'coding_agent',
  definition: {
    name: 'coding_agent',
    description: 'Delegate a code editing task to a specialized coding agent. The coding agent pushes changes to a STAGING draft branch (not directly to production). This creates a Vercel preview deployment URL for the user to review. After calling this tool, ALWAYS tell the user: (1) changes are on a staging branch and NOT live yet, (2) provide the preview URL so they can review, (3) they can ask you to "publish" to push changes live. Use this for ANY task that involves modifying landing page code. IMPORTANT: After coding_agent returns, trust its result — do NOT attempt to verify by reading or listing landing page files yourself (e.g. list_landing_page_files, get_file_contents, read_landing_page_file). The coding agent already verified the changes. If it failed, call coding_agent again with a clearer task_description. Only call coding_agent ONCE per user request unless it explicitly fails. LOGO TIP: Always pass logo URLs directly in the task_description — the coding agent will use them in <img src="..."> tags. For public company logos use Google\'s favicon service (https://www.google.com/s2/favicons?domain={domain}&sz=128). For the user\'s own brand logo, look it up with read_brand_guidelines first and include the URL in the task.',
    inputSchema: {
      type: 'object',
      properties: {
        page_id: {
          type: 'string',
          description: 'The landing page ID to edit'
        },
        task_description: {
          type: 'string',
          description: 'Detailed description of what code changes to make. Include specific requirements, file paths if known, and any context about the desired outcome. Be as specific as possible.'
        }
      },
      required: ['page_id', 'task_description']
    }
  },
  execute: async (args: any, context?: any) => {
    // Auto-map common param name mistakes
    if (!args.page_id && args.landing_page_id) {
      args.page_id = args.landing_page_id;
    }
    if (!args.task_description && args.instructions) {
      args.task_description = args.instructions;
    }
    if (!args.page_id) {
      return { success: false, error: 'page_id is required. Provide the landing page ID to edit.' };
    }
    if (!args.task_description) {
      return { success: false, error: 'task_description is required. Provide a detailed description of the code changes to make.' };
    }

    const { runCodingAgent } = await import('../services/codingAgentService');
    const executeMcpTool = context?.service
      ? async (toolName: string, toolArgs: any) => {
        return context.service.executeTool(
          context.llmModel || 'anthropic.claude-sonnet-4-6',
          toolName,
          toolArgs,
          context.userId,
          context.sessionId
        );
      }
      : undefined;

    // Use a draft branch for staging — derive from session ID
    const sessionId = context?.sessionId || '';
    const draftBranch = sessionId ? `draft/${sessionId.substring(0, 16)}` : undefined;

    const result = await runCodingAgent(
      args.task_description,
      {
        pageId: args.page_id,
        userId: context?.userId,
        sessionId,
        llmModel: context?.llmModel || 'anthropic.claude-sonnet-4-6',
        socketEmit: context?.socketEmit,
        executeMcpTool,
        draftBranch,
      }
    );
    if (result.success) {
      return {
        success: true,
        message: result.message,
        iterations: result.iterations,
        previewUrl: result.previewUrl,
        branch: result.branch,
        is_staging: !!result.branch && result.branch !== 'main',
        note: result.branch && result.branch !== 'main'
          ? `Changes are on staging branch "${result.branch}". The user must review the preview URL and ask to publish before changes go live.`
          : undefined,
      };
    } else {
      return {
        success: false,
        error: result.message,
        iterations: result.iterations,
        previewUrl: result.previewUrl,
        branch: result.branch,
        is_staging: !!result.branch && result.branch !== 'main',
      };
    }
  }
});

// --- User Skill Creation ---
emmaToolRegistry.register({
  name: 'create_skill',
  definition: {
    name: 'create_skill',
    description: 'Create a new agent skill for the user. A skill is a named bundle of tools with an optional system prompt that customizes agent behavior. The skill starts as private and the user can submit it for platform review later via the Settings > Skills page.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the skill (e.g., "LinkedIn Post Creator from Latest News")'
        },
        description: {
          type: 'string',
          description: 'Description of what the skill does'
        },
        toolNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of tool names this skill can use (e.g., ["bravesearch_brave_news_search", "create_social_media_posts"])'
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional custom instructions for the agent when this skill is active'
        }
      },
      required: ['name', 'description', 'toolNames']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error('Authentication required: no user context');
    }
    // LLMs sometimes send "tools" instead of "toolNames", and may stringify the array
    let rawTools = args.toolNames ?? args.tools ?? [];
    if (typeof rawTools === 'string') {
      try { rawTools = JSON.parse(rawTools); } catch { rawTools = []; }
    }
    const toolNames: string[] = Array.isArray(rawTools) ? rawTools : [];
    const { skillService } = await import('../services/skillService');
    const skill = await skillService.createSkill(
      args.name,
      args.description,
      toolNames,
      args.systemPrompt,
      false
    );
    // Set ownership fields and re-save with toolNames explicitly preserved
    skill.ownerId = userId;
    skill.visibility = 'private';
    skill.isBuiltIn = false;
    skill.toolNames = toolNames;
    await skillService.updateSkill(skill);
    return {
      success: true,
      skillId: skill.skillId,
      name: skill.name,
      description: skill.description,
      toolNames: skill.toolNames,
      visibility: skill.visibility,
      message: `Skill "${skill.name}" created successfully. It is currently private. The user can submit it for platform review from Settings > Skills.`
    };
  }
});

emmaToolRegistry.register({
  name: 'save_work_plan',
  definition: {
    name: 'save_work_plan',
    description: 'Save a work plan to the user\'s library for future reuse. The plan starts as private and the user can submit it for platform review later via Settings > Work Plans. Use this after creating a work plan with create_work_plan when the user wants to keep it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Title of the work plan'
        },
        description: {
          type: 'string',
          description: 'Description of what the work plan accomplishes'
        },
        welcomeMessage: {
          type: 'string',
          description: 'Optional greeting shown when the plan starts'
        },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepCount: { type: 'number', description: 'Step number (1-based)' },
              title: { type: 'string', description: 'Step title' },
              description: { type: 'string', description: 'Step description' },
              requiredFunctionCalls: {
                type: 'array',
                items: { type: 'string' },
                description: 'Function names that must be called to complete this step (e.g. search_web, update_brand_guidelines)'
              },
              skillIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'Skill IDs to auto-install when this step becomes active'
              },
            },
            required: ['stepCount', 'title']
          },
          description: 'Array of steps in the work plan'
        }
      },
      required: ['title', 'steps']
    }
  },
  execute: async (args: any, context?: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error('Authentication required: no user context');
    }
    const { workPlanService } = await import('../services/workPlanService');

    // If there's a session work plan, merge requiredFunctionCalls/skillIds from it
    // because the LLM often omits these when calling save_work_plan
    let sessionWorkPlan: any = null;
    if (context?.sessionId) {
      try {
        const { chatbotDb } = await import('../services/chatbotService');
        const session = await chatbotDb.getChatSession(context.sessionId);
        if (session?.workPlan) {
          sessionWorkPlan = session.workPlan;
        }
      } catch {
        // Non-critical — proceed without session data
      }
    }

    // Normalize steps
    let steps = args.steps || [];
    if (typeof steps === 'string') {
      try { steps = JSON.parse(steps); } catch { steps = []; }
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('At least one step is required');
    }

    // Build a lookup of session step data by stepCount for merging
    const sessionStepMap = new Map<number, any>();
    if (sessionWorkPlan?.steps) {
      for (const s of sessionWorkPlan.steps) {
        sessionStepMap.set(s.stepCount, s);
      }
    }

    const plan = await workPlanService.createWorkPlan({
      title: args.title,
      description: args.description || '',
      welcomeMessage: args.welcomeMessage || '',
      steps: steps.map((s: any, i: number) => {
        const stepNum = s.stepCount || i + 1;
        const sessionStep = sessionStepMap.get(stepNum);
        return {
          stepCount: stepNum,
          title: s.title,
          description: s.description || '',
          requiredFunctionCalls: Array.isArray(s.requiredFunctionCalls) && s.requiredFunctionCalls.length > 0
            ? s.requiredFunctionCalls
            : (sessionStep?.requiredFunctionCalls || []),
          skillIds: Array.isArray(s.skillIds) && s.skillIds.length > 0
            ? s.skillIds
            : (sessionStep?.skillIds || []),
        };
      }),
      ownerId: userId,
      visibility: 'private',
      isBuiltIn: false,
    });
    return {
      success: true,
      planId: plan.planId,
      title: plan.title,
      steps: plan.steps.length,
      visibility: plan.visibility,
      message: `Work plan "${plan.title}" saved successfully. It is currently private. The user can submit it for platform review from Settings > Work Plans.`
    };
  }
});

// --- Report product issues tool ---

emmaToolRegistry.register({
  name: 'report_product_issues',
  definition: {
    name: 'report_product_issues',
    description: 'Report one or more product issues or bugs. Creates tracked items in the engineering sprint board and notifies the oncall team. Use this when users encounter errors, unexpected behavior, or want to request fixes. Batch multiple issues into a single call when possible.',
    inputSchema: {
      type: 'object',
      properties: {
        issues: {
          type: 'array',
          description: 'Array of issues to report',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short title for the issue (e.g., "Login page crashes on mobile")'
              },
              description: {
                type: 'string',
                description: 'Detailed description of the issue including steps to reproduce, expected behavior, and actual behavior'
              },
              priority: {
                type: 'string',
                enum: ['High', 'Medium', 'Low'],
                description: 'Priority level. Default: Medium'
              },
              pageUrl: {
                type: 'string',
                description: 'URL of the page where the issue occurred (optional)'
              }
            },
            required: ['title', 'description']
          },
          minItems: 1
        }
      },
      required: ['issues']
    }
  },
  execute: async (args: any, context: any) => {
    // Lazy imports to avoid pulling in heavy dependencies at module load time
    const { createOncallItem } = await import('../services/notionService');
    const { resendService } = await import('../services/resendService');

    const userId = context?.userId;
    if (!userId) {
      throw new Error('Authentication required to report issues');
    }

    const user = await userDb.getUserById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // isDelegatedAdmin is set when called via chatbotService (Emma sidebar).
    // isDelegatedAccess is set when called via agentModeService (agent mode chat).
    // In both cases, look up the admin email from the session's delegateInfo in DB.
    const isDelegate = context?.isDelegatedAdmin === true || context?.isDelegatedAccess === true;
    let adminEmail: string | undefined = context?.adminEmail;
    if (isDelegate && !adminEmail && context?.sessionId) {
      const { chatbotDb } = await import('../services/chatbotService');
      const session = await chatbotDb.getChatSession(context.sessionId);
      if (session?.delegateInfo?.isDelegated && session.delegateInfo.adminEmail) {
        adminEmail = session.delegateInfo.adminEmail;
      }
    }
    const isDelegatedAdmin = isDelegate && !!adminEmail;

    const results: Array<{ title: string; success: boolean; issueId?: string; error?: string }> = [];

    // Fetch once before the loop to avoid N DynamoDB reads for a batch of issues
    const { settingsService } = await import('../services/settingsService');
    const productIssueEmails = await settingsService.getJsonArraySetting('product_issue_emails', ['founders@agentweb.pro']);

    for (const issue of args.issues) {
      try {
        const issueContext: Record<string, any> = {
          'User Name': user.displayName || user.email,
          'User Email': user.email,
          'User ID': userId,
          'Priority': issue.priority || 'Medium',
          'Page URL': issue.pageUrl || 'N/A',
          'Session ID': context?.sessionId || 'N/A',
        };

        if (isDelegatedAdmin && adminEmail) {
          issueContext['Reported By (Admin)'] = adminEmail;
        }

        const result = await createOncallItem({
          title: issue.title,
          description: issue.description,
          additionalTags: ['Customer Reported'],
          context: issueContext,
        });

        // When an admin reports via delegate access, send only to the admin (not the customer).
        // The admin initiated the report, not the customer.
        const emailRecipients = isDelegatedAdmin && adminEmail
          ? [...productIssueEmails, adminEmail]
          : [...productIssueEmails, user.email];
        const emailGreeting = isDelegatedAdmin && adminEmail
          ? `Hi ${adminEmail}, you've submitted an issue report on behalf of ${user.displayName || user.email}.`
          : `Hi ${user.displayName || user.email}, we've received your issue report and the AgentWeb engineering team has been notified. We'll follow up if we need more details.`;

        await resendService.sendEmail({
          from: `${RESEND_SYSTEM_NAME} Support <${RESEND_SYSTEM_EMAIL}>`,
          to: emailRecipients,
          subject: `We received your issue: ${issue.title}`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
                <h2 style="margin: 0; color: #111;">Product Issue Report</h2>
              </div>
              <p style="color: #444;">${emailGreeting} The AgentWeb engineering team has been notified.</p>
              ${result.pageId ? `<div style="margin: 8px 0;"><strong>Issue ID:</strong> AGW-${result.pageId}</div>` : ''}
              <div style="margin: 8px 0;"><strong>Priority:</strong> ${issue.priority || 'Medium'}</div>
              <div style="margin: 8px 0;"><strong>Page URL:</strong> ${issue.pageUrl || 'N/A'}</div>
              <div style="background-color: #fff; border-left: 4px solid #4F46E5; padding: 15px; margin: 20px 0;">
                <div style="font-weight: 600; margin-bottom: 10px;">Description:</div>
                <div>${issue.description.replace(/\n/g, '<br>')}</div>
              </div>
            </div>
          `,
          replyTo: isDelegatedAdmin && adminEmail ? adminEmail : user.email,
        });

        results.push({ title: issue.title, success: true, issueId: `AGW-${result.pageId}` });
      } catch (err: any) {
        results.push({ title: issue.title, success: false, error: err.message });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    const summary = failCount === 0
      ? `All ${successCount} issue(s) have been reported and tracked. The engineering team has been notified.`
      : `${successCount} of ${results.length} issue(s) reported successfully. ${failCount} failed.`;

    return {
      success: failCount === 0,
      message: summary,
      results,
    };
  }
});

emmaToolRegistry.register({
  name: 'get_user_profile',
  definition: {
    name: 'get_user_profile',
    description: "Retrieve the current user's profile information, including their email address, display name, company name, and subscription type. Call this when the user asks about their account details or when you need to know who you're talking to.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  execute: async (_args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) {
      throw new Error("Authentication required: no user context");
    }
    const user = await userDb.getUserById(userId);
    if (!user) {
      return { error: 'User profile not found.' };
    }
    return {
      email: user.email,
      displayName: user.displayName || null,
      companyName: user.companyName || null,
      subscriptionType: user.subscriptionType || null,
    };
  }
});

// ---------------------------------------------------------------------------
// G2: CRM action tools — assign_lead, promote_to_deal, rotate_primary,
// get_hot_leads. These complement ask_crm (G1) by giving Emma the ability
// to actually mutate CRM state instead of just reading it.
// ---------------------------------------------------------------------------

async function resolveLeadForAction(
  listId: string,
  leadId: string,
  userId: string
): Promise<{ lead: any; list: any } | { error: string }> {
  if (!listId || !leadId) return { error: 'list_id and lead_id are required' };
  const list = await crmDb.getLeadListById(listId);
  if (!list) return { error: `Lead list ${listId} not found` };
  if ((list as any).userId && (list as any).userId !== userId) {
    return { error: 'Not authorized for this lead list' };
  }
  const lead = await crmDb.getLeadById(listId, leadId);
  if (!lead) return { error: `Lead ${leadId} not found in list ${listId}` };
  return { lead, list };
}

emmaToolRegistry.register({
  name: 'assign_lead',
  definition: {
    name: 'assign_lead',
    description: "Assign a lead (contact) to an account owner by setting the lead's accountOwnerUserId. Logs a contact.updated event so the timeline shows the reassignment. Use this when the user says things like 'give that lead to Matt' or 'reassign Acme to me'.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list containing the lead' },
        lead_id: { type: 'string', description: 'The ID of the lead to reassign' },
        account_owner_user_id: {
          type: 'string',
          description: 'The userId of the new account owner. Pass the same userId as the caller to assign to self.'
        },
      },
      required: ['list_id', 'lead_id', 'account_owner_user_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const resolved = await resolveLeadForAction(args.list_id, args.lead_id, userId);
    if ('error' in resolved) return resolved;
    const { lead } = resolved;

    const newOwner = String(args.account_owner_user_id || '').trim();
    if (!newOwner) return { error: 'account_owner_user_id is required' };

    const previousOwner = lead.accountOwnerUserId || null;
    if (previousOwner === newOwner) {
      return { success: true, noop: true, leadId: lead.leadId, accountOwnerUserId: newOwner };
    }

    try {
      await crmDb.updateLead(args.list_id, args.lead_id, { accountOwnerUserId: newOwner });
    } catch (err: any) {
      return { error: err?.message || 'Failed to update lead' };
    }

    // Best-effort event logging — never fail the assignment on log errors.
    try {
      const contactKey = lead.email ? normalizeContactId(lead.email) : `nocontact:${lead.leadId}`;
      await contactEventsDb.logEvent({
        contactId: contactKey,
        source: 'emma_session',
        eventType: 'contact.updated',
        sourceRecordId: `assign_lead:${lead.leadId}:${Date.now()}`,
        payload: {
          action: 'assign_lead',
          previousAccountOwnerUserId: previousOwner,
          accountOwnerUserId: newOwner,
          leadId: lead.leadId,
          listId: args.list_id,
          actorUserId: userId,
        },
      });
    } catch (err: any) {
      console.error('[assign_lead] event log failed', err?.message || err);
    }

    return {
      success: true,
      leadId: lead.leadId,
      accountOwnerUserId: newOwner,
      previousAccountOwnerUserId: previousOwner,
    };
  },
});

emmaToolRegistry.register({
  name: 'promote_to_deal',
  definition: {
    name: 'promote_to_deal',
    description: "Promote one or more leads (contacts) into a new Deal in the AW-Deals table. The first lead in `lead_ids` becomes the primary contact unless `primary_lead_id` is passed. Returns the created deal. Use this when the user says 'turn Acme into a deal', 'create a deal for these contacts', or similar.",
    inputSchema: {
      type: 'object',
      properties: {
        list_id: { type: 'string', description: 'The lead list that contains the leads being promoted' },
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'The leadIds to add to the new deal. Must be non-empty.',
        },
        primary_lead_id: { type: 'string', description: 'Optional — which leadId is the primary contact. Defaults to the first entry in lead_ids.' },
        deal_name: { type: 'string', description: 'Optional deal name / label (stored in notes for now).' },
        deal_value: { type: 'number', description: 'Optional dollar value of the deal' },
        expected_close: { type: 'string', description: 'Optional expected close date (ISO 8601 or YYYY-MM-DD)' },
        stage: {
          type: 'string',
          enum: [...DEAL_STAGES],
          description: "Optional initial stage. Defaults to 'Lead'.",
        },
      },
      required: ['list_id', 'lead_ids'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const listId: string = String(args.list_id || '').trim();
    const leadIds: string[] = Array.isArray(args.lead_ids) ? args.lead_ids.filter(Boolean) : [];
    if (!listId) return { error: 'list_id is required' };
    if (leadIds.length === 0) return { error: 'lead_ids must be a non-empty array' };

    // Validate leads exist + ownership, and collect company domains.
    const refs: { listId: string; leadId: string }[] = [];
    let companyDomain: string | undefined;
    for (const leadId of leadIds) {
      const resolved = await resolveLeadForAction(listId, leadId, userId);
      if ('error' in resolved) return resolved;
      refs.push({ listId, leadId });
      if (!companyDomain) {
        const raw = resolved.lead.email || '';
        const at = raw.indexOf('@');
        if (at > -1) companyDomain = raw.slice(at + 1).toLowerCase();
      }
    }

    const primary = args.primary_lead_id && leadIds.includes(args.primary_lead_id)
      ? args.primary_lead_id
      : leadIds[0];

    const stage: DealStage | undefined = args.stage;
    if (stage && !DEAL_STAGES.includes(stage)) {
      return { error: `Invalid stage '${stage}'. Must be one of ${DEAL_STAGES.join(', ')}` };
    }

    try {
      const notes = args.deal_name ? `name: ${String(args.deal_name).slice(0, 200)}` : undefined;
      const deal = await dealDb.promoteContactsToDeal(refs, {
        ownerUserId: userId,
        primaryContactId: primary,
        ...(companyDomain ? { companyDomain } : {}),
        ...(typeof args.deal_value === 'number' ? { dealValue: args.deal_value } : {}),
        ...(args.expected_close ? { expectedClose: String(args.expected_close) } : {}),
        ...(stage ? { stage } : {}),
        ...(notes ? { notes } : {}),
        source: 'emma_session',
      } as any);

      try {
        await contactEventsDb.logEvent({
          contactId: `deal:${deal.dealId}`,
          source: 'emma_session',
          eventType: 'deal.created',
          sourceRecordId: `promote_to_deal:${deal.dealId}`,
          dealId: deal.dealId,
          payload: {
            action: 'promote_to_deal',
            leadIds,
            primaryContactId: primary,
            dealName: args.deal_name || null,
            dealValue: typeof args.deal_value === 'number' ? args.deal_value : null,
            stage: deal.stage,
            actorUserId: userId,
          },
        });
      } catch (err: any) {
        console.error('[promote_to_deal] event log failed', err?.message || err);
      }

      return { success: true, deal };
    } catch (err: any) {
      return { error: err?.message || 'promote_to_deal failed' };
    }
  },
});

emmaToolRegistry.register({
  name: 'rotate_primary',
  definition: {
    name: 'rotate_primary',
    description: "Change the primary contact on an existing deal. The new primary must already be a contact on the deal OR a valid lead the caller owns; the tool adds them to the deal's contactIds if needed. Use this when the user says 'the main contact on Acme changed to Jane' or 'make Pat the primary on that deal'.",
    inputSchema: {
      type: 'object',
      properties: {
        deal_id: { type: 'string', description: 'The dealId to update' },
        new_primary_contact_id: { type: 'string', description: 'The leadId of the new primary contact' },
        list_id: { type: 'string', description: 'Optional — the lead list containing the new primary contact, used to mirror the isPrimary flag onto the lead row.' },
        old_primary_list_id: { type: 'string', description: 'Optional — the lead list containing the OLD primary contact, used to clear its isPrimary flag.' },
      },
      required: ['deal_id', 'new_primary_contact_id'],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const dealId = String(args.deal_id || '').trim();
    const newPrimary = String(args.new_primary_contact_id || '').trim();
    if (!dealId) return { error: 'deal_id is required' };
    if (!newPrimary) return { error: 'new_primary_contact_id is required' };

    try {
      const existing = await dealDb.getDeal(dealId);
      if (!existing) return { error: `Deal ${dealId} not found` };

      const refs: any = {};
      if (args.old_primary_list_id && existing.primaryContactId) {
        refs.oldPrimary = { listId: args.old_primary_list_id, leadId: existing.primaryContactId };
      }
      if (args.list_id) {
        refs.newPrimary = { listId: args.list_id, leadId: newPrimary };
      }

      const updated = await dealDb.rotatePrimary(dealId, userId, newPrimary, refs);

      try {
        await contactEventsDb.logEvent({
          contactId: `deal:${dealId}`,
          source: 'emma_session',
          eventType: 'deal.primary_rotated',
          sourceRecordId: `rotate_primary:${dealId}:${Date.now()}`,
          dealId,
          payload: {
            action: 'rotate_primary',
            previousPrimaryContactId: existing.primaryContactId,
            newPrimaryContactId: newPrimary,
            actorUserId: userId,
          },
        });
      } catch (err: any) {
        console.error('[rotate_primary] event log failed', err?.message || err);
      }

      return { success: true, deal: updated };
    } catch (err: any) {
      if (err instanceof DealAuthError) return { error: 'Not authorized for this deal' };
      if (err instanceof DealNotFoundError) return { error: `Deal ${dealId} not found` };
      return { error: err?.message || 'rotate_primary failed' };
    }
  },
});

emmaToolRegistry.register({
  name: 'get_hot_leads',
  definition: {
    name: 'get_hot_leads',
    description: "Return the user's highest-scoring leads across all their lists, ranked by heatScore (0-100). Optional filters for lifecycle stage, minimum heat score, and account-owner scope. Use this when the user asks 'who are my hottest leads', 'top prospects today', 'show me my MQLs with heat > 70'.",
    inputSchema: {
      type: 'object',
      properties: {
        lifecycle: {
          type: 'string',
          description: "Optional lifecycle filter (e.g. 'Lead', 'MQL', 'SQL', 'Customer'). Matches the lead's lifecycle field exactly.",
        },
        min_heat_score: {
          type: 'number',
          description: 'Optional minimum heatScore (0-100). Leads below this score are filtered out. Defaults to 0.',
        },
        owner_filter: {
          type: 'string',
          description: "Optional accountOwnerUserId filter. Pass a userId to only return leads owned by that user, or 'me' to filter to the caller.",
        },
        limit: {
          type: 'number',
          description: 'Max number of leads to return (default 20, max 100).',
        },
      },
      required: [],
    },
  },
  execute: async (args: any, context?: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) return { error: 'Authentication required' };

    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const minHeat = typeof args.min_heat_score === 'number' ? args.min_heat_score : 0;
    const lifecycleFilter = args.lifecycle ? String(args.lifecycle) : null;
    let ownerFilter: string | null = null;
    if (args.owner_filter) {
      ownerFilter = args.owner_filter === 'me' ? userId : String(args.owner_filter);
    }

    // Scan caller's lists and collect candidates. Ranking by heatScore desc.
    let lists: any[] = [];
    try {
      lists = (await crmDb.getLeadListsForUser(userId)) || [];
    } catch (err: any) {
      return { error: err?.message || 'Failed to load lead lists' };
    }

    const candidates: any[] = [];
    const scanCap = 500; // cap total leads we scan so this stays cheap
    let scanned = 0;
    for (const list of lists) {
      if (scanned >= scanCap) break;
      const page = await crmDb.getLeadsByListId((list as any).listId, Math.min(200, scanCap - scanned));
      const items: any[] = (page && (page as any).items) || [];
      scanned += items.length;
      for (const it of items) {
        const heat = typeof it.heatScore === 'number' ? it.heatScore : 0;
        if (heat < minHeat) continue;
        if (lifecycleFilter && it.lifecycle !== lifecycleFilter) continue;
        if (ownerFilter && it.accountOwnerUserId !== ownerFilter) continue;
        candidates.push({
          leadId: it.leadId,
          listId: it.listId,
          listName: (list as any).name || null,
          email: it.email || null,
          firstName: it.firstName || null,
          lastName: it.lastName || null,
          company: it.company || null,
          title: it.title || null,
          heatScore: heat,
          lifecycle: it.lifecycle || null,
          accountOwnerUserId: it.accountOwnerUserId || null,
          lastEngagementAt: it.lastEngagementAt || null,
        });
      }
    }

    candidates.sort((a, b) => (b.heatScore || 0) - (a.heatScore || 0));
    return {
      leads: candidates.slice(0, limit),
      count: Math.min(candidates.length, limit),
      scanned,
      filters: { lifecycle: lifecycleFilter, minHeatScore: minHeat, ownerFilter },
    };
  },
});

emmaToolRegistry.register({
  name: 'search_user_assets',
  definition: {
    name: 'search_user_assets',
    description: "Search for assets (images, videos, HTML reports) that were generated in the user's Agent Mode sessions. Returns matching assets with their URLs, filenames, creation dates, asset type, and the session they came from (sessionId + title). Use this when the user asks to find images, videos, reports, or files they've created.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['images', 'videos', 'htmlReports', 'all'],
          description: "Filter by asset type. Use 'all' or omit to return every type."
        },
        query: {
          type: 'string',
          description: 'Optional keyword to filter by filename (case-insensitive partial match).'
        }
      },
      required: []
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const assets = await chatbotDb.searchUserAssets(userId, args.type, args.query);

    if (assets.length === 0) {
      return { message: 'No assets found matching your criteria.', assets: [] };
    }

    return {
      count: assets.length,
      assets: assets.map(a => ({
        url: a.url,
        filename: a.filename,
        assetType: a.assetType,
        generatedAt: a.generatedAt,
        sessionId: a.sessionId,
        sessionTitle: a.sessionTitle,
      })),
    };
  }
});

emmaToolRegistry.register({
  name: 'log_contact_event',
  definition: {
    name: 'log_contact_event',
    description:
      "Log a natural-language activity event on a CRM contact's timeline. Use this when the user dictates a note like 'add a note that I called Jane and left a voicemail' or 'log that Acme sent over the signed contract'. The event shows up in the contact's Activity Timeline alongside auto-captured events (form submits, payments, meetings). Input: contactId (normalized email, e.g. 'jane@acme.com'), eventType (pick from known types — use 'manual.note' for freeform notes, 'meeting.attended' for calls, 'support.opened' for issues, etc), summary (1-line human-readable description), details (optional structured data).",
    inputSchema: {
      type: 'object',
      properties: {
        contactId: {
          type: 'string',
          description:
            "The contact to log against. Almost always the contact's lowercase email (e.g. 'jane@acme.com'). For leads without an email, use the fallback form 'nocontact:<leadId>'.",
        },
        eventType: {
          type: 'string',
          description:
            "Event type. Use 'manual.note' for freeform notes; 'meeting.attended' for call/meeting logs; 'support.opened' / 'support.resolved' for issues; 'engagement.email_clicked' etc for engagement events you know happened but weren't auto-captured. Defaults to 'manual.note' if omitted.",
        },
        summary: {
          type: 'string',
          description:
            "Short 1-line human-readable summary of the event. Shown verbatim on the timeline. E.g. 'Left voicemail — asked about enterprise pricing'.",
        },
        details: {
          type: 'object',
          description:
            'Optional structured data to attach to the event (duration, source, references, etc). Shown as metadata under the summary on the timeline.',
        },
      },
      required: ['contactId', 'summary'],
    },
  },
  execute: async (args: any, context: any) => {
    const userId: string | undefined = context?.userId || context?.agentUserId;
    if (!userId) {
      return { error: 'Authentication required: no user context' };
    }

    const contactId = typeof args.contactId === 'string' ? args.contactId.trim() : '';
    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    const eventType =
      typeof args.eventType === 'string' && args.eventType ? args.eventType : 'manual.note';

    if (!contactId) {
      return { error: 'contactId is required' };
    }
    if (!summary) {
      return { error: 'summary is required' };
    }

    const { logManualEvent, isKnownContactEventType } = await import(
      '../services/contactCaptureHooks'
    );

    // Accept unknown types (forward-compat) but surface a warning so the user
    // knows the timeline renderer may not have a template for it yet.
    const warning = isKnownContactEventType(eventType)
      ? undefined
      : `Unknown eventType "${eventType}" — logged, but the timeline renderer may show it as a generic row.`;

    const details =
      args.details && typeof args.details === 'object' && !Array.isArray(args.details)
        ? (args.details as Record<string, unknown>)
        : undefined;

    const result = await logManualEvent({
      contactId,
      eventType,
      summary,
      details,
      loggedByUserId: userId,
    });

    if (!result) {
      return { error: 'Failed to log contact event' };
    }

    return {
      success: true,
      eventId: result.event.eventId,
      eventType: result.event.eventType,
      contactId: result.event.contactId,
      deduplicated: result.deduplicated,
      ...(warning ? { warning } : {}),
    };
  },
});

for (const toolName of adminToolNames) {
  const handler = mcpToolRegistry.getTool(toolName);
  if (handler) {
    emmaToolRegistry.register({
      name: handler.name,
      definition: handler.definition,
      execute: handler.execute,
    });
  } else {
    console.warn(`[emma/tools] Failed to bridge admin tool "${toolName}" — not found in mcpToolRegistry`);
  }
}

// Login credentials tool — lets Emma retrieve saved website credentials for browser automation
emmaToolRegistry.register({
  name: 'get_login_credentials',
  definition: {
    name: 'get_login_credentials',
    description: 'Retrieve saved login credentials for a website domain. Use this when you need to log into a website during browser automation. Credentials must be pre-saved by the user in Settings > Login Credentials. Never ask the user to paste passwords in chat.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: {
          type: 'string',
          description: 'The domain of the website to get credentials for (e.g. "linkedin.com", "app.hubspot.com")'
        }
      },
      required: ['domain']
    }
  },
  execute: async (args: any, context: any) => {
    const userId = context?.userId || context?.agentUserId;
    if (!userId) throw new Error('Authentication required');

    const domain = (args.domain || '').toLowerCase().trim();
    if (!domain) return { error: 'domain is required' };

    const { DynamoDB } = await import('aws-sdk');
    const { decryptPassword } = await import('../utils/crypto');
    const dynamodb = new DynamoDB.DocumentClient();
    const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';

    // Extract base domain for fuzzy matching (strip www. and subdomains down to registrable domain)
    const baseDomain = domain.replace(/^www\./, '');

    const result = await dynamodb.query({
      TableName: `${TABLE_PREFIX}AW-Configs`,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'attribute_not_exists(isApiConfig) OR isApiConfig = :false',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':false': false
      }
    }).promise();

    const items = result.Items || [];

    // Match by exact domain or base domain suffix
    const match = items.find((c: any) => {
      const w = (c.website || '').toLowerCase();
      return w === domain || w === baseDomain || domain.endsWith('.' + w) || baseDomain.endsWith('.' + w);
    });

    if (!match) {
      const saved = items.filter((c: any) => !c.isApiConfig).map((c: any) => c.website).join(', ');
      return {
        error: `No credentials saved for "${domain}". Please go to Settings > Login Credentials to save them first.`,
        savedDomains: saved || 'none'
      };
    }

    const encrypted = match.encryptedPassword || match.password;
    if (!encrypted) {
      return { error: `Credentials found for "${match.website}" but no password is stored.` };
    }

    try {
      const { password } = decryptPassword(encrypted);
      return {
        username: match.username,
        password,
        domain: match.website
      };
    } catch {
      return { error: `Failed to decrypt credentials for "${match.website}". The saved credentials may be corrupted.` };
    }
  }
});

emmaToolRegistry.register({
  name: 'import_leads_from_search',
  definition: {
    name: 'import_leads_from_search',
    description: `Search LinkedIn for people and import the results directly into a CRM lead list.
Uses the user's connected LinkedIn account if available, otherwise falls back to platform-wide outreach accounts — so this works even without a personal LinkedIn connection.

Use this when the user wants to:
- Find leads matching a job title, company, location, industry, school, or keyword
- Populate a CRM list with discovered prospects
- Discover new contacts to reach out to

Free-text company/location/industry/school are auto-resolved to LinkedIn entity IDs by the backend (via the search-parameter resolver), giving precise structured filtering. Pass keywords ONLY for free-text broad search — when you have structured filters, the backend handles Unipile's keyword requirement transparently.

For more than ~30 results from a single query, use the cursor returned in the response to paginate through subsequent pages.

When you make multiple sequential import calls, trust the "list_total_after_import" field on each response for the actual list size — do NOT sum the per-call "imported" values across calls, because the same lead can match multiple queries and is correctly deduplicated by the backend. Summing produces an inflated count.

Setting auto_enrich=true queues a background email-finder job for the newly imported leads — the response then includes "autoEnrichJobId" so the caller can poll job status. When auto_enrich is false (default), no background work is started and you should recommend enriching the list with "Enrich with Web" to fill in missing details like email addresses.

Response keys:
- imported / skipped / errors / total — per-call counts (do not sum across calls)
- list_total_after_import — actual post-import list size (trust this for cumulative counts)
- cursor — pagination cursor for the next page of the same query (null when no more results)
- importedLeads — array of the first 5 imported lead summaries (firstName, lastName, linkedin, title, company), useful for rendering a quick preview without a follow-up read
- autoEnrichJobId — present only when auto_enrich=true AND at least 1 new lead was imported AND the background job was successfully queued`,
    inputSchema: {
      type: 'object',
      properties: {
        list_id: {
          type: 'string',
          description: 'The CRM lead list ID to import leads into. Required.'
        },
        keywords: {
          type: 'string',
          description: 'Optional free-text search keywords. Omit when using structured filters — the backend will synthesize a keyword from your most-specific filter (title > company > location > industry > school) so the Unipile classic-search keyword requirement is satisfied transparently.'
        },
        title: {
          type: 'string',
          description: 'Job title filter (e.g. "CTO", "VP Sales").'
        },
        company: {
          type: 'string',
          description: 'Company name filter — free text, auto-resolved to a LinkedIn company id if no company_id is provided.'
        },
        company_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn company entity ID — when provided, skips the resolver.'
        },
        location: {
          type: 'string',
          description: 'Location filter — free text (e.g. "San Francisco Bay Area"), auto-resolved to a LinkedIn location entity id if no location_id is provided.'
        },
        location_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn location entity ID — when provided, skips the resolver.'
        },
        industry: {
          type: 'string',
          description: 'Industry filter — free text, auto-resolved to a LinkedIn industry entity id if no industry_id is provided.'
        },
        industry_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn industry entity ID — when provided, skips the resolver.'
        },
        school: {
          type: 'string',
          description: 'School filter — free text, auto-resolved to a LinkedIn school entity id if no school_id is provided.'
        },
        school_id: {
          type: 'string',
          description: 'Optional pre-resolved LinkedIn school entity ID — when provided, skips the resolver.'
        },
        search_url: {
          type: 'string',
          description: 'A LinkedIn search URL copied from the browser. Overrides keywords/title/company/etc.'
        },
        cursor: {
          type: 'string',
          description: 'Pagination cursor for fetching the next page of results from a previous import_leads_from_search call. Use the cursor value returned in the previous response to fetch the next ~30 results from the same query.'
        },
        limit: {
          type: 'number',
          description: 'Maximum number of leads to import. Defaults to 20, max 500.'
        },
        auto_enrich: {
          type: 'boolean',
          description: 'When true, after import, queue a background email-finder job for the new leads. Returns autoEnrichJobId in the response. Default: false.'
        }
      },
      required: ['list_id']
    }
  },
  execute: async (args: any, context: any) => {
    if (!context?.userId) throw new Error('Authentication required');
    const limit = Math.min(args.limit ?? 20, 500);
    return agentModeService.importLeadsFromSearch(context.userId, {
      listId: args.list_id,
      keywords: args.keywords,
      search_url: args.search_url,
      title: args.title,
      company: args.company,
      company_id: args.company_id,
      location: args.location,
      location_id: args.location_id,
      industry: args.industry,
      industry_id: args.industry_id,
      school: args.school,
      school_id: args.school_id,
      cursor: args.cursor,
      limit,
      auto_enrich: args.auto_enrich,
    });
  }
});
