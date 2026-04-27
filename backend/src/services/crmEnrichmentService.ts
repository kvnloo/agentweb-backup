import { crmDb } from './db';
import { agentModeService } from './agentModeService';
import { incrementExtraCostUsage } from './tokenUsageService';
import { v4 as uuidv4 } from 'uuid';

// Estimated cost per enriched lead in USD (Google Custom Search dominates at $0.005/query)
const ENRICHMENT_COST_PER_LEAD = 0.0052;

// Callback type for emitting Socket.IO events.
// In the main process this uses the real `io` instance directly;
// in the worker process the callback forwards events over IPC to the parent.
export type SocketEmitFn = (room: string, event: string, payload: any) => void;

// Lazy-load Socket.IO to avoid importing server.ts in worker processes
// (server.ts binds to a port at module level, causing EADDRINUSE in workers)
function getIO(): import('socket.io').Server | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { io } = require('../server');
    return io;
  } catch {
    return null;
  }
}

function defaultSocketEmit(): SocketEmitFn | null {
  const ioInstance = getIO();
  if (!ioInstance) return null;
  return (room, event, payload) => ioInstance.to(room).emit(event, payload);
}

export interface EnrichmentJobSpec {
  listId: string;
  userId: string;
  instruction: string;
  outputFields: string[];
  sources: ('web_search' | 'linkedin' | 'existing_data')[];
  filters?: { field: string; operator: string; value?: any }[];
  forceOverwrite?: boolean;
  leadIds?: string[];
  /** Single web search query template with {{placeholder}} substitution.
   *  Covers ALL web_search fields in one call. Auto-built if not provided. */
  webSearchTemplate?: string;
  /** LinkedIn person search query template. Auto-built if not provided. */
  linkedinSearchTemplate?: string;
  /** Per-field source overrides. Falls back to job-level `sources` when absent for a field. */
  sourcesPerField?: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>;
}

interface EnrichmentPreviewResult {
  totalLeads: number;
  leadsToProcess: number;
  alreadyEnriched: number;
  samples: { leadId: string; lead: any; enrichedFields: Record<string, string> }[];
}

interface EnrichmentExecuteResult {
  jobId: string;
  processedCount: number;
  failedCount: number;
  skippedCount: number;
  totalToProcess: number;
  outputFields: string[];
  failureBreakdown: {
    searchWebFailed: number;
    linkedinFailed: number;
    llmOrParseFailed: number;
    updateFailed: number;
  };
  warnings?: string[];
}

export class CrmEnrichmentService {
  private async loadAndFilterLeads(spec: EnrichmentJobSpec): Promise<{
    allLeads: any[];
    leadsToProcess: any[];
    alreadyEnriched: number;
    filteredTotal: number;
    storedSourcesPerField: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>;
    storedWebSearchTemplate: string;
    storedLinkedinSearchTemplate: string;
  }> {
    const list = await crmDb.getLeadListById(spec.listId);
    if (!list) {
      throw new Error('Lead list not found');
    }

    // Extract stored config from the list (no extra DB call)
    const storedSourcesPerField: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]> =
      list.sourcesPerField && typeof list.sourcesPerField === 'object'
        ? (list.sourcesPerField as Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>)
        : {};

    const storedWebSearchTemplate: string =
      typeof list.webSearchTemplate === 'string' ? list.webSearchTemplate : '';

    const storedLinkedinSearchTemplate: string =
      typeof list.linkedinSearchTemplate === 'string' ? list.linkedinSearchTemplate : '';

    // Load all leads with pagination
    const allLeads: any[] = [];
    let lastKey: any = undefined;
    do {
      const result = await crmDb.getLeadsByListId(spec.listId, undefined, lastKey);
      allLeads.push(...(result.items || []));
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);

    // Filter by specific leadIds if provided
    let filtered = spec.leadIds && spec.leadIds.length > 0
      ? allLeads.filter(lead => spec.leadIds!.includes(lead.leadId))
      : allLeads;

    // Apply filters
    if (spec.filters && spec.filters.length > 0) {
      filtered = filtered.filter(lead => {
        return spec.filters!.every(filter => {
          const value = lead[filter.field] ?? lead?.customFields?.[filter.field];
          switch (filter.operator) {
            case 'equals': return value === filter.value;
            case 'not_equals': return value !== filter.value;
            case 'contains': return typeof value === 'string' && value.includes(filter.value);
            case 'is_empty': return !value || (typeof value === 'string' && value.trim() === '');
            case 'is_not_empty': return value && (typeof value !== 'string' || value.trim() !== '');
            default: return true;
          }
        });
      });
    }

    // Determine already-enriched leads (have ALL output fields populated with real values)
    // "Unknown" is treated as not enriched — it means the previous run found nothing
    const hasAllFields = (lead: any) =>
      spec.outputFields.every(field => {
        const value = lead?.customFields?.[field];
        return typeof value === 'string' && value.trim().length > 0 && value.trim() !== 'Unknown';
      });

    const alreadyEnriched = filtered.filter(hasAllFields).length;
    const leadsToProcess = spec.forceOverwrite
      ? filtered
      : filtered.filter(lead => !hasAllFields(lead));

