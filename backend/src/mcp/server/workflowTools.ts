/**
 * Workflow Tools — the job-shaped MCP surface (ENG-982, tranche 1 of 3).
 *
 * The external tool surface grew to ~67 listed tools named after resources and
 * CRUD verbs (`manage_task`, `manage_leads`, `manage_gtm_plan`, `list_*`). Two
 * costs fall out of that:
 *
 *   1. Every connected tool's schema loads into the model's context each turn.
 *      Selection accuracy collapses across dozens of near-identical options.
 *   2. Claude's connector directory cold-starts its ranking on tool names and
 *      descriptions, so the metadata IS the discovery signal.
 *
 * Anthropic's guidance: "Instead of implementing list_users, list_events, and
 * create_event tools, consider implementing a schedule_event tool which finds
 * availability and schedules an event" — build a few tools targeting specific
 * high-impact workflows.
 *
 * Design rules these all follow:
 *   - `emma_` prefix, so a caller with several MCP servers connected can tell
 *     whose tool this is at a glance.
 *   - verb + object, named for the OUTCOME. Nothing is `manage_*`, and nothing
 *     takes an `action:` enum — a model should not have to read a schema to
 *     discover that a verb exists.
 *   - descriptions say when NOT to use the tool, because selection errors are
 *     what actually break agent flows.
 *   - every call goes through the JWT-authed REST layer via `mcpFetch`, exactly
 *     as apiTools.ts does. No direct service calls, so the IDOR boundary and
 *     ENG-973's quota gate both still apply.
 *
 * Additive only: this file registers new tools and removes nothing. Unlisting
 * the granular catalogue behind tool search is ENG-983.
 */

import { mcpToolRegistry } from './registry';
import { mcpFetch } from './httpClient';
import { ctx, jsonResult } from './toolHelpers';
import { resolveClientScopedContext } from './adminClientScope';
import { withoutSignedStorageLinks } from './knowledgeBaseParams';

/**
 * Read one profile section.
 *
 * EVERY thrown error is an operational failure. There is deliberately no
 * "missing means unconfigured" case: these endpoints return **200** when a
 * section is simply not filled in, and reserve 404 for *User not found*
 * (`routes/brand.ts` — 401 no email, 404 user missing, 200 otherwise). So an
 * exception here never means "unconfigured", and treating one as such would
 * report a missing-user failure as an empty brand.
 *
 * That distinction matters because an agent told the brand is empty will
 * cheerfully invent one. "Not configured" is expressed by the 200 body's own
 * contents, not by an exception.
 */
async function section(name: string, path: string, identity: any) {
  try {
    return {
      name,
      data: await mcpFetch({ method: 'GET', path, context: identity }),
      error: undefined as string | undefined,
    };
  } catch (err: any) {
    return { name, data: null, error: String(err?.message ?? err) };
  }
}

/**
 * Flattens the raw /api/brand/guidelines and /api/market-strategy bodies into one
 * named, machine-readable export (ENG-3122). Read-only mapping of fields those
 * routes already store; nothing is derived or invented. A section that could not
 * be read yields null fields here, and the caller reports it under `unavailable`.
 */
export function buildBrandExport(brandBody: any, strategyBody: any) {
  const b = brandBody?.brandData ?? {};
  const s = strategyBody?.data ?? {};
  const attachments: any[] = Array.isArray(brandBody?.attachments) ? brandBody.attachments : [];
  const val = (v: any) => (v === undefined || v === '' ? null : v);
  const logoUrls = [
    b.logoUrl,
    ...attachments.filter(a => a?.type === 'logo' || a?.type === 'secondaryLogo').map(a => a?.url),
  ].filter((u): u is string => typeof u === 'string' && u.length > 0);
  return {
    brand_name: val(b.brandName),
    tagline: val(b.tagline),
    value_proposition: val(b.valueProposition),
    domain: val(b.domain),
    primary_color: val(b.primaryColor),
    primary_color_end: val(b.primaryColorEnd),
    secondary_color: val(b.secondaryColor),
    font_family: val(b.fontFamily),
    tone_of_voice: val(b.toneOfVoice),
    personality: val(b.brandPersonality),
    values: val(b.brandValues),
    key_messages: val(b.keyMessages),
    target_audience: val(b.targetAudience),
    founders: val(b.founders),
    logo_urls: Array.from(new Set(logoUrls)),
    business_overview: val(s.businessOverview),
    competitors: val(s.competitors),
    icps: val(s.icp),
  };
}

