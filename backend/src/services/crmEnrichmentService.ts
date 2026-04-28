import { crmDb } from './db';
import { agentModeService } from './agentModeService';
import { settingsService } from './settingsService';
import { incrementExtraCostUsage } from './tokenUsageService';
import { v4 as uuidv4 } from 'uuid';
import {
  buildDataExtractionSystemPrompt,
  buildDataExtractionRetryPrompt,
  buildSuggestEnrichmentSystemPrompt
} from './enrichmentPrompts';

/** LinkedIn API has stricter rate limits */
const PARALLELISM_WITH_LINKEDIN = 5;
/** Web-only enrichment can be more aggressive */
const PARALLELISM_WEB_ONLY = 20;
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

export type EnrichmentSource = 'web_search' | 'linkedin' | 'existing_data';

export interface LeadRecord {
  leadId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  title?: string;
  linkedin?: string;
  phone?: string;
  notes?: string;
  customFields?: Record<string, string>;
  [key: string]: any; // Allow other dynamic fields
}

export interface EnrichmentJobSpec {
  listId: string;
  userId: string;
  instruction: string;
  outputFields: string[];
  sources: EnrichmentSource[];
  filters?: { field: string; operator: string; value?: any }[];
  forceOverwrite?: boolean;
  leadIds?: string[];
  /** Single web search query template with {{placeholder}} substitution.
   *  Covers ALL web_search fields in one call. Auto-built if not provided. */
  webSearchTemplate?: string;
  /** LinkedIn person search query template. Auto-built if not provided. */
  linkedinSearchTemplate?: string;
  /** Per-field source overrides. Falls back to job-level `sources` when absent for a field. */
  sourcesPerField?: Record<string, EnrichmentSource[]>;
}

