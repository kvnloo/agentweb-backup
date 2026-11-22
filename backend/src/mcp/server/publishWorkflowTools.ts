/** ENG-1005: job-shaped publishing, planning, and scheduling over authenticated REST. */
import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { publishWithdrawnMidFlight } from '../../utils/scheduledPublishConsentGuard';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const object = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const failed = (error: string, extra: object = {}) => jsonResult({ status: 'failed', published: false, url: null, error, ...extra });
const select = (args: any, keys: string[]) => Object.fromEntries(keys.filter(key => args?.[key] !== undefined).map(key => [key, args[key]]));
const publishProperty = { type: 'boolean', default: false, description: 'Set true only after approval to publish. Otherwise returns a draft preview without posting.' };

function liveUrl(value: any): string | null {
  for (const candidate of [value?.post_url, value?.url, value?.data?.postUrl, value?.data?.url]) {
    if (!text(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch { /* An absent/malformed URL is not proof of a live publication. */ }
  }
  return null;
}

function publicationResult(result: any, preview: object) {
  if (result?.success !== true) return failed('Publication failed.', { ...preview, result });
  const url = liveUrl(result);
  if (!url) return jsonResult({ published: true, status: 'url_unavailable', url: null, ...preview, result,
    message: 'The publisher reported success but returned no live URL. Do not retry publication.' });
  return jsonResult({ published: true, url, ...preview });
}

mcpToolRegistry.register({
  name: 'emma_publish_social_post',
  requiresUserAccount: true,
  definition: {
    name: 'emma_publish_social_post',
    description: 'Prepare a social post and preview its content; publish to a connected account only with publish true. Omit account_id to see connected accounts. Do NOT use for blog articles — use emma_publish_blog_post.',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: { type: 'string', description: 'Connected account ID. Omit to choose from connected accounts.' },
        content: { type: 'string', description: 'Composed post text to validate and preview or publish.' },
        media_urls: { type: 'array', items: { type: 'string' }, description: 'Optional media URLs.' },
        publish: publishProperty,
      },
      required: [],
    },
  },
  execute: async (args: any, context: any) => {
    if (!text(args?.account_id)) {
      const accounts: any = await mcpFetch({ method: 'GET', path: '/api/oauth/connected-accounts', context: ctx(context) });
      return jsonResult({ published: false, accounts: accounts?.accounts ?? accounts });
    }
    if (!text(args?.content)) return failed('content must be non-empty post text.');
    if (args.media_urls !== undefined && (!Array.isArray(args.media_urls) || !args.media_urls.every(text))) {
      return failed('media_urls must contain URL strings.');
    }
    const draft = { account_id: args.account_id, content: args.content.trim(), media_urls: args.media_urls ?? [] };
    if (args.publish !== true) return jsonResult({ published: false, ...draft });
    const withdrawn = await publishWithdrawnMidFlight(context);
    if (withdrawn) return jsonResult(withdrawn);
    const posted: any = await mcpFetch({ method: 'POST', path: '/api/emma/post-on-account', context: ctx(context), body: draft });
    return publicationResult(posted, draft);
  },
});