// ─── 1. Delegate a goal to Emma ─────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_run_marketing_task',
  requiresUserAccount: true,
  definition: {
    name: 'emma_run_marketing_task',
    description:
      'Give Emma a marketing goal in plain language and she plans and executes it end to end — campaigns, content, research, outreach. ' +
      'Use this when none of the more specific emma_* tools fits the request. ' +
      'Starts a new task unless you pass task_id to continue an existing one. ' +
      'Usually returns the finished result directly (status "complete"). If status is "running" or "unconfirmed", ' +
      'call emma_get_session with session_id set to the returned task_id — "unconfirmed" means the result is real but we could not verify ' +
      'Emma is not waiting on you. When status is "awaiting_input", answer with emma_answer_question_deck (awaiting_question_deck set).',
    inputSchema: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'What you want Emma to achieve, in plain language.',
        },
        task_id: {
          type: 'string',
          description: 'Continue an existing task instead of starting a new one. Omit to start fresh.',
        },
      },
      required: ['goal'],
    },
  },
  execute: async (args: any, context: any) => {
    // One tool call, not two: create the session only when the caller has not
    // already got one. Previously this was emma_create_session followed by
    // emma_send_message, and an agent had to know to chain them.
    let taskId = args?.task_id;
    if (!taskId) {
      const session: any = await mcpFetch({
        method: 'POST',
        path: '/api/agent-mode/sessions',
        context: ctx(context),
        body: {},
      });
      taskId = session?.sessionId ?? session?.session_id ?? session?.id;
    }

    const data: any = await mcpFetch({
      method: 'POST',
      path: '/api/agent-mode/generate',
      context: ctx(context),
      // The endpoint's field is `userMessage`, not `message` — see
      // agentModeController. emma_send_message maps its own `message` argument
      // onto `userMessage` for exactly this reason.
      body: { sessionId: taskId, userMessage: args?.goal },
    });

    // `/api/agent-mode/generate` is SYNCHRONOUS in the normal case: it returns
    // `{ content }` once the turn is finished. It only returns early, with
    // `stillBuilding: true`, when the run detached into a long build. So the
    // common path already has a confirmed terminal result and there is nothing
    // to poll for — telling every caller to poll would send them looking for an
    // answer they are already holding.
    const stillBuilding = data?.stillBuilding === true;

    // The generate response does NOT carry pendingUserQuestion — no `res.json`
    // in agentModeController includes it. Reading it off `data` was dead code,
    // so a run blocked on a question reported "complete" and the caller walked
    // away from work that was waiting on them.
    //
    // The session GET does expose it (the handler spreads `...session`), so
    // confirm against the session before claiming a terminal result. One extra
    // read, only on the path where we would otherwise assert completion.
    //
    // ENG-1635/1644 (ask_user_question retirement): pendingUserQuestion is
    // legacy-only now — ask_user_question and the Meta objective gate build a
    // single-item pendingApprovalDeck instead. Check both; scoped narrowly to
    // a deck-of-one (single item, not a Meta write) — the same scope
    // resolveAwaitingUserQuestion uses server-side — a genuine multi-item
    // present_question_deck or a write-deck always needs a live interactive
    // human and isn't something this synchronous status check resolves either
    // way.
    // PR2: pendingUserQuestion is dead — nothing populates it anymore
    // (updateSessionAskUserQuestion, its only writer, is deleted), so the
    // deck-of-one slot below is the only thing this check needs to look at.
    let pendingDeck: any = null;
    let confirmationFailed = false;
    if (!stillBuilding) {
      try {
        const session: any = await mcpFetch({
          method: 'GET',
          path: `/api/agent-mode/session/${encodeURIComponent(taskId)}`,
          context: ctx(context),
        });
        const deck = session?.pendingApprovalDeck;
        if (deck?.status === 'awaiting' && Array.isArray(deck.items) && deck.items.length === 1 && !deck.items[0]?.metaWriteManifestDigest) {
          pendingDeck = deck;
        }
      } catch {
        // The turn succeeded, so the result is real and worth returning — but a
        // failed check is NOT a negative result. Swallowing it to `pending =
        // null` would report "complete, confirmed" while the session might be
        // awaiting input, which is the same false confidence this tool exists
        // to avoid. Return the work, withhold the confirmation.
        confirmationFailed = true;
      }
    }

    // `complete` is a TERMINAL status in this contract: a caller reading it is
    // told, in the tool description, that polling adds nothing. Reporting it
    // when the confirming read failed sends that caller away from work that may
    // still be blocked on their answer — the exact failure this confirmation
    // step exists to prevent. An unconfirmed turn gets its own non-terminal
    // status so the contract and the flag cannot disagree.
    const status = pendingDeck
      ? 'awaiting_input'
      : stillBuilding
        ? 'running'
        : confirmationFailed
          ? 'unconfirmed'
          : 'complete';

    return jsonResult({
      task_id: taskId,
      ...(typeof data?.runId === 'string' && data.runId ? { run_id: data.runId } : {}),
      status,
      // Confirmed only when we actually verified it: a synchronous return IS
      // the completion signal, but only once the session read has ruled out a
      // blocking question. A failed check is not a negative result.
      completion_confirmed: !stillBuilding && !confirmationFailed,
      result: data?.content ?? data?.message ?? null,
      // PR2: always null now — kept in the response shape (not removed) so an
      // existing MCP client's destructuring/type expectations don't break.
      // Nothing populates session.pendingUserQuestion anymore.
      awaiting_question: null,
      awaiting_question_deck: pendingDeck ?? null,
      next: pendingDeck
        ? 'Emma is waiting on an answer. Use emma_answer_question_deck — a plain message abandons the question.'
        : stillBuilding
          ? 'Emma detached into a longer build. Call emma_get_session with session_id set to this task_id and run_id if returned — an idle session or detached_still_building record does not confirm completion.'
          : confirmationFailed
            ? 'The result above is real, but the follow-up check failed, so it is unconfirmed — Emma may be awaiting an answer. Call emma_get_session with session_id set to this task_id to check.'
            : undefined,
    });
  },
});