    return { allLeads, leadsToProcess, alreadyEnriched, filteredTotal: filtered.length, storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate };
  }

  private async resolveLinkedInAccountId(userId: string): Promise<string | null> {
    const { linkedInOutreachService } = await import('./linkedInOutreachService');
    return linkedInOutreachService.resolveAccountId(userId);
  }

  private static readonly ENRICH_MODEL = 'gemini-3-flash-preview';
  private static readonly SUGGEST_MODEL = 'gemini-3-flash-preview';

  // Free/personal email providers — using their domain as a company identifier produces wrong results
  private static readonly PERSONAL_EMAIL_DOMAINS = new Set([
    'gmail.com', 'googlemail.com',
    'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it',
    'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es',
    'outlook.com', 'outlook.co.uk', 'live.com', 'live.co.uk',
    'msn.com',
    'aol.com',
    'icloud.com', 'me.com', 'mac.com',
    'protonmail.com', 'proton.me',
    'mail.com', 'email.com',
    'zoho.com',
    'yandex.com', 'yandex.ru',
    'qq.com', '163.com', '126.com',
    'inbox.com', 'fastmail.com', 'tutanota.com',
  ]);

  static isPersonalEmailDomain(email: string): boolean {
    const domain = (email.split('@')[1] || '').toLowerCase().trim();
    return CrmEnrichmentService.PERSONAL_EMAIL_DOMAINS.has(domain);
  }

  /**
   * Substitute {{placeholder}} tokens in a search query template with actual lead field values.
   * Multi-space gaps left by empty substitutions are collapsed to a single space.
   */
  static applySearchTemplate(template: string, lead: any): string {
    return template
      .replace(/\{\{firstName\}\}/g, lead.firstName || '')
      .replace(/\{\{lastName\}\}/g, lead.lastName || '')
      .replace(/\{\{company\}\}/g, lead.company || '')
      .replace(/\{\{email\}\}/g, lead.email || '')
      .replace(/\{\{emailDomain\}\}/g, lead.email ? (String(lead.email).split('@')[1] || '') : '')
      .replace(/\{\{title\}\}/g, lead.title || '')
      .replace(/\{\{linkedin\}\}/g, lead.linkedin || '')
      .replace(/\{\{customFields\.(\w+)\}\}/g, (_: string, f: string) => lead.customFields?.[f] || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  private static buildSearchQuery(lead: any, outputFields: string[]): string {
    const companyName = String(lead.company || '').trim();
    const emailDomain = lead.email ? (String(lead.email).split('@')[1] || '').trim() : '';
    const personName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();

    // Person-level fields: need name + company for accurate results
    // Note: company_linkedin_url is company-level (not person-level) even though it contains "linkedin"
    const isPersonField = outputFields.some(f => {
      const fl = f.toLowerCase();
      if (/company_linkedin|company.*linkedin|linkedin.*company/.test(fl)) return false;
      return /linkedin|profile|contact|title|role|position|seniority|department/.test(fl);
    });

    const isPersonalDomain = emailDomain
      ? CrmEnrichmentService.isPersonalEmailDomain(`x@${emailDomain}`)
      : false;
    const businessDomain = isPersonalDomain ? '' : emailDomain;

    if (isPersonField && personName) {
      const companyCtx = companyName || businessDomain;
      // Simple query — Google Custom Search API doesn't handle OR well
      return companyCtx
        ? `${personName} ${companyCtx} linkedin`
        : `${personName} linkedin profile`;
    }

    // Company-level fields: use company name with targeted suffix
    const companyTerm = companyName || businessDomain;
    if (!companyTerm) return '';

    const fieldSuffixes: [RegExp, string][] = [
      [/tech_stack|technology|stack|tool|software|platform/, 'technology stack tools software'],
      [/funding|invest|raised|series|venture|round/, 'funding rounds investors'],
      [/employee|headcount|team_size|staff|workforce/, 'employees headcount size'],
      [/revenue|arr|mrr|income|sales/, 'revenue ARR annual'],
      [/industry|sector|vertical/, 'industry sector'],
      [/company_linkedin|company.*linkedin|linkedin.*company/, 'linkedin company page'],
    ];

    const suffixes = new Set<string>();
    for (const field of outputFields) {
      const fl = field.toLowerCase();
      for (const [pattern, suffix] of fieldSuffixes) {
        if (pattern.test(fl)) {
          suffixes.add(suffix);
          break;
        }
      }
    }

    const suffix = suffixes.size > 0 ? Array.from(suffixes).join(' ') : 'company overview';
    return `${companyTerm} ${suffix}`;
  }

  private static buildFieldGuidance(outputFields: string[]): string {
    const lines: string[] = [];
    for (const field of outputFields) {
      const fl = field.toLowerCase();
      if (/company_linkedin|company.*linkedin|linkedin.*company/.test(fl)) {
        lines.push(`- "${field}": ONLY copy a LinkedIn company page URL that appears verbatim in the web search results above. The URL must start with "https://www.linkedin.com/company/". Do NOT construct, guess, or complete a URL. Return "Unknown" if no exact /company/ URL is present in the data.`);
      } else if (/linkedin/.test(fl)) {
        lines.push(`- "${field}": ONLY copy a linkedin.com/in/ URL that appears verbatim in the provided data (look in "LinkedIn profile URLs found in search results" and "Resolved LinkedIn profile URL"). Do NOT construct, guess, or complete a URL — even if you think you know the person's LinkedIn handle. Do NOT use /pub/dir/ or /search/ URLs. Return "Unknown" if no exact /in/ URL is present in the data.`);
      } else if (/employee|headcount|team_size|staff|workforce/.test(fl)) {
        lines.push(`- "${field}": Return only an explicit headcount or range stated in the provided data (e.g. "11-50 employees", "~200"). Do NOT estimate or infer from company descriptions. Return "Unknown" if no figure is stated.`);
      } else if (/funding|invest|raised|series|venture|round/.test(fl)) {
        lines.push(`- "${field}": Look for VC rounds, grants, or angel investment mentions explicitly stated in the data. If found, state the stage and amount (e.g. "Seed - $1.5M", "Series A - $8M"). If no funding info is present anywhere, return "Bootstrapped / Not publicly funded". Return "Unknown" only if the company cannot be confirmed to exist.`);
      } else if (/revenue|arr|mrr|income|sales/.test(fl)) {
        lines.push(`- "${field}": Return only revenue or ARR/MRR figures explicitly stated in the data. If not present, return "Not publicly disclosed".`);
      } else if (/tech_stack|technology/.test(fl)) {
        lines.push(`- "${field}": Return only technologies explicitly mentioned in the search results or LinkedIn data. Do NOT infer from product category. Return "Not publicly disclosed" if no signals are found.`);
      } else if (/industry|sector|vertical/.test(fl)) {
        lines.push(`- "${field}": Extract from the company description in the provided data. Return "Unknown" if the company's industry cannot be clearly determined.`);
      } else {
        lines.push(`- "${field}": Return only what is explicitly stated in the provided data. Return "Unknown" if not present.`);
      }
    }
    if (lines.length === 0) {
      return 'If a field\'s value is not present in the provided data, return "Unknown".';
    }
    return `Field-specific guidance (follow these rules strictly):\n${lines.join('\n')}`;
  }

  private async enrichLead(
    lead: any,
    spec: EnrichmentJobSpec,
    linkedInAccountId?: string | null,
  ): Promise<{ fields: Record<string, string> }> {
    // Skip leads with personal email and no company — nothing reliable to search against
    const isPersonal = CrmEnrichmentService.isPersonalEmailDomain(lead.email || '');
    const hasCompanyId = !!(lead.company?.trim());
    if (isPersonal && !hasCompanyId) {
      throw Object.assign(
        new Error(`Skipped: personal email (${lead.email}) with no company identification`),
        { step: 'skipped_personal' }
      );
    }

    let webContext = '';
    let linkedinContext = '';

    // Helper: effective sources for a field — per-field override or job-level fallback
    const effectiveSources = (field: string) =>
      spec.sourcesPerField?.[field] ?? spec.sources;

    // Which fields need LinkedIn?
    const linkedinFields = spec.outputFields.filter(f => effectiveSources(f).includes('linkedin'));
    const isEnrichingLinkedin = linkedinFields.some(f => /linkedin/i.test(f));

    // 1. Web search source — ONE search per lead covering all web_search fields combined
    const webSearchFields = spec.outputFields.filter(f => effectiveSources(f).includes('web_search'));
    if (webSearchFields.length > 0) {
      // Build one comprehensive query: use stored template if provided, otherwise auto-build
      const template = spec.webSearchTemplate;
      const query = template
        ? CrmEnrichmentService.applySearchTemplate(template, lead)
        : CrmEnrichmentService.buildSearchQuery(lead, webSearchFields);


      if (query) {
        let result = await agentModeService.searchWeb(query, 5);

        // Fallback only when search succeeded but returned empty results
        const primarySucceededEmpty = result?.success && (!Array.isArray(result.results) || result.results.length === 0);
        if (primarySucceededEmpty) {
          const personName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
          const fallbackQuery = personName
            ? `${personName} ${lead.company || ''}`.trim()
            : `${lead.company || (!CrmEnrichmentService.isPersonalEmailDomain(lead.email || '') ? lead.email?.split('@')[1] : '') || ''} company overview`.trim();
          if (fallbackQuery && fallbackQuery !== query) {
            result = await agentModeService.searchWeb(fallbackQuery, 5);
          }
        }

        if (result?.success && Array.isArray(result.results) && result.results.length > 0) {
          webContext = JSON.stringify(result.results, null, 2);
        } else if (!result?.success) {
          const msg = result?.error || result?.message || '';
          if (!msg.toLowerCase().includes('no search results found')) {
            throw Object.assign(new Error(`Web search failed: ${msg}`), { step: 'search' });
          }
        }
      }
    }

    // 1b. Dedicated LinkedIn company page search — runs a separate site:linkedin.com/company
    // query when company_linkedin_url (or equivalent) is in the output fields.
    // A general web search rarely surfaces /company/ URLs; this targeted query does.
    const hasCompanyLinkedinField = webSearchFields.some(f =>
      /company_linkedin|company.*linkedin|linkedin.*company/.test(f.toLowerCase())
    );
    if (hasCompanyLinkedinField) {
      const emailDomain = lead.email ? (String(lead.email).split('@')[1] || '').trim() : '';
      const isPersonalDomain = emailDomain
        ? CrmEnrichmentService.isPersonalEmailDomain(`x@${emailDomain}`)
        : false;
      const companyTerm = (!isPersonalDomain && emailDomain) || String(lead.company || '').trim();
      if (companyTerm) {
        try {
          const linkedinCompanyQuery = `${companyTerm} site:linkedin.com/company`;
          const linkedinCompanyResult = await agentModeService.searchWeb(linkedinCompanyQuery, 5);
          if (linkedinCompanyResult?.success && Array.isArray(linkedinCompanyResult.results) && linkedinCompanyResult.results.length > 0) {
            const companyUrls = linkedinCompanyResult.results
              .map((r: any) => r.url || '')
              .filter((url: string) => /linkedin\.com\/company\//i.test(url));
            webContext += `\n\nDedicated LinkedIn company page search results:\n${JSON.stringify(linkedinCompanyResult.results, null, 2)}`;
            if (companyUrls.length > 0) {
              webContext += `\n\nLinkedIn company page URLs found in dedicated search (use these first):\n${companyUrls.join('\n')}`;
            }
          }
        } catch (err: any) {
          console.warn(`[CrmEnrichment] LinkedIn company page search failed for lead ${lead?.leadId}: ${err.message}`);
        }
      }
    }

    // 2. LinkedIn source — only run if at least one field needs it
    if (linkedinFields.length > 0 && linkedInAccountId) {
      try {
        const linkedinUrl = lead.linkedin ? String(lead.linkedin).trim() : '';
        const isValidLinkedInUrl = linkedinUrl && /\/in\//.test(linkedinUrl);
        let profileData: any = null;

        // When enriching the linkedin field itself, still try the existing URL first —
        // it's almost always correct and avoids a search-people round-trip.
        if (isValidLinkedInUrl) {
          const result = await agentModeService.linkedinOutreach(spec.userId, {
            action: 'get-profile',
            account_id: linkedInAccountId,
            profile_url: linkedinUrl,
          });
          if (result?.success) profileData = result.data;
        }

        if (!profileData) {
          const cf = (lead.customFields || {}) as Record<string, string>;
          const firstName = String(lead.firstName || cf.first_name || '').trim();
          const lastName = String(lead.lastName || cf.last_name || '').trim();
          const name = `${firstName} ${lastName}`.trim();
          const emailDomain = lead.email ? lead.email.split('@')[1] || '' : '';
          const domainCompany = emailDomain && !CrmEnrichmentService.isPersonalEmailDomain(lead.email || '') ? emailDomain : '';
          const company = String(lead.company || cf.company_name || domainCompany || '').trim();
          if (name && company) {
            const searchResult = await agentModeService.linkedinOutreach(spec.userId, {
              action: 'search-people',
              account_id: linkedInAccountId,
              keywords: `${name} ${company}`,
            });
            const items = searchResult?.data?.items || [];
            const topResult = items[0];
            if (topResult?.provider_id) {
              const profileResult = await agentModeService.linkedinOutreach(spec.userId, {
                action: 'get-profile',
                account_id: linkedInAccountId,
                provider_id: topResult.provider_id,
              });
              if (profileResult?.success) profileData = profileResult.data;
            } else if (topResult?.public_identifier || topResult?.public_profile_url) {
              // Search result has enough data — use it directly without a second API call
              profileData = topResult;
            } else {
            }
          } else {
          }
        }

        if (profileData) {
          const rawUrl = profileData?.public_profile_url || profileData?.url || profileData?.profile_url || null;
          const cleanUrl = rawUrl ? rawUrl.split('?')[0] : null;
          const profileUrl = profileData?.public_identifier
            ? `https://www.linkedin.com/in/${profileData.public_identifier}`
            : cleanUrl;
          linkedinContext = `\nLinkedIn profile data:\n${JSON.stringify(profileData, null, 2)}`;
          if (profileUrl && isEnrichingLinkedin) {
            linkedinContext += `\n\nResolved LinkedIn profile URL: ${profileUrl}`;
          }
        } else if (isEnrichingLinkedin && isValidLinkedInUrl) {
          // Unipile lookup failed but we already have a valid URL — surface it so the LLM doesn't guess
          linkedinContext = `\n\nResolved LinkedIn profile URL: ${linkedinUrl}`;
        }
      } catch (err: any) {
        console.error(`[CrmEnrichment][LinkedIn] lookup failed for lead ${lead?.leadId}: ${err.message}`);
        // Non-fatal: continue enrichment with other sources
      }
    } else {
    }

    // 3. Build lead context
    const leadContext: Record<string, string> = {};
    const cfCtx = (lead.customFields || {}) as Record<string, string>;
    const ctxFirstName = String(lead.firstName || cfCtx.first_name || '').trim();
    const ctxLastName = String(lead.lastName || cfCtx.last_name || '').trim();
    const name = `${ctxFirstName} ${ctxLastName}`.trim();
    if (name) leadContext.name = name;
    if (lead.email) leadContext.email = String(lead.email).trim();
    if (lead.title) leadContext.title = String(lead.title || cfCtx.title || '').trim();
    if (leadContext.title === '') delete leadContext.title;
    if (lead.company) leadContext.company = String(lead.company || cfCtx.company_name || '').trim();
    // Exclude existing linkedin URL when enriching linkedin fields — it may be wrong/outdated
    if (lead.linkedin && !isEnrichingLinkedin) leadContext.linkedin = String(lead.linkedin).trim();
    // Include existing custom fields for context
    if (lead.customFields && Object.keys(lead.customFields).length > 0) {
      leadContext.existingCustomFields = JSON.stringify(lead.customFields);
    }

    // Extract any linkedin.com/in/ URLs directly from web search result URLs — surface them as a hint
    if (isEnrichingLinkedin && webContext) {
      const linkedinUrlMatches = webContext.match(/https?:\/\/[a-z]{0,3}\.?linkedin\.com\/in\/[^\s"\\]+/gi) || [];
      if (linkedinUrlMatches.length > 0) {
        const uniqueUrls = [...new Set(linkedinUrlMatches)];
        webContext += `\n\nLinkedIn profile URLs found in search results (use these as candidates):\n${uniqueUrls.join('\n')}`;
      } else {
      }
    }


    // 4. Build prompt and call LLM
    // Substitute {{placeholder}} tokens in instruction with actual lead values
    const resolvedInstruction = CrmEnrichmentService.applySearchTemplate(spec.instruction, lead);

    const systemPrompt = `You are a data extraction assistant. Your job is to extract factual information from the provided sources — not to infer, guess, or fabricate.

CRITICAL RULE: Only return values that are explicitly stated in the provided Lead context, Web search results, or LinkedIn data. If a value is not present in the provided data, return "Unknown". Do NOT construct, guess, or invent any value — especially URLs.

Your task: ${resolvedInstruction}

Return ONLY a JSON object with these exact keys: ${JSON.stringify(spec.outputFields)}
Each value must be a string.

JSON formatting rules (mandatory):
- Output must be valid JSON parsable by JSON.parse
- Use double quotes for all keys and string values
- Do not wrap output in markdown or code fences
- Do not include any text before or after the JSON object

${CrmEnrichmentService.buildFieldGuidance(spec.outputFields)}`;

    const userPrompt = `Lead context:
${JSON.stringify(leadContext, null, 2)}
${webContext ? `\nWeb search results:\n${webContext}` : ''}${linkedinContext ? `\nLinkedIn data:${linkedinContext}` : ''}

Extract only what is explicitly present in the sources above. Do not infer or fabricate any value. Return "Unknown" for any field not found in the data.`;

    // Call Gemini via the shared OpenAI-compatible client
    const geminiClient = await agentModeService.getGeminiClient();
    let response: Record<string, string> | null = null;
    try {
      const completion = await geminiClient.chat.completions.create({
        model: CrmEnrichmentService.ENRICH_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });
      const raw = completion.choices?.[0]?.message?.content || '';
      response = JSON.parse(raw);
    } catch {
      // Retry with stricter instructions, no JSON mode
      const strictRetryPrompt = `${userPrompt}

CRITICAL RETRY INSTRUCTIONS:
Return exactly one JSON object.
No markdown, no backticks, no comments, no trailing commas.
Valid example:
{${spec.outputFields.map(f => `"${f}":"value"`).join(',')}}`;

      const retry = await geminiClient.chat.completions.create({
        model: CrmEnrichmentService.ENRICH_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: strictRetryPrompt },
        ],
      });
      const rawRetry = retry.choices?.[0]?.message?.content || '';

      const cleaned = rawRetry
        .trim()
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

      try {
        response = JSON.parse(cleaned);
      } catch {
        const firstBrace = cleaned.indexOf('{');
        const lastBrace = cleaned.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace > firstBrace) {
          response = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
        } else {
          throw Object.assign(new Error('LLM returned unparseable response'), { step: 'llm' });
        }
      }
    }

    // Extract only the requested fields
    const fields: Record<string, string> = {};
    for (const field of spec.outputFields) {
      fields[field] = typeof response?.[field] === 'string' ? response[field].trim() : 'Unknown';
    }

    // Post-process: reject any LinkedIn URL not present verbatim in source data.
    // Prevents the LLM from constructing plausible-looking but fabricated URLs.
    const allContext = (webContext + linkedinContext).toLowerCase();
    for (const field of spec.outputFields) {
      if (!/linkedin/i.test(field)) continue;
      const value = fields[field];
      if (!value || value === 'Unknown') continue;
      const slugMatch = value.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/i);
      if (slugMatch) {
        const slug = slugMatch[2].toLowerCase();
        if (!allContext.includes(slug)) {
          console.warn(`[CrmEnrichment] Rejected hallucinated LinkedIn URL "${value}" for field "${field}" — slug not in source data`);
          fields[field] = 'Unknown';
        }
      } else {
        // Returned value doesn't match a valid LinkedIn URL pattern
        fields[field] = 'Unknown';
      }
    }

    return { fields };
  }

  // Map of output field name patterns to standard lead field names
  private static readonly STANDARD_FIELD_MAP: Record<string, string> = {
    email: 'email',
    first_name: 'firstName',
    firstname: 'firstName',
    first: 'firstName',
    last_name: 'lastName',
    lastname: 'lastName',
    last: 'lastName',
    company: 'company',
    company_name: 'company',
    phone: 'phone',
    phone_number: 'phone',
    title: 'title',
    job_title: 'title',
    linkedin: 'linkedin',
    linkedin_url: 'linkedin',
    personal_linkedin_url: 'linkedin',
    lead_linkedin_url: 'linkedin',
    linkedin_profile_url: 'linkedin',
    notes: 'notes',
  };

  /**
   * Split enriched fields into standard lead field updates and custom field updates.
   * If an output field name matches a known standard field, it goes to the standard update;
   * otherwise it goes to customFields.
   */
  private static splitFields(fields: Record<string, string>): {
    standardUpdates: Record<string, string>;
    customUpdates: Record<string, string>;
  } {
    const standardUpdates: Record<string, string> = {};
    const customUpdates: Record<string, string> = {};

    for (const [key, value] of Object.entries(fields)) {
      const mapped = CrmEnrichmentService.STANDARD_FIELD_MAP[key.toLowerCase()];
      // Never write placeholder values back to any field
      const isPlaceholder = !value || value.toLowerCase() === 'unknown' || value.toLowerCase() === 'n/a';
      if (mapped) {
        if (!isPlaceholder) standardUpdates[mapped] = value;
      } else {
        if (!isPlaceholder) customUpdates[key] = value;
      }
    }

    return { standardUpdates, customUpdates };
  }

  async preview(spec: EnrichmentJobSpec): Promise<EnrichmentPreviewResult> {
    const { allLeads, leadsToProcess, alreadyEnriched, filteredTotal, storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate } = await this.loadAndFilterLeads(spec);

    // Merge stored config — runtime spec takes precedence
    spec = {
      ...spec,
      webSearchTemplate: spec.webSearchTemplate || storedWebSearchTemplate || undefined,
      linkedinSearchTemplate: spec.linkedinSearchTemplate || storedLinkedinSearchTemplate || undefined,
      sourcesPerField: { ...storedSourcesPerField, ...spec.sourcesPerField },
    };

    // Process up to 2 samples
    const samples: EnrichmentPreviewResult['samples'] = [];
    const sampleLeads = leadsToProcess.slice(0, 2);

    if (sampleLeads.length > 0) {
      // Resolve LinkedIn account if needed
      let linkedInAccountId: string | null = null;
      if (spec.sources.includes('linkedin')) {
        linkedInAccountId = await this.resolveLinkedInAccountId(spec.userId);
      }

      for (const lead of sampleLeads) {
        try {
          const { fields } = await this.enrichLead(lead, spec, linkedInAccountId);
          samples.push({ leadId: lead.leadId, lead, enrichedFields: fields });
        } catch (err) {
          samples.push({ leadId: lead.leadId, lead, enrichedFields: { _error: String(err) } });
        }
      }
    }

    return {
      totalLeads: spec.leadIds ? filteredTotal : allLeads.length,
      leadsToProcess: leadsToProcess.length,
      alreadyEnriched,
      samples,
    };
  }

  async execute(spec: EnrichmentJobSpec, socketId?: string, options?: { progressEvent?: string; completeEvent?: string; socketEmit?: SocketEmitFn }): Promise<EnrichmentExecuteResult> {
    const progressEvent = options?.progressEvent || 'crm-enrichment-progress';
    const completeEvent = options?.completeEvent || 'crm-enrichment-complete';
    const jobId = uuidv4();
    const warnings: string[] = [];

    const { leadsToProcess, storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate } = await this.loadAndFilterLeads(spec);

    // Merge stored config — runtime spec takes precedence
    spec = {
      ...spec,
      webSearchTemplate: spec.webSearchTemplate || storedWebSearchTemplate || undefined,
      linkedinSearchTemplate: spec.linkedinSearchTemplate || storedLinkedinSearchTemplate || undefined,
      sourcesPerField: { ...storedSourcesPerField, ...spec.sourcesPerField },
    };

    if (leadsToProcess.length === 0) {
      return {
        jobId,
        processedCount: 0,
        failedCount: 0,
        skippedCount: 0,
        totalToProcess: 0,
        outputFields: spec.outputFields,
        failureBreakdown: { searchWebFailed: 0, linkedinFailed: 0, llmOrParseFailed: 0, updateFailed: 0 },
        warnings,
      };
    }

    // Resolve LinkedIn account if needed
    let linkedInAccountId: string | null = null;
    const hasLinkedin = spec.sources.includes('linkedin');
    if (hasLinkedin) {
      linkedInAccountId = await this.resolveLinkedInAccountId(spec.userId);
      if (!linkedInAccountId) {
        warnings.push('No LinkedIn (Unipile) account connected — linkedin source skipped');
        // Remove linkedin from effective sources
        spec = { ...spec, sources: spec.sources.filter(s => s !== 'linkedin') };
      }
    }

    const userRoom = `user:${spec.userId}`;
    const emit = options?.socketEmit || defaultSocketEmit();
    const emitProgress = (message: string, progress: number, processedCount: number, failedCount: number) => {
      if (!emit) return;
      const payload = {
        jobId,
        message,
        progress: Math.round(progress),
        processedCount,
        failedCount,
        totalToProcess: leadsToProcess.length,
      };
      if (socketId) {
        emit(socketId, progressEvent, payload);
      }
      // Always emit to user room so CRM page receives updates
      emit(userRoom, progressEvent, payload);
    };

    const parallelism = hasLinkedin && linkedInAccountId ? 5 : 20;
    const chunkSize = Math.max(1, Math.ceil(leadsToProcess.length / parallelism));
    const chunks: any[][] = [];
    for (let i = 0; i < leadsToProcess.length; i += chunkSize) {
      chunks.push(leadsToProcess.slice(i, i + chunkSize));
    }

    let totalProcessedCount = 0;
    let totalFailedCount = 0;
    let totalSkippedCount = 0;
    const failureBreakdown = {
      searchWebFailed: 0,
      linkedinFailed: 0,
      llmOrParseFailed: 0,
      updateFailed: 0,
    };

    emitProgress('Starting enrichment...', 0, 0, 0);

    const chunkProcessors = chunks.map(async (chunk) => {
      for (const lead of chunk) {
        try {
          const { fields } = await this.enrichLead(lead, spec, linkedInAccountId);
          const { standardUpdates, customUpdates } = CrmEnrichmentService.splitFields(fields);

          await crmDb.updateLead(spec.listId, lead.leadId, {
            ...standardUpdates,
            customFields: {
              ...(lead.customFields || {}),
              ...customUpdates,
            },
          });

          totalProcessedCount++;
        } catch (error: any) {
          const step = error?.step || 'unknown';
          if (step === 'skipped_personal') {
            totalSkippedCount++;
            console.log(`[CrmEnrichment] Skipped lead ${lead?.leadId}: ${error.message}`);
          } else {
            if (step === 'search') {
              failureBreakdown.searchWebFailed++;
            } else if (step === 'linkedin') {
              failureBreakdown.linkedinFailed++;
            } else if (step === 'llm') {
              failureBreakdown.llmOrParseFailed++;
            } else {
              failureBreakdown.llmOrParseFailed++;
            }
            totalFailedCount++;
            console.error(`[CrmEnrichment] Failed to enrich lead ${lead?.leadId}:`, error);
          }
        }

        const completed = totalProcessedCount + totalFailedCount + totalSkippedCount;
        const progress = Math.min((completed / leadsToProcess.length) * 100, 100);
        emitProgress(
          `Enriching ${completed}/${leadsToProcess.length} (${totalProcessedCount} enriched, ${totalFailedCount} failed, ${totalSkippedCount} skipped)`,
          progress,
          totalProcessedCount,
          totalFailedCount,
        );
      }
    });

    await Promise.all(chunkProcessors);

    // Register new field names on the list
    try {
      await crmDb.updateFieldNames(spec.listId, spec.outputFields);
    } catch (err) {
      console.error('[CrmEnrichment] Failed to update field names:', err);
    }

    if (totalSkippedCount > 0) {
      warnings.push(`${totalSkippedCount} lead(s) skipped — personal email with no company identification`);
    }

    // Emit completion event
    const completionPayload = {
      jobId,
      listId: spec.listId,
      processedCount: totalProcessedCount,
      failedCount: totalFailedCount,
      skippedCount: totalSkippedCount,
      outputFields: spec.outputFields,
      failureBreakdown,
    };
    if (emit) {
      if (socketId) {
        emit(socketId, completeEvent, completionPayload);
      }
      emit(userRoom, completeEvent, completionPayload);
    }

    // Record extra cost for this job (fire-and-forget — never block the response)
    if (totalProcessedCount > 0) {
      incrementExtraCostUsage(spec.userId, {
        enrichment: Math.round(totalProcessedCount * ENRICHMENT_COST_PER_LEAD * 10000) / 10000,
      }).catch((err) => console.error('[CrmEnrichment] Failed to record extra cost:', err));
    }

    return {
      jobId,
      processedCount: totalProcessedCount,
      failedCount: totalFailedCount,
      skippedCount: totalSkippedCount,
      totalToProcess: leadsToProcess.length,
      outputFields: spec.outputFields,
      failureBreakdown,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  static async suggestEnrichment(
    goal: string,
    context?: {
      listId?: string;
      existingStandardFields?: string[];
      existingCustomFields?: string[];
      commonlyEmptyFields?: string[];
    }
  ): Promise<{
    instruction: string;
    outputFields: string[];
    webSearchTemplate: string;
    linkedinSearchTemplate: string;
    sourcesPerField: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>;
    sources: ('web_search' | 'linkedin' | 'existing_data')[];
  }> {
    const existingFieldsSection = (() => {
      const parts: string[] = [];
      if (context?.existingStandardFields?.length) {
        parts.push(`Existing standard fields on these leads: ${context.existingStandardFields.join(', ')}`);
      }
      if (context?.existingCustomFields?.length) {
        parts.push(`Existing custom fields already on this list: ${context.existingCustomFields.join(', ')}`);
      }
      if (context?.commonlyEmptyFields?.length) {
        parts.push(`Standard fields that are commonly EMPTY on these leads (high-value enrichment targets): ${context.commonlyEmptyFields.join(', ')}`);
      }
      return parts.length > 0 ? `\n${parts.join('\n')}\n` : '';
    })();

    const systemPrompt = `You are a data enrichment specialist for a B2B CRM system.

Given a user's enrichment goal or instruction, produce:

1. An improved extraction instruction. Apply these rules:
   - SHORT / VAGUE input (under ~80 words, no specific criteria or definitions): rewrite it into a precise 2-4 sentence extraction instruction.
   - DETAILED input (contains specific criteria, named categories, thresholds, persona definitions, or examples): preserve the FULL content verbatim — do NOT summarize, shorten, or remove any criteria. You may lightly fix grammar or formatting, but every specific rule, definition, and threshold must remain in the output instruction exactly as given. NEVER replace specific definitions with vague phrases like "based on the provided criteria" — that loses the actual criteria.
   - ALWAYS embed lead context using {{placeholder}} tokens in the instruction where it helps the extraction LLM understand what to look for. Available tokens: {{firstName}}, {{lastName}}, {{company}}, {{email}}, {{emailDomain}}, {{title}}. These are substituted with the actual lead's values at runtime before the instruction is sent to the extraction LLM.
   - Example: "Research {{company}} ({{emailDomain}}) to extract: primary industry, current employee count, main products/services offered, key market differentiators, the official LinkedIn company page URL, and the personal LinkedIn profile URL for {{firstName}} {{lastName}}."

2. A list of output field names in snake_case — one field per distinct data point.

   APPROACH: Before naming any fields, read every sentence of the instruction and enumerate ALL data points mentioned anywhere. Do not skip a sentence because it "describes" or "qualifies" another field. Then classify each data point using the rules below.

   Field type rules:
   - Numeric values (employee count, revenue, dates, amounts) → its own field
   - Categorical / label values (funding stage, ICP category, industry, tier) → its own field
   - URL values (LinkedIn URLs, website URLs) → its own field
   - Prose summary (profile, description, overview) → one field for the narrative text (e.g. company_profile), THEN treat every named data point inside that prose request as also requiring its own separate field

   "The profile must describe X, Y, Z" rule:
   X, Y, Z are SEPARATE output fields to extract — not stylistic writing requirements on the prose field. Always produce: the prose field + one field per named item inside it.

   WRONG vs RIGHT — study this before generating fields:
   Instruction: "Research {{company}} to generate a 3-6 sentence company profile. The profile must explicitly describe the company's primary industry, current employee count, main products or services offered, and key market differentiators. Additionally, identify the company's latest funding stage, total funding amount raised, and the date of their most recent funding round. Finally, confirm if {{firstName}} {{lastName}} is currently active in their role at {{company}}, provide their personal LinkedIn profile URL, and extract the date of their last LinkedIn post."
   WRONG: ["latest_funding_stage","total_funding_amount","last_funding_date","is_active_in_role","linkedin_url","last_linkedin_post_date"]  ← first paragraph completely ignored, 5 fields missing
   CORRECT: ["company_profile","industry","employee_count","products_services","market_differentiators","latest_funding_stage","total_funding_amount","last_funding_date","is_active_in_role","linkedin_url","last_linkedin_post_date"]

   Other rules:
   - Do NOT suggest fields already populated on the leads — skip those. EXCEPTION: fields listed as "commonly EMPTY" below are valid targets and MUST be included. Special case: always include "linkedin_url" when the goal mentions personal LinkedIn URL (it is almost always empty even though "linkedin" is a standard field).
   - CONSISTENCY RULE: if you set a linkedinSearchTemplate, you MUST include at least one output field with source ["linkedin"] — typically "linkedin_url". Never generate a linkedinSearchTemplate without a matching linkedin output field.

3. A webSearchTemplate string — ONE search query template used for ALL web_search fields combined. Uses {{placeholder}} tokens: {{firstName}}, {{lastName}}, {{company}}, {{email}}, {{emailDomain}}, {{title}}.
   - Prefer {{emailDomain}} over {{company}} as the company identifier — domains are unique and unambiguous; company names like "Apple" or "CWS" match thousands of unrelated results
   - CRITICAL: Do NOT include field names or data types as search keywords. Words like "funding stage", "employee count", "linkedin", "business model", "industry" are metadata — they pollute the query and cause irrelevant results
   - Add only 1-2 topic keywords that help Google find the right page category (e.g. "company", "startup", "funding", "investors")
   - Keep it 3-5 words total after placeholder substitution
   - Examples:
     - Company research (default): "{{emailDomain}} company overview"
     - Funding focused: "{{emailDomain}} funding investors"
     - Person lookup: "{{firstName}} {{lastName}} {{emailDomain}}"
     - When no email domain available: "{{company}} company overview"

4. A linkedinSearchTemplate string — ONE LinkedIn search query for person-level LinkedIn lookup (only set if any field needs LinkedIn). Format: "{{firstName}} {{lastName}} {{company}}"
   - Omit (null) if no field requires LinkedIn

5. A sourcesPerField object — one entry per output field, listing which sources are needed:
   - "web_search" → most fields (company info, funding, tech stack, company LinkedIn page URL, etc.)
   - "linkedin" → ONLY for the PERSONAL LinkedIn profile of the LEAD. Field names that use this source: linkedin_url, personal_linkedin_url, lead_linkedin_url, linkedin_profile_url. These are fetched via the LinkedIn API. Use "linkedin_url" as the preferred field name — it maps directly to the lead's standard linkedin field.
   - "existing_data" → fields derivable from existing lead data (email_domain from email, etc.)
   - IMPORTANT: company_linkedin_url / company_linkedin ALWAYS uses "web_search" (the company page is found via Google, not via LinkedIn API)
   - IMPORTANT: linkedin_url / personal_linkedin_url / lead_linkedin_url ALWAYS uses "linkedin" (person's profile fetched via LinkedIn API — NOT Google)
   - NEVER combine "web_search" + "linkedin" for the same field — choose one

6. A sources array — union of all sources used across all fields.

Return ONLY valid JSON:
{
  "instruction": "...",
  "outputFields": ["field1", "field2"],
  "webSearchTemplate": "{{company}} company overview employees funding",
  "linkedinSearchTemplate": "{{firstName}} {{lastName}} {{company}}",
  "sourcesPerField": {
    "company_profile": ["web_search"],
    "industry": ["web_search"],
    "employee_count": ["web_search"],
    "company_linkedin_url": ["web_search"],
    "personal_linkedin_url": ["linkedin"]
  },
  "sources": ["web_search", "linkedin"]
}
No markdown, no backticks, no extra text.`;

    const userPrompt = `${existingFieldsSection}Enrichment goal or instruction:\n${goal}`;

    const geminiClient = await agentModeService.getGeminiClient();

    const fallback = {
      instruction: goal,
      outputFields: [] as string[],
      webSearchTemplate: '' as string,
      linkedinSearchTemplate: '' as string,
      sourcesPerField: {} as Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>,
      sources: ['web_search'] as ('web_search' | 'linkedin' | 'existing_data')[],
    };

    let raw = '';
    try {
      const completion = await geminiClient.chat.completions.create({
        model: CrmEnrichmentService.SUGGEST_MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
      });
      raw = completion.choices?.[0]?.message?.content || '';
    } catch (err) {
      // Retry without json_object mode
      try {
        const retry = await geminiClient.chat.completions.create({
          model: CrmEnrichmentService.SUGGEST_MODEL,
          temperature: 0.2,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `${userPrompt}\n\nCRITICAL: Return ONLY a valid JSON object. No markdown, no backticks.` },
          ],
        });
        raw = retry.choices?.[0]?.message?.content || '';
        raw = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
      } catch (retryErr) {
        console.warn('[CrmEnrichment] suggestEnrichment: LLM call failed on retry, using fallback');
        return fallback;
      }
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Last-resort: brace extraction
      const firstBrace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        try {
          parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
        } catch {
          console.warn('[CrmEnrichment] suggestEnrichment: failed to parse LLM response, using fallback');
          return fallback;
        }
      } else {
        console.warn('[CrmEnrichment] suggestEnrichment: no JSON found in LLM response, using fallback');
        return fallback;
      }
    }

    // Normalize outputFields to snake_case
    const outputFields: string[] = Array.isArray(parsed.outputFields)
      ? parsed.outputFields
          .filter((f: any) => typeof f === 'string')
          .map((f: string) => f.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''))
          .filter(Boolean)
      : [];

    const webSearchTemplate: string =
      typeof parsed.webSearchTemplate === 'string' && parsed.webSearchTemplate.trim()
        ? parsed.webSearchTemplate.trim()
        : '';

    const linkedinSearchTemplate: string =
      typeof parsed.linkedinSearchTemplate === 'string' && parsed.linkedinSearchTemplate.trim()
        ? parsed.linkedinSearchTemplate.trim()
        : '';

    const validSources = new Set(['web_search', 'linkedin', 'existing_data']);

    const sourcesPerField: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]> =
      parsed.sourcesPerField && typeof parsed.sourcesPerField === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.sourcesPerField)
              .filter(([k, v]) => typeof k === 'string' && Array.isArray(v))
              .map(([k, v]) => [
                k,
                (v as any[]).filter((s: any) => validSources.has(s)) as ('web_search' | 'linkedin' | 'existing_data')[],
              ])
              .filter(([, v]) => (v as any[]).length > 0)
          )
        : {};

    // Derive job-level sources as union of all per-field sources
    const sources: ('web_search' | 'linkedin' | 'existing_data')[] = (() => {
      if (Object.keys(sourcesPerField).length > 0) {
        const union = new Set<string>();
        Object.values(sourcesPerField).forEach(arr => arr.forEach(s => union.add(s)));
        return Array.from(union) as ('web_search' | 'linkedin' | 'existing_data')[];
      }
      const valid = new Set(['web_search', 'linkedin', 'existing_data']);
      const suggested = Array.isArray(parsed.sources)
        ? parsed.sources.filter((s: any) => valid.has(s))
        : [];
      return suggested.length > 0 ? suggested : ['web_search'];
    })();

    const result = {
      instruction: typeof parsed.instruction === 'string' ? parsed.instruction.trim() : goal,
      outputFields,
      webSearchTemplate,
      linkedinSearchTemplate,
      sourcesPerField,
      sources,
    };

    // Auto-save config to the list
    if (context?.listId && (result.instruction || result.outputFields.length > 0)) {
      try {
        await crmDb.updateSearchQueryTemplates(
          context.listId,
          {},  // searchQueryTemplates no longer used — kept for DB compat
          Object.keys(sourcesPerField).length > 0 ? sourcesPerField : undefined,
          result.instruction || undefined,
          result.outputFields.length > 0 ? result.outputFields : undefined,
          result.webSearchTemplate || undefined,
          result.linkedinSearchTemplate || undefined,
          result.sources.length > 0 ? result.sources : undefined,
        );
      } catch (err) {
        console.warn('[CrmEnrichment] suggestEnrichment: failed to save config to list:', err);
      }
    }

    return result;
  }

  static async enrichWebCompat(listId: string, userId: string, socketId?: string, forceEnrich = false): Promise<EnrichmentExecuteResult> {
    const service = new CrmEnrichmentService();
    return service.execute({
      listId,
      userId,
      instruction: 'Write a 3-6 sentence company profile covering what they do, their industry, products, and notable context. If no good company information is available, return "Company information not found".',
      outputFields: ['web_company_info'],
      sources: ['web_search'],
      forceOverwrite: forceEnrich,
    }, socketId, { progressEvent: 'web-enrich-progress', completeEvent: 'web-enrich-complete' });
  }
}