mcpToolRegistry.register({
  name: 'emma_publish_blog_post',
  requiresUserAccount: true,
  definition: {
    name: 'emma_publish_blog_post',
    description: 'Prepare a blog article from a title and Markdown draft. Defaults to a local content preview. With publish true, creates the complete article and publishes it to the connected CMS in one call, returning the live URL. Do NOT use for social posts — use emma_publish_social_post.',
    inputSchema: {
      type: 'object',
      properties: {
        title_draft: { type: 'string', description: 'Draft article title.' },
        content_draft: { type: 'string', description: 'Composed article in Markdown.' },
        length: { type: 'string', enum: ['short', 'medium', 'long'], default: 'medium' },
        researchContext: { type: 'string', description: 'Optional research context.' },
        requirements: { type: 'string', description: 'Article requirements, links, and branding.' },
        style: { type: 'string', enum: ['default', 'substack'], default: 'default' },
        deep_research: { type: 'boolean', default: false },
        author: { type: 'string', description: 'Optional CMS author.' },
        categories: { type: 'array', items: { type: 'string' }, description: 'CMS categories for publication.' },
        publish: publishProperty,
      },
      required: ['title_draft', 'content_draft'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!text(args?.title_draft) || !text(args?.content_draft)) return failed('title_draft and content_draft must be non-empty text.');
    const draft = { title: args.title_draft.trim(), content: args.content_draft.trim() };
    if (args.publish !== true) return jsonResult({ published: false, ...draft });
    if (!Array.isArray(args.categories) || args.categories.length === 0 || !args.categories.every(text)) {
      return failed('Provide categories before publishing the article.', draft);
    }
    const created: any = await mcpFetch({
      method: 'POST', path: '/api/emma/create-blog-article', context: ctx(context),
      body: { ...select(args, ['length', 'researchContext', 'requirements', 'style', 'deep_research']), title_draft: draft.title, content_draft: draft.content },
    });
    const article = created?.data;
    if (created?.success !== true || !object(article) || ![article.title, article.description, article.heroImageUrl, article.htmlUrl].every(text)) {
      return failed('Article creation did not return the required publication assets.', { ...draft, result: created });
    }
    const withdrawn = await publishWithdrawnMidFlight(context);
    if (withdrawn) return jsonResult({ ...withdrawn, preview_url: article.htmlUrl });
    const published: any = await mcpFetch({
      method: 'POST', path: '/api/emma/publish-blog-article', context: ctx(context),
      body: { title: article.title, description: article.description, hero_image_url: article.heroImageUrl,
        blog_html_url: article.htmlUrl, status: 'published', ...select(args, ['author', 'categories']) },
    });
    return publicationResult(published, { preview_url: article.htmlUrl, title: article.title });
  },
});

const itemProperties = {
  title: { type: 'string', description: 'Title.' },
  description: { type: 'string', description: 'Description.' },
  dri: { type: 'string', description: 'Accountable owner email.' },
  dueDate: { type: 'string', description: 'Due date.' },
};
const itemFields = Object.keys(itemProperties);

mcpToolRegistry.register({
  name: 'emma_create_gtm_plan',
  requiresUserAccount: true,
  definition: {
    name: 'emma_create_gtm_plan',
    description: 'Create a GTM plan with phases and their work items in one call. Pass plan_id to update an existing plan, and phase_id to append work to an existing phase. Do NOT use for executing or scheduling the work.',
    inputSchema: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'Existing plan ID to update; omit to create.' },
        title: itemProperties.title,
        description: itemProperties.description,
        dri: itemProperties.dri,
        phases: { type: 'array', items: { type: 'object', properties: {
          ...itemProperties,
          phase_id: { type: 'string', description: 'Existing phase ID; omit to create a phase with title.' },
          work_items: { type: 'array', items: { type: 'object', properties: itemProperties, required: ['title'] } },
        } } },
      },
      required: [],
    },
  },
  execute: async (args: any, context: any) => {
    const phases = args?.phases ?? [];
    if ((!text(args?.plan_id) && !text(args?.title)) || !Array.isArray(phases) || phases.some(phase =>
      !object(phase) || (!text(phase.phase_id) && !text(phase.title)) ||
      (phase.work_items !== undefined && (!Array.isArray(phase.work_items) || phase.work_items.some((item: any) => !object(item) || !text(item.title))))
    )) return failed('Provide a plan title (or plan_id), phase titles (or phase_id), and work item titles.');

    const c = ctx(context);
    let plan: any = await mcpFetch({
      method: text(args.plan_id) ? 'PUT' : 'POST',
      path: text(args.plan_id) ? `/api/gtm-plan/${encodeURIComponent(args.plan_id)}` : '/api/gtm-plan',
      context: c, body: select(args, ['title', 'description', 'dri']),
    });
    const planId = plan?.data?.planId;
    if (plan?.success !== true || !text(planId)) return failed('Plan request did not return a plan ID.', { result: plan });
    const base = `/api/gtm-plan/${encodeURIComponent(planId)}`;
    for (const phase of phases) {
      let phaseId = phase.phase_id;
      if (!text(phaseId)) {
        const previous = new Set(Array.isArray(plan?.data?.phases)
          ? plan.data.phases.filter((p: any) => object(p) && text(p.id)).map((p: any) => p.id) : []);
        plan = await mcpFetch({ method: 'POST', path: `${base}/phases`, context: c, body: select(phase, itemFields) });
        const added = Array.isArray(plan?.data?.phases) ? plan.data.phases.filter((p: any) =>
          object(p) && text(p.id) && !previous.has(p.id) && p.title === phase.title) : [];
        if (plan?.success !== true || added.length !== 1) return failed('Phase request did not identify one new phase.', { plan_id: planId, result: plan });
        phaseId = added[0].id;
      }
      // The existing REST route creates ONE item per request (despite the granular tool's plural name).
      for (const item of phase.work_items ?? []) {
        plan = await mcpFetch({ method: 'POST', path: `${base}/phases/${encodeURIComponent(phaseId)}/work-items`, context: c, body: select(item, itemFields) });
        if (plan?.success !== true) return failed('Work item creation failed.', { plan_id: planId, phase_id: phaseId, result: plan });
      }
    }
    return jsonResult({ plan_id: planId, plan: plan.data });
  },
});