// ─── 2. Live web research ───────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_research',
  requiresUserAccount: true,
  definition: {
    name: 'emma_research',
    description:
      'Research a topic, company, or market using live web search, and get sourced findings back. ' +
      'Set recency to "news" for today/latest/breaking questions; leave it off for general research.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to research.' },
        recency: {
          type: 'string',
          enum: ['general', 'news'],
          description: 'Use "news" only for current-events questions. Defaults to "general".',
        },
      },
      required: ['query'],
    },
  },
  execute: async (args: any, context: any) => {
    const path = args?.recency === 'news' ? '/api/emma/you-search-news' : '/api/emma/you-search-web';
    const data = await mcpFetch({
      method: 'POST',
      path,
      context: ctx(context),
      body: { query: args?.query },
    });
    return jsonResult({ query: args?.query, recency: args?.recency ?? 'general', findings: data });
  },
});

// ─── 3. Account status ──────────────────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_get_account_status',
  requiresUserAccount: true,
  definition: {
    name: 'emma_get_account_status',
    description:
      "Get this account's plan, usage, and remaining quota. " +
      'Call this when a tool returns a quota error, to see how much allowance is left. ' +
      "Admin-only: pass client_id to check a specific client's status instead of the caller's own.",
    inputSchema: {
      type: 'object',
      properties: {
        client_id: {
          type: 'string',
          description:
            "Admin-only. Scope this call to a specific client's account instead of the caller's own — accepts the client's email or userId. Non-admin callers are rejected.",
        },
      },
    },
  },
  /** Reports the caller's own account status, or (admin-only) `args.client_id`'s. */
  execute: async (args: any, context: any) => {
    const scoped = await resolveClientScopedContext(context, args?.client_id, 'emma_get_account_status');
    const me: any = await mcpFetch({ method: 'GET', path: '/api/auth/me', context: scoped });
    // Usage comes from the same customer-safe view the product shows (ENG-1250 AC7), not the raw
    // user record's legacy counter. It is secondary: if it fails, report the account without it.
    const usage: any = await mcpFetch({ method: 'GET', path: '/api/subscription/usage', context: scoped }).catch(() => null);
    return jsonResult({
      email: me?.email,
      plan: me?.subscriptionType ?? me?.plan ?? null,
      // Not also requiring hasDesignSystem — see ProtectedRoute.tsx's
      // ENG-328 comment: every account onboarded before that step existed
      // would otherwise report is_onboarded:false despite being fully
      // onboarded under the rules that applied when they signed up.
      is_onboarded: me?.hasBrandGuidelines ?? null,
      usage: usage ?? null,
    });
  },
});