interface EnrichmentPreviewResult {
  totalLeads: number;
  leadsToProcess: number;
  alreadyEnriched: number;
  samples: { leadId: string; lead: LeadRecord; enrichedFields: Record<string, string | null> }[];
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

export interface LoadAndFilterResult {
  allLeads: LeadRecord[];
  leadsToProcess: LeadRecord[];
  alreadyEnriched: number;
  filteredTotal: number;
  storedSourcesPerField: Record<string, EnrichmentSource[]>;
  storedWebSearchTemplate: string;
  storedLinkedinSearchTemplate: string;
}

export class CrmEnrichmentService {
  private async loadAndFilterLeads(spec: EnrichmentJobSpec): Promise<LoadAndFilterResult> {
    const list = await crmDb.getLeadListById(spec.listId);
    if (!list) {
      throw new Error('Lead list not found');
    }

    // Extract stored config from the list (no extra DB call)
    const storedSourcesPerField: Record<string, EnrichmentSource[]> =
      list.sourcesPerField && typeof list.sourcesPerField === 'object'
        ? (list.sourcesPerField as Record<string, EnrichmentSource[]>)
        : {};

    const storedWebSearchTemplate: string =
      typeof list.webSearchTemplate === 'string' ? list.webSearchTemplate : '';

    const storedLinkedinSearchTemplate: string =
      typeof list.linkedinSearchTemplate === 'string' ? list.linkedinSearchTemplate : '';

    // Load all leads with pagination
    const allLeads: LeadRecord[] = [];
    let lastKey: any = undefined;
    do {
      const result = await crmDb.getLeadsByListId(spec.listId, undefined, lastKey);
      allLeads.push(...((result.items as LeadRecord[]) || []));
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
            default: return false;
          }
        });
      });
    }

    // Determine already-enriched leads (have ALL output fields populated with real values)
    // null is treated as not enriched — it means the previous run found nothing
    const hasAllFields = (lead: LeadRecord) =>
      spec.outputFields.every(field => {
        const value = lead?.customFields?.[field];
        return value !== null && value !== undefined && typeof value === 'string' && value.trim().length > 0;
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

  private static readonly DEFAULT_ENRICH_MODEL = 'gemini-3-flash-preview';
  private static readonly DEFAULT_SUGGEST_MODEL = 'gemini-3-flash-preview';

  static async getEnrichmentConfig(): Promise<{ enrichmentModel: string; dataExtractionModel: string; context: string }> {
    try {
      const setting = await settingsService.getSetting('crm-enrichment-config');
      if (setting?.settingValue) {
        const parsed = JSON.parse(setting.settingValue);
        return {
          enrichmentModel: parsed.enrichmentModel || CrmEnrichmentService.DEFAULT_SUGGEST_MODEL,
          dataExtractionModel: parsed.dataExtractionModel || CrmEnrichmentService.DEFAULT_ENRICH_MODEL,
          context: typeof parsed.context === 'string' ? parsed.context : '',
        };
      }
    } catch {
      // fall through to defaults
    }
    return {
      enrichmentModel: CrmEnrichmentService.DEFAULT_SUGGEST_MODEL,
      dataExtractionModel: CrmEnrichmentService.DEFAULT_ENRICH_MODEL,
      context: '',
    };
  }

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
  static applySearchTemplate(template: string, lead: LeadRecord): string {
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

  private static buildSearchQuery(lead: LeadRecord, outputFields: string[]): string {
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

  private static extractPersonInfo(lead: LeadRecord) {
    const cf = (lead.customFields || {}) as Record<string, string>;
    return {
      firstName: String(lead.firstName || cf.first_name || '').trim(),
      lastName: String(lead.lastName || cf.last_name || '').trim(),
      company: String(lead.company || cf.company_name || '').trim(),
    };
  }

  private static buildFieldGuidance(outputFields: string[]): string {
    const lines: string[] = [];
    for (const field of outputFields) {
      const fl = field.toLowerCase();
      if (/company_linkedin|company.*linkedin|linkedin.*company/.test(fl)) {
        lines.push(`- "${field}": ONLY copy a LinkedIn company page URL that appears verbatim in the web search results above. The URL must start with "https://www.linkedin.com/company/". Do NOT construct, guess, or complete a URL. Return null if no exact /company/ URL is present in the data.`);
      } else if (/linkedin/.test(fl)) {
        lines.push(`- "${field}": ONLY copy a linkedin.com/in/ URL that appears verbatim in the provided data (look in "LinkedIn profile URLs found in search results" and "Resolved LinkedIn profile URL"). Do NOT construct, guess, or complete a URL — even if you think you know the person's LinkedIn handle. Do NOT use /pub/dir/ or /search/ URLs. Return null if no exact /in/ URL is present in the data.`);
      } else if (/employee|headcount|team_size|staff|workforce/.test(fl)) {
        lines.push(`- "${field}": Return only an explicit headcount or range stated in the provided data (e.g. "11-50 employees", "~200"). Do NOT estimate or infer from company descriptions. Return null if no figure is stated.`);
      } else if (/funding|invest|raised|series|venture|round/.test(fl)) {
        lines.push(`- "${field}": Look for VC rounds, grants, or angel investment mentions explicitly stated in the data. If found, state the stage and amount (e.g. "Seed - $1.5M", "Series A - $8M"). If no funding info is present anywhere, return "Bootstrapped / Not publicly funded". Return null only if the company cannot be confirmed to exist.`);
      } else if (/revenue|arr|mrr|income|sales/.test(fl)) {
        lines.push(`- "${field}": Return only revenue or ARR/MRR figures explicitly stated in the data. If not present, return "Not publicly disclosed".`);
      } else if (/tech_stack|technology/.test(fl)) {
        lines.push(`- "${field}": Return only technologies explicitly mentioned in the search results or LinkedIn data. Do NOT infer from product category. Return "Not publicly disclosed" if no signals are found.`);
      } else if (/industry|sector|vertical/.test(fl)) {
        lines.push(`- "${field}": Extract from the company description in the provided data. Return null if the company's industry cannot be clearly determined.`);
      } else {
        lines.push(`- "${field}": Return only what is explicitly stated in the provided data. Return null if not present.`);
      }
    }
    if (lines.length === 0) {
      return 'If a field\'s value is not present in the provided data, return null.';
    }
    return `Field-specific guidance (follow these rules strictly):\n${lines.join('\n')}`;
  }

  private validateLeadForEnrichment(lead: LeadRecord): void {
    const isPersonal = CrmEnrichmentService.isPersonalEmailDomain(lead.email || '');
    const hasCompanyId = !!(lead.company?.trim());
    if (isPersonal && !hasCompanyId) {
      throw Object.assign(
        new Error(`Skipped: personal email (${lead.email}) with no company identification`),
        { step: 'skipped_personal' }
      );
    }
  }

  private async gatherWebContext(lead: LeadRecord, spec: EnrichmentJobSpec, webSearchFields: string[]): Promise<string> {
    let webContext = '';
    const template = spec.webSearchTemplate;
    const query = template
      ? CrmEnrichmentService.applySearchTemplate(template, lead)
      : CrmEnrichmentService.buildSearchQuery(lead, webSearchFields);

    if (query) {
      let result = await agentModeService.searchWeb(query, 5);
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

    return webContext;
  }

  private async gatherLinkedInContext(lead: LeadRecord, spec: EnrichmentJobSpec, linkedInAccountId: string, isEnrichingLinkedin: boolean): Promise<string> {
    let linkedinContext = '';
    try {
      const linkedinUrl = lead.linkedin ? String(lead.linkedin).trim() : '';
      const isValidLinkedInUrl = linkedinUrl && /\/in\//.test(linkedinUrl);
      let profileData: any = null;

      if (isValidLinkedInUrl) {
        const result = await agentModeService.linkedinOutreach(spec.userId, {
          action: 'get-profile',
          account_id: linkedInAccountId,
          profile_url: linkedinUrl,
        });
        if (result?.success) profileData = result.data;
      }

      if (!profileData) {
        const { firstName, lastName, company: existingCompany } = CrmEnrichmentService.extractPersonInfo(lead);
        const name = `${firstName} ${lastName}`.trim();
        const emailDomain = lead.email ? lead.email.split('@')[1] || '' : '';
        const domainCompany = emailDomain && !CrmEnrichmentService.isPersonalEmailDomain(lead.email || '') ? emailDomain : '';
        const company = existingCompany || domainCompany;
        
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
            profileData = topResult;
          }
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
        linkedinContext = `\n\nResolved LinkedIn profile URL: ${linkedinUrl}`;
      }
    } catch (err: any) {
      console.error(`[CrmEnrichment][LinkedIn] lookup failed for lead ${lead?.leadId}: ${err.message}`);
    }
    return linkedinContext;
  }

  private buildLeadContext(lead: LeadRecord, isEnrichingLinkedin: boolean): Record<string, string> {
    const leadContext: Record<string, string> = {};
    const { firstName, lastName, company } = CrmEnrichmentService.extractPersonInfo(lead);
    const name = `${firstName} ${lastName}`.trim();
    if (name) leadContext.name = name;
    if (lead.email) leadContext.email = String(lead.email).trim();
    const cfCtx = (lead.customFields || {}) as Record<string, string>;
    if (lead.title) leadContext.title = String(lead.title || cfCtx.title || '').trim();
    if (leadContext.title === '') delete leadContext.title;
    if (company) leadContext.company = company;
    if (lead.linkedin && !isEnrichingLinkedin) leadContext.linkedin = String(lead.linkedin).trim();
    if (lead.customFields && Object.keys(lead.customFields).length > 0) {
      leadContext.existingCustomFields = JSON.stringify(lead.customFields);
    }
    return leadContext;
  }

  private async extractFieldsViaLLM(
    leadContext: Record<string, string>,
    webContext: string,
    linkedinContext: string,
    spec: EnrichmentJobSpec,
    lead: LeadRecord,
    enrichConfig: { enrichmentModel: string; dataExtractionModel: string; context: string }
  ): Promise<Record<string, string | null>> {
    const resolvedInstruction = CrmEnrichmentService.applySearchTemplate(spec.instruction, lead);
    const { dataExtractionModel, context: globalContext } = enrichConfig;

    const systemPrompt = buildDataExtractionSystemPrompt({
      globalContext,
      resolvedInstruction,
      outputFieldsJson: JSON.stringify(spec.outputFields),
      fieldGuidance: CrmEnrichmentService.buildFieldGuidance(spec.outputFields)
    });

    const userPrompt = `Lead context:\n${JSON.stringify(leadContext, null, 2)}\n${webContext ? `\nWeb search results:\n${webContext}` : ''}${linkedinContext ? `\nLinkedIn data:${linkedinContext}` : ''}\n\nExtract only what is explicitly present in the sources above. Do not infer or fabricate any value. Return null for any field not found in the data.`;

    const llmClient = await agentModeService.getClientForModel(dataExtractionModel);
    let response: Record<string, string> | null = null;
    
    try {
      const completion = await llmClient.chat.completions.create({
        model: dataExtractionModel,
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
      const strictRetryPrompt = buildDataExtractionRetryPrompt(userPrompt, spec.outputFields.map(f => `"${f}":"value"`).join(','));

      const retry = await llmClient.chat.completions.create({
        model: dataExtractionModel,
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
          try {
            response = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
          } catch {
            throw Object.assign(new Error('LLM returned unparseable response after retry'), { step: 'llm' });
          }
        } else {
          throw Object.assign(new Error('LLM returned unparseable response after retry'), { step: 'llm' });
        }
      }
    }

    const fields: Record<string, string | null> = {};
    for (const field of spec.outputFields) {
      const raw = response?.[field];
      fields[field] = typeof raw === 'string' ? raw.trim() || null : null;
    }
    return fields;
  }

  private validateLinkedInUrls(fields: Record<string, string | null>, webContext: string, linkedinContext: string, outputFields: string[]): Record<string, string | null> {
    const allContext = (webContext + linkedinContext).toLowerCase();
    for (const field of outputFields) {
      if (!/linkedin/i.test(field)) continue;
      const value = fields[field];
      if (!value) continue;
      const slugMatch = value.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/i);
      if (slugMatch) {
        const slug = slugMatch[2].toLowerCase();
        if (!allContext.includes(slug)) {
          console.warn(`[CrmEnrichment] Rejected hallucinated LinkedIn URL "${value}" for field "${field}" — slug not in source data`);
          fields[field] = null;
        }
      } else {
        fields[field] = null;
      }
    }
    return fields;
  }

  private async enrichLead(
    lead: LeadRecord,
    spec: EnrichmentJobSpec,
    linkedInAccountId?: string | null,
    enrichConfig?: { enrichmentModel: string; dataExtractionModel: string; context: string }
  ): Promise<{ fields: Record<string, string | null> }> {
    if (!enrichConfig) {
      enrichConfig = await CrmEnrichmentService.getEnrichmentConfig();
    }
    this.validateLeadForEnrichment(lead);

    const effectiveSources = (field: string) => spec.sourcesPerField?.[field] ?? spec.sources;
    const linkedinFields = spec.outputFields.filter(f => effectiveSources(f).includes('linkedin'));
    const isEnrichingLinkedin = linkedinFields.some(f => /linkedin/i.test(f));
    const webSearchFields = spec.outputFields.filter(f => effectiveSources(f).includes('web_search'));

    let webContext = '';
    if (webSearchFields.length > 0) {
      webContext = await this.gatherWebContext(lead, spec, webSearchFields);
    }

    let linkedinContext = '';
    if (linkedinFields.length > 0 && linkedInAccountId) {
      linkedinContext = await this.gatherLinkedInContext(lead, spec, linkedInAccountId, isEnrichingLinkedin);
    }

    const leadContext = this.buildLeadContext(lead, isEnrichingLinkedin);

    if (isEnrichingLinkedin && webContext) {
      const linkedinUrlMatches = webContext.match(/https?:\/\/[a-z]{0,3}\.?linkedin\.com\/in\/[^\s"\\]+/gi) || [];
      if (linkedinUrlMatches.length > 0) {
        const uniqueUrls = [...new Set(linkedinUrlMatches)];
        webContext += `\n\nLinkedIn profile URLs found in search results (use these as candidates):\n${uniqueUrls.join('\n')}`;
      }
    }

    let fields = await this.extractFieldsViaLLM(leadContext, webContext, linkedinContext, spec, lead, enrichConfig!);
    fields = this.validateLinkedInUrls(fields, webContext, linkedinContext, spec.outputFields);

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
  private static splitFields(fields: Record<string, string | null>): {
    standardUpdates: Record<string, string>;
    customUpdates: Record<string, string | null>;
  } {
    const standardUpdates: Record<string, string> = {};
    const customUpdates: Record<string, string | null> = {};

    for (const [key, value] of Object.entries(fields)) {
      const mapped = CrmEnrichmentService.STANDARD_FIELD_MAP[key.toLowerCase()];
      if (mapped) {
        if (value !== null && value !== undefined && value !== '') standardUpdates[mapped] = value;
      } else {
        customUpdates[key] = value ?? null;
      }
    }

    return { standardUpdates, customUpdates };
  }

  private mergeStoredConfig(spec: EnrichmentJobSpec, stored: { storedSourcesPerField: Record<string, EnrichmentSource[]>; storedWebSearchTemplate: string; storedLinkedinSearchTemplate: string }): EnrichmentJobSpec {
    return {
      ...spec,
      webSearchTemplate: spec.webSearchTemplate || stored.storedWebSearchTemplate || undefined,
      linkedinSearchTemplate: spec.linkedinSearchTemplate || stored.storedLinkedinSearchTemplate || undefined,
      sourcesPerField: { ...stored.storedSourcesPerField, ...spec.sourcesPerField },
    };
  }

  async preview(spec: EnrichmentJobSpec): Promise<EnrichmentPreviewResult> {
    const { allLeads, leadsToProcess, alreadyEnriched, filteredTotal, storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate } = await this.loadAndFilterLeads(spec);

    spec = this.mergeStoredConfig(spec, { storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate });

    // Process up to 2 samples
    const samples: EnrichmentPreviewResult['samples'] = [];
    const sampleLeads = leadsToProcess.slice(0, 2);

    if (sampleLeads.length > 0) {
      // Resolve LinkedIn account if needed
      let linkedInAccountId: string | null = null;
      if (spec.sources.includes('linkedin')) {
        linkedInAccountId = await this.resolveLinkedInAccountId(spec.userId);
      }

      const enrichConfig = await CrmEnrichmentService.getEnrichmentConfig();

      for (const lead of sampleLeads) {
        try {
          const { fields } = await this.enrichLead(lead, spec, linkedInAccountId, enrichConfig);
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

    spec = this.mergeStoredConfig(spec, { storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate });

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

    const enrichConfig = await CrmEnrichmentService.getEnrichmentConfig();

    const parallelism = hasLinkedin && linkedInAccountId ? 5 : 20;
    const chunkSize = Math.max(1, Math.ceil(leadsToProcess.length / parallelism));
    const chunks: any[][] = [];
    for (let i = 0; i < leadsToProcess.length; i += chunkSize) {
      chunks.push(leadsToProcess.slice(i, i + chunkSize));
    }

    const counters = { processed: 0, failed: 0, skipped: 0 };
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
          const { fields } = await this.enrichLead(lead, spec, linkedInAccountId, enrichConfig);
          const { standardUpdates, customUpdates } = CrmEnrichmentService.splitFields(fields);

          await crmDb.updateLead(spec.listId, lead.leadId, {
            ...standardUpdates,
            customFields: {
              ...(lead.customFields || {}),
              ...customUpdates,
            },
          });

          counters.processed++;
        } catch (error: any) {
          const step = error?.step || 'unknown';
          if (step === 'skipped_personal') {
            counters.skipped++;
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
            counters.failed++;
            console.error(`[CrmEnrichment] Failed to enrich lead ${lead?.leadId}:`, error);
          }
        }

        const completed = counters.processed + counters.failed + counters.skipped;
        const progress = Math.min((completed / leadsToProcess.length) * 100, 100);
        emitProgress(
          `Enriching ${completed}/${leadsToProcess.length} (${counters.processed} enriched, ${counters.failed} failed, ${counters.skipped} skipped)`,
          progress,
          counters.processed,
          counters.failed,
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

    if (counters.skipped > 0) {
      warnings.push(`${counters.skipped} lead(s) skipped — personal email with no company identification`);
    }

    // Emit completion event
    const completionPayload = {
      jobId,
      listId: spec.listId,
      processedCount: counters.processed,
      failedCount: counters.failed,
      skippedCount: counters.skipped,
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
    if (counters.processed > 0) {
      incrementExtraCostUsage(spec.userId, {
        enrichment: Math.round(counters.processed * ENRICHMENT_COST_PER_LEAD * 10000) / 10000,
      }).catch((err) => console.error('[CrmEnrichment] Failed to record extra cost:', err));
    }

    return {
      jobId,
      processedCount: counters.processed,
      failedCount: counters.failed,
      skippedCount: counters.skipped,
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
    const { enrichmentModel, context: globalContext } = await CrmEnrichmentService.getEnrichmentConfig();

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

    const systemPrompt = buildSuggestEnrichmentSystemPrompt(globalContext);

    const userPrompt = `${existingFieldsSection}Enrichment goal or instruction:\n${goal}`;

    const llmClient = await agentModeService.getClientForModel(enrichmentModel);

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
      const completion = await llmClient.chat.completions.create({
        model: enrichmentModel,
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
        const retry = await llmClient.chat.completions.create({
          model: enrichmentModel,
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