mcpToolRegistry.register({
  name: 'emma_schedule_recurring_work',
  requiresUserAccount: true,
  definition: {
    name: 'emma_schedule_recurring_work',
    description: 'Schedule recurring work directly from a prompt and daily, weekly, or monthly cadence. No template is needed. Supply variable_values for any {{variables}}; missing names are returned explicitly. Do NOT use for a one-off task or to modify an existing schedule.',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_name: { type: 'string', description: 'Schedule name.' },
        starting_message: { type: 'string', description: 'Work to perform each run. Do not request email delivery here when email_notifications is set; the schedule sends results automatically.' },
        cadence: { type: 'string', enum: ['daily', 'weekly', 'monthly'], description: 'How often to run.' },
        next_run_time: { type: 'string', description: 'Optional ISO 8601 first run time.' },
        timezone: { type: 'string', description: 'Optional IANA timezone.' },
        email_notifications: { type: 'array', items: { type: 'string' }, description: 'Result notification recipients.' },
        required_function_calls: { type: 'array', items: { type: 'string' }, description: 'Tools each run must execute. Include any requested delivery tools.' },
        variable_values: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for {{variables}} in the prompt.' },
      },
      required: ['schedule_name', 'starting_message', 'cadence'],
    },
  },
  execute: async (args: any, context: any) => {
    if (!text(args?.schedule_name) || !text(args?.starting_message) || !['daily', 'weekly', 'monthly'].includes(args?.cadence)) {
      return failed('Provide schedule_name, starting_message, and a daily, weekly, or monthly cadence.');
    }
    // Match the scheduled-chat controller's placeholder syntax; the create route infers definitions.
    const variables = Array.from(args.starting_message.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g), (match: any) => match[1] as string);
    const missing = [...new Set(variables)].filter(name => !Object.prototype.hasOwnProperty.call(args.variable_values ?? {}, name) || !text(args.variable_values[name]));
    if (missing.length) return jsonResult({ status: 'needs_variables', missing_variables: missing });
    const body: any = { scheduleName: args.schedule_name, startingMessage: args.starting_message, scheduleFrequency: args.cadence };
    for (const [source, target] of Object.entries({ next_run_time: 'nextRunTime', timezone: 'timezone', email_notifications: 'emailNotifications', required_function_calls: 'requiredFunctionCalls', variable_values: 'variableValues' })) {
      if (args[source] !== undefined) body[target] = args[source];
    }
    const schedule: any = await mcpFetch({ method: 'POST', path: '/api/agent-mode/scheduled-chats', context: ctx(context), body });
    if (!text(schedule?.scheduleId)) return failed('Schedule creation did not return a schedule ID.', { result: schedule });
    return jsonResult({ ...schedule, schedule_id: schedule.scheduleId });
  },
});

export const PUBLISH_WORKFLOW_TOOL_NAMES = [
  'emma_publish_social_post',
  'emma_publish_blog_post',
  'emma_create_gtm_plan',
  'emma_schedule_recurring_work',
] as const;