// ─── 4. What Emma knows about this company ──────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_get_brand_profile',
  requiresUserAccount: true,
  definition: {
    name: 'emma_get_brand_profile',
    description:
      'Read what Emma knows about this company: brand guidelines, market strategy, and the knowledge-base files. ' +
      'Call this FIRST when you need context about the business before writing copy, planning, or generating anything.',
    inputSchema: { type: 'object', properties: {} },
  },
  execute: async (_args: any, context: any) => {
    // Three calls collapsed into one. An agent previously had to know that
    // brand, market strategy and the knowledge base were separate tools, and
    // that it wanted all three.
    const identity = ctx(context);
    const [brand, strategy, knowledge] = await Promise.all([
      section('brand_guidelines', '/api/brand/guidelines', identity),
      section('market_strategy', '/api/market-strategy', identity),
      section('knowledge_base_files', '/api/emma/knowledge-bases', identity),
    ]);

    const failures = [brand, strategy, knowledge].filter(s => s.error).map(s => `${s.name}: ${s.error}`);

    return jsonResult({
      brand_guidelines: brand.data,
      market_strategy: strategy.data,
      // No year-2500 signed file links (knowledgeBaseParams.ts): read a file with read_knowledge_base_files.
      knowledge_base_files: withoutSignedStorageLinks(knowledge.data),
      // Named fields across both sections (ENG-3122). Raw sections above stay
      // unchanged for existing callers.
      structured_export: buildBrandExport(brand.data, strategy.data),
      // "Not configured" and "we could not reach the service" are different
      // facts. Collapsing both to null tells the agent this company has no
      // brand, and it will then invent one.
      unavailable: failures.length ? failures : undefined,
      note: failures.length
        ? 'Some sections could NOT be read — treat those as UNKNOWN, not as unconfigured. Do not generate content that assumes they are empty.'
        : 'Every section was read successfully. An empty one is genuinely not filled in on this account yet.',
    });
  },
});

// ─── 5. Build a targeted lead list ──────────────────────────────────────────

mcpToolRegistry.register({
  name: 'emma_find_leads',
  requiresUserAccount: true,
  definition: {
    name: 'emma_find_leads',
    description:
      'Find leads matching an ideal-customer description and return them with the list they belong to. ' +
      'Use filters for structured criteria (title, industry, company size); use description for a plain-language ICP.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Plain-language description of the ideal customer.' },
        filters: { type: 'object', description: 'Structured filters, when you already know the exact criteria.' },
        limit: { type: 'number', description: 'Maximum leads to return. Defaults to 50.' },
      },
    },
  },
  execute: async (args: any, context: any) => {
    const data: any = await mcpFetch({
      method: 'POST',
      path: '/api/emma/search-leads',
      context: ctx(context),
      body: { query: args?.description, filters: args?.filters, limit: args?.limit ?? 50 },
    });

    const leads = data?.leads ?? data?.results ?? data;
    return jsonResult({
      matched: Array.isArray(leads) ? leads.length : undefined,
      leads,
      list_id: data?.listId ?? data?.list_id ?? null,
    });
  },
});

/** Names registered by this layer — exported so tests can assert the set. */
export const WORKFLOW_TOOL_NAMES = [
  'emma_run_marketing_task',
  'emma_research',
  'emma_get_account_status',
  'emma_get_brand_profile',
  'emma_find_leads',
] as const;
