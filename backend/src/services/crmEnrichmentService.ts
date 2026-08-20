import { crmDb } from './db';
import { usablePublicIdentifier, usableProfileUrl, withoutFabricatedProfileFields } from '../utils/linkedInAnonymizedProfile';
import { agentModeService } from './agentModeService';
import { settingsService } from './settingsService';
import { incrementExtraCostUsage } from './tokenUsageService';
import { meterUsageFromResponse } from '../utils/llmClients';
import { v4 as uuidv4 } from 'uuid';
import {
  getRawDataFromCache,
  writeRawDataToCache,
  buildWebContextFromCache,
  buildLinkedInContextFromCache,
  isLinkedInCacheEligible,
  splitFieldsByGroup,
} from './enrichmentCacheService';
import { FIELD_GROUPS } from './enrichmentGroups';
import type { RawWebResult, RawCacheData } from './enrichmentGroups';
import {
  buildDataExtractionSystemPrompt,
  buildDataExtractionRetryPrompt,
  buildSuggestEnrichmentSystemPrompt,
  buildCriticSystemPrompt,
  buildCriticUserPrompt,
} from './enrichmentPrompts';
import { EnrichedFieldMeta, trimQuote } from '../utils/enrichedFieldValue';
import { normalizeFields, Normalized } from './enrichmentFieldTypes';
import { fetchTopPages } from './webContentFetcher';
import { runSpecialists } from './enrichmentSpecialists';
import { normalizeEnrichmentFieldConfig } from './enrichmentFieldConfig';
import { resolveFieldAliases } from './enrichmentFieldAliasService';
import { getOrCreateClustersForFields, type FieldCluster } from './enrichmentClusterService';
import { getUnipileSearchParamService } from './unipileSearchParamServiceFactory';
import { enrichLog } from '../utils/enrichmentLogger';
import { isApolloServiceReady, getApolloService } from './apolloService';

/**
 * Stage 3 rollout flag — gates the LinkedIn company-id resolver + confidence
 * scoring path inside gatherLinkedInContext. Default is ON outside production
 * so dev/staging see the new behavior; prod stays on the legacy blind-items[0]
 * path until the flag is explicitly enabled.
 */
function isLinkedInIdResolutionEnabled(): boolean {
  const v = process.env.CRM_USE_LINKEDIN_ID_RESOLUTION;
  if (v === 'true') return true;
  if (v === 'false') return false;
  // Default ON outside production + tests. Tests must opt in explicitly so
  // pre-Stage-3 fixtures continue exercising the legacy code path.
  return process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test';
}

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

/** Metadata returned by the LLM alongside each extracted field value, used to verify the claim is grounded in the sources. */
export interface FieldCitation {
  sourceQuote?: string;
  sourceUrl?: string;
  confidence?: 'high' | 'medium' | 'low';
  /** Set by the critic pass (item #6) when it runs. */
  criticVerdict?: 'supported' | 'partially-supported' | 'unsupported' | 'contradicted';
}

export interface LeadRecord {
  leadId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailDomain?: string;
  company?: string;
  website?: string;
  title?: string;
  linkedin?: string;
  phone?: string;
  notes?: string;
  customFields?: Record<string, string>;
  /** CRM-internal sidecar — findReason, freshUntil, scheduledRunAt,
   *  icpSource. Not user-authored; not exported in CSVs. */
  system?: Record<string, any>;
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
  /** Bypass AW-EnrichmentRawCache and re-fetch from APIs. Distinct from forceOverwrite
   *  (which re-enriches leads that already have all output fields populated). */
  forceRefreshCache?: boolean;
  /** User-field-name → canonical FIELD_GROUPS field-name map. Resolved once
   *  per job at execute()/preview() entry by enrichmentFieldAliasService and
   *  passed through to splitFieldsByGroup so user variants like
   *  `funding_round` land in the right group instead of ungrouped. */
  fieldAliases?: Record<string, string>;
  /** Field-name → natural-language description map. Used by the clustering
   *  service to generate per-cluster search templates for ungrouped fields.
   *  Optional: if absent, the LLM clusters from field names alone. */
  fieldDescriptions?: Record<string, string>;
  /** Per-list enrich.so field config — gates which fields the reverse-lookup
   *  specialists write to a lead. Loaded from `AW-LeadLists.enrichmentFieldConfig`
   *  in loadAndFilterLeads and passed through to runSpecialists. Optional: when
   *  absent, defaults apply (standard fields ON, extended fields OFF). */
  enrichmentFieldConfig?: import('./enrichmentFieldConfig').EnrichmentFieldConfig;
  /** When true, attempts Apollo org enrichment as Tier 1 before web search.
   *  If Apollo returns technology_names, those are fed to the LLM and web
   *  search is skipped. Falls back to web search when Apollo is unavailable,
   *  lead has no domain, or Apollo returns no tech data. */
  apolloTechStack?: boolean;
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

    // Per-list enrichment field config — passed through to specialists so they
    // can decide which enrich.so fields to write to each lead.
    spec.enrichmentFieldConfig = normalizeEnrichmentFieldConfig(
      list.enrichmentFieldConfig as Partial<Record<string, unknown>> | null | undefined,
    );

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

  // Default to Azure-hosted gpt-5-chat-2: GA, capacity-stable, ~10s on the
  // CRM enrichment workload. We previously defaulted to gemini-3-flash-preview,
  // but Gemini's *-preview shards intermittently queue requests for 200+ s
  // (the per-call 60s timeout fires, then the fallback eats another minute),
  // producing 3+ minute previews that often returned all-null fields.
  // On timeout we fall back to a Gemini GA model so we have cross-vendor
  // redundancy when one provider is degraded.
  private static readonly DEFAULT_ENRICH_MODEL = 'gpt-5-chat-2';
  private static readonly DEFAULT_SUGGEST_MODEL = 'gpt-5-chat-2';

  // Fallback used by llmCallWithTimeout when the primary model times out.
  // Cross-vendor on purpose — if Azure throttles, Gemini absorbs; if Gemini
  // queues, Azure absorbs.
  private static readonly LLM_FALLBACK_MODEL = 'gemini-2.5-flash';

  // Per-call ceiling. The OpenAI SDK aborts the underlying fetch when this
  // fires. Chosen so the worst case for a 2-sample preview is ~2 min.
  private static readonly LLM_CALL_TIMEOUT_MS = 60_000;

  // ── Process-level LLM circuit breaker ────────────────────────────────────
  // When Gemini's preview model is degraded (queueing requests for minutes),
  // the per-call fallback eats a fresh 60-s timeout *before* every single
  // call — wasted compute and latency. The breaker tracks recent timeouts
  // and, once the threshold is hit, "opens" the circuit so all subsequent
  // calls go straight to the fallback model for COOLDOWN_MS, then reset.
  // State is in-memory (per-process) — fine for our single-instance EB
  // backend; not persisted across restarts.
  private static readonly LLM_CIRCUIT_THRESHOLD = 3;            // timeouts in window → open
  private static readonly LLM_CIRCUIT_WINDOW_MS = 5 * 60_000;   // sliding window for counting
  private static readonly LLM_CIRCUIT_COOLDOWN_MS = 10 * 60_000; // how long the breaker stays open
  private static llmTimeoutTimestamps: number[] = [];
  private static llmCircuitOpenUntil = 0;

  private static isLlmCircuitOpen(): boolean {
    return Date.now() < CrmEnrichmentService.llmCircuitOpenUntil;
  }

  private static recordLlmTimeout(): void {
    const now = Date.now();
    CrmEnrichmentService.llmTimeoutTimestamps =
      CrmEnrichmentService.llmTimeoutTimestamps.filter(
        t => now - t < CrmEnrichmentService.LLM_CIRCUIT_WINDOW_MS
      );
    CrmEnrichmentService.llmTimeoutTimestamps.push(now);
    if (
      CrmEnrichmentService.llmTimeoutTimestamps.length >=
      CrmEnrichmentService.LLM_CIRCUIT_THRESHOLD
    ) {
      CrmEnrichmentService.llmCircuitOpenUntil =
        now + CrmEnrichmentService.LLM_CIRCUIT_COOLDOWN_MS;
      console.warn(
        `[CrmEnrichment] LLM circuit OPEN — primary model is degraded ` +
        `(${CrmEnrichmentService.LLM_CIRCUIT_THRESHOLD} timeouts in ${CrmEnrichmentService.LLM_CIRCUIT_WINDOW_MS / 60_000} min); ` +
        `routing to fallback ${CrmEnrichmentService.LLM_FALLBACK_MODEL} for the next ` +
        `${CrmEnrichmentService.LLM_CIRCUIT_COOLDOWN_MS / 60_000} min`
      );
      // Reset the counter so we don't re-open immediately on stale entries
      // when the cooldown elapses.
      CrmEnrichmentService.llmTimeoutTimestamps = [];
    }
  }

  private static isLlmTimeoutError(err: any): boolean {
    return (
      err?.name === 'APIConnectionTimeoutError' ||
      err?.code === 'ETIMEDOUT' ||
      err?.message?.toLowerCase?.().includes('timed out') ||
      err?.message?.toLowerCase?.().includes('timeout')
    );
  }

  /**
   * Run an LLM call with a per-call timeout. On timeout, retry once using
   * LLM_FALLBACK_MODEL — Gemini occasionally queues `*-preview` requests for
   * several minutes (we've seen 200–260 s on the same input that returns in
   * 6 s elsewhere), and the GA model is consistently fast.
   *
   * The caller's `call` receives the model id to use so it can swap models
   * between primary and fallback. Non-timeout errors propagate immediately —
   * the caller's existing parse-retry path handles malformed responses.
   */
  // Returns `any` because the underlying llmClient.chat.completions.create
  // is typed as `any` (Gemini wrapper around the OpenAI SDK), and a generic T
  // would just resolve to `unknown` and force casts at every call site.
  private static async llmCallWithTimeout(
    call: (model: string) => Promise<any>,
    primaryModel: string,
    label: string,
    fallbackModel: string = CrmEnrichmentService.LLM_FALLBACK_MODEL,
  ): Promise<any> {
    const fallback = fallbackModel;

    // Circuit open: skip the primary entirely for the cooldown period. Saves
    // a 60s timeout per call when Gemini's preview model is broadly degraded.
    if (CrmEnrichmentService.isLlmCircuitOpen()) {
      console.log(
        `[CrmEnrichment][llmCallWithTimeout] ${label} circuit OPEN, ` +
        `routing directly to fallback ${fallback} (skipping ${primaryModel})`
      );
      return await call(fallback);
    }

    try {
      return await call(primaryModel);
    } catch (err: any) {
      if (!CrmEnrichmentService.isLlmTimeoutError(err)) throw err;
      // Tick the breaker. If this push trips the threshold, the circuit
      // opens for COOLDOWN_MS and *next* calls skip the primary entirely.
      CrmEnrichmentService.recordLlmTimeout();
      console.warn(
        `[CrmEnrichment][llmCallWithTimeout] ${label} timed out on ${primaryModel} after ` +
        `${CrmEnrichmentService.LLM_CALL_TIMEOUT_MS}ms, retrying with fallback ${fallback}`
      );
      try {
        return await call(fallback);
      } catch (retryErr: any) {
        if (CrmEnrichmentService.isLlmTimeoutError(retryErr)) {
          throw Object.assign(
            new Error(`LLM call timed out twice (${label}, primary=${primaryModel}, fallback=${fallback})`),
            { step: 'llm', timedOut: true },
          );
        }
        throw retryErr;
      }
    }
  }

  static async getEnrichmentConfig(): Promise<{ enrichmentModel: string; dataExtractionModel: string }> {
    try {
      const setting = await settingsService.getSetting('crm-enrichment-config');
      if (setting?.settingValue) {
        const parsed = JSON.parse(setting.settingValue);
        return {
          enrichmentModel: parsed.enrichmentModel || CrmEnrichmentService.DEFAULT_SUGGEST_MODEL,
          dataExtractionModel: parsed.dataExtractionModel || CrmEnrichmentService.DEFAULT_ENRICH_MODEL,
        };
      }
    } catch {
      // fall through to defaults
    }
    return {
      enrichmentModel: CrmEnrichmentService.DEFAULT_SUGGEST_MODEL,
      dataExtractionModel: CrmEnrichmentService.DEFAULT_ENRICH_MODEL,
    };
  }

  // Non-business email domains — using these as a company identifier produces wrong results.
  // "Personal" is used loosely here to mean "not a sales-target company domain":
  // free providers (gmail, hotmail), institutional TLDs (.edu, .gov, .mil, .ac.*),
  // and disposable/throwaway email providers.
  private static readonly PERSONAL_EMAIL_DOMAINS = new Set([
    // Major free providers
    'gmail.com', 'googlemail.com',
    'yahoo.com', 'yahoo.co.uk', 'yahoo.co.jp', 'yahoo.fr', 'yahoo.de', 'yahoo.es', 'yahoo.it', 'yahoo.com.br', 'yahoo.com.au', 'yahoo.in',
    'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de', 'hotmail.es', 'hotmail.it',
    'outlook.com', 'outlook.co.uk', 'live.com', 'live.co.uk', 'live.fr', 'live.de',
    'msn.com',
    'aol.com', 'aim.com',
    'icloud.com', 'me.com', 'mac.com',
    'protonmail.com', 'proton.me', 'pm.me',
    'mail.com', 'email.com',
    'zoho.com', 'zohomail.com',
    'yandex.com', 'yandex.ru',
    'qq.com', '163.com', '126.com', '139.com', 'sina.com', 'sina.cn',
    'naver.com', 'daum.net',
    'rediffmail.com',
    'inbox.com', 'fastmail.com', 'tutanota.com', 'tuta.io',
    'gmx.com', 'gmx.de', 'gmx.net',
    't-online.de', 'web.de', 'orange.fr', 'free.fr', 'laposte.net',
    'libero.it',
    'rambler.ru',
    // Disposable / temporary mail (popular ones)
    'mailinator.com', 'guerrillamail.com', 'throwawaymail.com', '10minutemail.com',
    'yopmail.com', 'temp-mail.org', 'tempmail.com', 'getnada.com', 'sharklasers.com',
  ]);

  /**
   * Returns true for institutional / educational / government TLDs where the domain
   * isn't a sales-target company. Includes:
   *   .edu, .edu.{cc}            (universities, schools)
   *   .gov, .gov.{cc}, .mil      (government, military)
   *   .ac.{cc}                   (UK/India/etc. academic)
   *   .gob.{cc}, .gouv.{cc}      (Spanish/French government)
   */
  static isInstitutionalDomain(domain: string): boolean {
    const d = domain.toLowerCase().trim();
    if (!d) return false;
    if (/\.edu(\.[a-z]{2,3})?$/.test(d)) return true;
    if (/\.gov(\.[a-z]{2,3})?$/.test(d)) return true;
    if (/\.mil(\.[a-z]{2,3})?$/.test(d)) return true;
    if (/\.ac\.[a-z]{2,3}$/.test(d)) return true;
    if (/\.gob\.[a-z]{2,3}$/.test(d)) return true;
    if (/\.gouv\.[a-z]{2,3}$/.test(d)) return true;
    return false;
  }

  /**
   * Reserved / filler domains that belong to no real company. Base names only —
   * `isPlaceholderDomain` also matches their subdomains.
   */
  private static readonly PLACEHOLDER_DOMAINS = new Set([
    // RFC 2606 reserved second-level names
    'example.com', 'example.net', 'example.org', 'example.edu', 'example.co',
    // Canonical filler addresses people type into test/seed rows
    'company.com', 'yourcompany.com', 'mycompany.com', 'thecompany.com',
    'domain.com', 'yourdomain.com', 'mydomain.com',
    'test.com', 'testing.com', 'sample.com', 'notarealdomain.com',
    // Our own QA domain (matches the onboarding stuck-detector filter)
    'agenttest.com',
    'localhost',
  ]);

  /**
   * True for reserved / placeholder / QA domains that can never be a real
   * prospect's employer: RFC 2606 + 6761 reserved names (example.*, .test,
   * .invalid, .localhost) and the canonical filler domains that show up in
   * seeded test rows.
   *
   * ENG-968: these were treated as ordinary business domains, so junk rows like
   * `queue-verify@example.com` and `test2@company.com` seeded firmographic
   * lookups and came back with an invented company, funding_round and revenue.
   * A couple of these bases (company.com, domain.com) do host real businesses;
   * refusing to enrich them is the deliberate fail-closed trade — a not-found is
   * recoverable, a fabricated funding round flowing into ICP scoring is not.
   */
  static isPlaceholderDomain(domain: string): boolean {
    const d = domain.toLowerCase().trim().replace(/\.+$/, '');
    if (!d) return false;
    if (CrmEnrichmentService.PLACEHOLDER_DOMAINS.has(d)) return true;
    // RFC 6761 reserved TLDs.
    if (/\.(test|example|invalid|localhost)$/.test(d)) return true;
    // Subdomains of a reserved/filler base (mail.example.com, corp.test.com).
    for (const base of CrmEnrichmentService.PLACEHOLDER_DOMAINS) {
      if (d.endsWith(`.${base}`)) return true;
    }
    return false;
  }

  static isPersonalEmailDomain(email: string): boolean {
    const domain = (email.split('@')[1] || '').toLowerCase().trim();
    if (!domain) return false;
    if (CrmEnrichmentService.PERSONAL_EMAIL_DOMAINS.has(domain)) return true;
    if (CrmEnrichmentService.isInstitutionalDomain(domain)) return true;
    if (CrmEnrichmentService.isPlaceholderDomain(domain)) return true;
    return false;
  }

  static isPersonalDomain(domain: string): boolean {
    const d = domain.toLowerCase().trim();
    if (!d) return false;
    if (CrmEnrichmentService.PERSONAL_EMAIL_DOMAINS.has(d)) return true;
    if (CrmEnrichmentService.isInstitutionalDomain(d)) return true;
    if (CrmEnrichmentService.isPlaceholderDomain(d)) return true;
    return false;
  }

  static extractDomain(website: string): string | null {
    try {
      const url = new URL(website.includes('://') ? website : `https://${website}`);
      return url.hostname.replace(/^www\./, '').trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Substitute {{placeholder}} tokens in a search query template with actual lead field values.
   * Multi-space gaps left by empty substitutions are collapsed to a single space.
   */
  static applySearchTemplate(template: string, lead: LeadRecord): string {
    // ENG-433: {{emailDomain}} is omitted for personal/institutional emails
    // (gmail, yahoo, .edu, .gov, .ac.*). Such a domain is never the lead's
    // company, and seeding a firmographic web search with it resolves the
    // free-mail provider or university AS the company (e.g. the company_firmographic
    // template "{{emailDomain}} company overview" → "berkeley.edu company overview"
    // → "University of California, Berkeley"). Mirrors the guard in fetchApolloOrg
    // and the v2 query builder. Person searches keep the signal via {{email}},
    // which still carries the full address.
    const emailDomainToken =
      lead.email && !CrmEnrichmentService.isPersonalEmailDomain(lead.email)
        ? (String(lead.email).split('@')[1] || '')
        : '';
    return template
      .replace(/\{\{firstName\}\}/g, lead.firstName || '')
      .replace(/\{\{lastName\}\}/g, lead.lastName || '')
      .replace(/\{\{company\}\}/g, lead.company || '')
      .replace(/\{\{email\}\}/g, lead.email || '')
      .replace(/\{\{emailDomain\}\}/g, emailDomainToken)
      .replace(/\{\{title\}\}/g, lead.title || '')
      .replace(/\{\{linkedin\}\}/g, lead.linkedin || '')
      .replace(/\{\{customFields\.(\w+)\}\}/g, (_: string, f: string) => lead.customFields?.[f] || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  /**
   * True when applying `template` to this lead produces the same string as
   * applying it to an empty lead — i.e. every {{placeholder}} resolved to
   * empty. In that case the search query contains nothing lead-specific,
   * just the constant suffix (e.g. "company overview"), and Google would
   * return generic top-ranking pages identical for every empty-signal lead
   * — most famously the FedEx investor page for "company overview".
   *
   * Callers should skip web search entirely when this returns true; the LLM
   * then returns null for those fields rather than confidently extracting
   * the wrong company.
   */
  static templateHasNoLeadSignal(template: string, lead: LeadRecord): boolean {
    const rendered = CrmEnrichmentService.applySearchTemplate(template, lead);
    const renderedEmpty = CrmEnrichmentService.applySearchTemplate(template, {} as LeadRecord);
    return rendered === renderedEmpty;
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
      ? CrmEnrichmentService.isPersonalDomain(emailDomain)
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

  private async gatherWebContext(
    lead: LeadRecord,
    spec: EnrichmentJobSpec,
    webSearchFields: string[]
  ): Promise<{ webContext: string; rawResults: RawWebResult[]; linkedinCompanyResults: RawWebResult[] | null; queryUsed: string }> {
    let webContext = '';
    let rawResults: RawWebResult[] = [];
    let linkedinCompanyResults: RawWebResult[] | null = null;

    const template = spec.webSearchTemplate;
    const query = template
      ? CrmEnrichmentService.applySearchTemplate(template, lead)
      : CrmEnrichmentService.buildSearchQuery(lead, webSearchFields);

    // Skip the main web search when a template-driven query would produce
    // generic top-ranked results for every empty-signal lead (e.g. emailDomain
    // empty → query collapses to "company overview" → Google returns the same
    // FedEx page for every lead in the list).
    const skipMainSearch = !!template && CrmEnrichmentService.templateHasNoLeadSignal(template, lead);
    if (skipMainSearch) {
      console.log(`[CrmEnrichment][gatherWebContext] skipping web search lead=${lead.leadId}: template "${template}" has no lead-specific signal`);
    }

    if (query && !skipMainSearch) {
      console.log(`[CrmEnrichment][gatherWebContext] searchWeb query="${query}"`);
      let result = await agentModeService.youSearchWeb(query, 5);
      console.log(`[CrmEnrichment][gatherWebContext] searchWeb done success=${result?.success} resultCount=${Array.isArray(result?.results) ? result.results.length : 0}`);
      const primarySucceededEmpty = result?.success && (!Array.isArray(result.results) || result.results.length === 0);
      if (primarySucceededEmpty) {
        const personName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
        const fallbackQuery = personName
          ? `${personName} ${lead.company || ''}`.trim()
          : `${lead.company || (!CrmEnrichmentService.isPersonalEmailDomain(lead.email || '') ? lead.email?.split('@')[1] : '') || ''} company overview`.trim();
        if (fallbackQuery && fallbackQuery !== query) {
          result = await agentModeService.youSearchWeb(fallbackQuery, 5);
        }
      }

      if (result?.success && Array.isArray(result.results) && result.results.length > 0) {
        rawResults = result.results as RawWebResult[];
        webContext = JSON.stringify(rawResults, null, 2);

        // Item #1 — Page-content fetch for top results.
        // Snippets miss the actual data ~30-50% of the time. Fetch top 2 pages
        // and append cleaned main text. Gated by env flag for staged rollout.
        if (process.env.ENRICHMENT_PAGE_FETCH !== '0') {
          const urls = rawResults.map(r => r.url).filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
          if (urls.length > 0) {
            try {
              const pages = await fetchTopPages(urls, 2);
              if (pages.length > 0) {
                webContext += `\n\nFull page content (top results):\n${pages
                  .map(p => `--- ${p.title} (${p.url}) ---\n${p.text}`)
                  .join('\n\n')}`;
              }
            } catch (err: any) {
              console.warn(`[CrmEnrichment] page fetch failed: ${err?.message}`);
            }
          }
        }
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
        ? CrmEnrichmentService.isPersonalDomain(emailDomain)
        : false;
      const companyTerm = (!isPersonalDomain && emailDomain) || String(lead.company || '').trim();
      if (companyTerm) {
        try {
          const linkedinCompanyQuery = `${companyTerm} site:linkedin.com/company`;
          const linkedinCompanyResult = await agentModeService.youSearchWeb(linkedinCompanyQuery, 5);
          if (linkedinCompanyResult?.success && Array.isArray(linkedinCompanyResult.results) && linkedinCompanyResult.results.length > 0) {
            linkedinCompanyResults = linkedinCompanyResult.results as RawWebResult[];
            const companyUrls = linkedinCompanyResults
              .map((r: RawWebResult) => r.url || '')
              .filter((url: string) => /linkedin\.com\/company\//i.test(url));
            webContext += `\n\nDedicated LinkedIn company page search results:\n${JSON.stringify(linkedinCompanyResults, null, 2)}`;
            if (companyUrls.length > 0) {
              webContext += `\n\nLinkedIn company page URLs found in dedicated search (use these first):\n${companyUrls.join('\n')}`;
            }
          }
        } catch (err: any) {
          console.warn(`[CrmEnrichment] LinkedIn company page search failed for lead ${lead?.leadId}: ${err.message}`);
        }
      }
    }

    return { webContext, rawResults, linkedinCompanyResults, queryUsed: query };
  }

  // Calls gatherWebContext always using the group's canonical searchTemplate.
  // The job-level webSearchTemplate is intentionally ignored for grouped fields
  // so the cache key (groupName#v{version}) always maps to the same query across jobs.
  // (Job-level template only applies to ungrouped fields via the legacy gatherWebContext path.)
  private async gatherWebContextForGroup(
    lead: LeadRecord,
    spec: EnrichmentJobSpec,
    groupName: string,
    groupFields: string[]
  ): Promise<{ webContext: string; rawResults: RawWebResult[]; linkedinCompanyResults: RawWebResult[] | null; queryUsed: string }> {
    const groupTemplate = FIELD_GROUPS[groupName]?.searchTemplate;
    const groupSpec = groupTemplate ? { ...spec, webSearchTemplate: groupTemplate } : spec;
    return this.gatherWebContext(lead, groupSpec, groupFields);
  }

  /**
   * For ungrouped fields, the cluster service provides an LLM-generated search
   * template per ad-hoc cluster. This mirrors gatherWebContextForGroup —
   * cluster.searchTemplate replaces the canonical group template.
   */
  private async gatherWebContextForCluster(
    lead: LeadRecord,
    spec: EnrichmentJobSpec,
    cluster: FieldCluster
  ): Promise<{ webContext: string; rawResults: RawWebResult[]; linkedinCompanyResults: RawWebResult[] | null; queryUsed: string }> {
    const clusterSpec = { ...spec, webSearchTemplate: cluster.searchTemplate };
    return this.gatherWebContext(lead, clusterSpec, cluster.fields);
  }

  private async gatherLinkedInContext(
    lead: LeadRecord,
    spec: EnrichmentJobSpec,
    linkedInAccountId: string,
    isEnrichingLinkedin: boolean
  ): Promise<{
    linkedinContext: string;
    rawProfile: Record<string, unknown> | null;
    publicIdentifier: string | null;
    profileId: string | null;
    /** 'high' = picked candidate matches resolved company_id; 'low' = fallback /
     *  resolver miss / no match; 'unspecified' = legacy path (flag off). */
    confidence: 'high' | 'low' | 'unspecified';
  }> {
    let linkedinContext = '';
    let rawProfile: Record<string, unknown> | null = null;
    let publicIdentifier: string | null = null;
    let profileId: string | null = null;
    let confidence: 'high' | 'low' | 'unspecified' = 'unspecified';

    const useIdResolution = isLinkedInIdResolutionEnabled();

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
          // ── Stage 3: resolve company → company_id and pick the matching
          // candidate. Resolver failures degrade gracefully to the legacy
          // free-text path with confidence='low'. If the resolver singleton
          // isn't initialized at all (test env or pre-Stage-3 deploy), fully
          // fall back to the legacy unspecified-confidence path.
          let resolvedCompanyId: string | null = null;
          let resolverActive = useIdResolution;
          if (useIdResolution) {
            try {
              resolvedCompanyId = await getUnipileSearchParamService().resolveTopId(
                linkedInAccountId,
                { type: 'COMPANY', keywords: company },
              );
            } catch (err: any) {
              if (typeof err?.message === 'string' && err.message.includes('not initialized')) {
                resolverActive = false;
              } else {
                console.warn(`[CrmEnrichment][LinkedIn] company-id resolver failed for lead ${lead?.leadId}: ${err?.message}`);
              }
              resolvedCompanyId = null;
            }
          }

          const searchArgs: Record<string, unknown> = {
            action: 'search-people',
            account_id: linkedInAccountId,
          };
          if (resolverActive && resolvedCompanyId) {
            searchArgs.keywords = name;
            searchArgs.company_id = resolvedCompanyId;
          } else {
            // Legacy path (flag off OR resolver miss OR resolver uninitialized)
            // — preserves existing behavior.
            searchArgs.keywords = `${name} ${company}`;
          }

          const searchResult = await agentModeService.linkedinOutreach(spec.userId, searchArgs as any);
          const items = searchResult?.data?.items || [];

          // ── Selection logic (replaces blind items[0]) ─────────────────────
          let pickedItem: any = null;
          if (resolverActive) {
            if (resolvedCompanyId) {
              const matched = items.find((it: any) => it?.current_role?.company?.id === resolvedCompanyId);
              if (matched) {
                pickedItem = matched;
                confidence = 'high';
              } else {
                pickedItem = items[0] ?? null;
                confidence = 'low';
              }
            } else {
              pickedItem = items[0] ?? null;
              confidence = 'low';
            }
            if (confidence === 'low') {
              enrichLog.warn({
                event: 'linkedin_context_low_confidence',
                leadId: lead?.leadId,
                company,
                candidateCount: items.length,
                resolvedCompanyId,
              });
            }
          } else {
            pickedItem = items[0] ?? null;
            // confidence stays 'unspecified' in legacy / uninitialized path
          }

          if (pickedItem?.provider_id) {
            const profileResult = await agentModeService.linkedinOutreach(spec.userId, {
              action: 'get-profile',
              account_id: linkedInAccountId,
              provider_id: pickedItem.provider_id,
            });
            if (profileResult?.success) profileData = profileResult.data;
          } else if (pickedItem?.public_identifier || pickedItem?.public_profile_url) {
            profileData = pickedItem;
          }
        }
      }

      if (profileData) {
        // The whole profile object is serialized into the LLM's context below and
        // stored for the cache-replay path, so rejecting the sentinel only where a
        // URL gets built leaves the fabricated `/in/undefined` reachable anyway —
        // the model can read it straight out of the blob, and citation verification
        // then accepts it because the slug really is in the source context.
        const sanitizedProfile = withoutFabricatedProfileFields(profileData as Record<string, unknown>);
        rawProfile = sanitizedProfile;
        // ENG-1198: Unipile anonymizes out-of-network profiles with
        // public_identifier literally the string 'undefined' — that string is
        // truthy, so leaving it here would make the URL construction below (and
        // the cache-rebuild path in buildLinkedInContextFromCache) synthesize a
        // fake https://www.linkedin.com/in/undefined and hand it to the
        // enrichment LLM as a "Resolved LinkedIn profile URL".
        publicIdentifier = usablePublicIdentifier(profileData?.public_identifier);
        profileId = profileData?.provider_id ?? null;

        if (confidence === 'low') {
          // Drop Unipile-derived structured fields and the resolved profile URL
          // from the LLM context — wrong-company contamination would corrupt
          // downstream extraction. Web-search-regex URLs (added later in
          // enrichLead) are independent and survive.
          linkedinContext = '';
        } else {
          // Read from the SANITIZED copy: on the raw object a fabricated
          // `public_profile_url` short-circuits this `||` chain and masks a legitimate
          // `url`/`profile_url` that would otherwise have been used.
          const rawUrl = sanitizedProfile?.public_profile_url || sanitizedProfile?.url || sanitizedProfile?.profile_url || null;
          // Rejecting the identifier above is only half of it: Unipile builds
          // `public_profile_url` from that same bad identifier and sends it too, so
          // this fallback re-created the very /in/undefined URL the identifier check
          // had just refused, and handed it to the enrichment LLM as a resolved
          // profile (ENG-1198 follow-up).
          const cleanUrl = usableProfileUrl(rawUrl);
          const profileUrl = publicIdentifier
            ? `https://www.linkedin.com/in/${publicIdentifier}`
            : cleanUrl;
          linkedinContext = `\nLinkedIn profile data:\n${JSON.stringify(sanitizedProfile, null, 2)}`;
          if (profileUrl && isEnrichingLinkedin) {
            linkedinContext += `\n\nResolved LinkedIn profile URL: ${profileUrl}`;
          }
        }
      } else if (isEnrichingLinkedin && isValidLinkedInUrl && confidence !== 'low') {
        // `isValidLinkedInUrl` is only a `/in/` substring test, so the lead's own
        // stored URL can BE the fabricated one — earlier enrichment runs wrote
        // `/in/undefined` back onto `lead.linkedin`, which makes this self-perpetuating.
        // Citation verification cannot catch it either: it accepts a URL whose slug
        // appears in the source context, and the slug here is the word "undefined".
        const storedUrl = usableProfileUrl(linkedinUrl);
        if (storedUrl) {
          linkedinContext = `\n\nResolved LinkedIn profile URL: ${storedUrl}`;
        }
      }
    } catch (err: any) {
      console.error(`[CrmEnrichment][LinkedIn] lookup failed for lead ${lead?.leadId}: ${err.message}`);
    }
    return { linkedinContext, rawProfile, publicIdentifier, profileId, confidence };
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
    enrichConfig: { enrichmentModel: string; dataExtractionModel: string }
  ): Promise<{ fields: Record<string, string | null>; metadata: Record<string, FieldCitation> }> {
    const resolvedInstruction = CrmEnrichmentService.applySearchTemplate(spec.instruction, lead);
    const { dataExtractionModel } = enrichConfig;

    const systemPrompt = buildDataExtractionSystemPrompt({
      resolvedInstruction,
      outputFieldsJson: JSON.stringify(spec.outputFields),
      fieldGuidance: CrmEnrichmentService.buildFieldGuidance(spec.outputFields)
    });

    const userPrompt = `Lead context:\n${JSON.stringify(leadContext, null, 2)}\n${webContext ? `\nWeb search results:\n${webContext}` : ''}${linkedinContext ? `\nLinkedIn data:${linkedinContext}` : ''}\n\nExtract only what is explicitly present in the sources above. Do not infer or fabricate any value. Return null for any field not found in the data.`;

    console.log(`[CrmEnrichment][extractFieldsViaLLM] calling LLM model=${dataExtractionModel} outputFields=${JSON.stringify(spec.outputFields)}`);
    const tLlm = Date.now();
    let response: Record<string, unknown> | null = null;

    try {
      const completion = await CrmEnrichmentService.llmCallWithTimeout(
        async (model) => {
          // Resolve the client from the model actually selected. A timeout can
          // cross providers; reusing the primary client's transport with the
          // fallback model silently sends the fallback request to the wrong API.
          const llmClient = await agentModeService.getClientForModel(model);
          return llmClient.chat.completions.create({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
            response_format: { type: 'json_object' },
          }, { timeout: CrmEnrichmentService.LLM_CALL_TIMEOUT_MS });
        },
        dataExtractionModel,
        'extractFieldsViaLLM:json',
      );
      meterUsageFromResponse({
        userId: spec.userId,
        model: dataExtractionModel,
        provider: dataExtractionModel.startsWith('anthropic') || dataExtractionModel.startsWith('claude') ? 'bedrock' : 'azure',
        feature: 'crm_enrichment_extract',
      }, completion);
      const raw = completion.choices?.[0]?.message?.content || '';
      console.log(`[CrmEnrichment][extractFieldsViaLLM] LLM responded in ${Date.now()-tLlm}ms rawLen=${raw.length}`);
      response = JSON.parse(raw);
    } catch {
      const retryExample = spec.outputFields
        .map(f => `"${f}":{"value":"...","sourceQuote":"...","sourceUrl":"...","confidence":"high"}`)
        .join(',');
      const strictRetryPrompt = buildDataExtractionRetryPrompt(userPrompt, retryExample);

      const retry = await CrmEnrichmentService.llmCallWithTimeout(
        async (model) => {
          const llmClient = await agentModeService.getClientForModel(model);
          return llmClient.chat.completions.create({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: strictRetryPrompt },
            ],
          }, { timeout: CrmEnrichmentService.LLM_CALL_TIMEOUT_MS });
        },
        dataExtractionModel,
        'extractFieldsViaLLM:plain',
      );
      meterUsageFromResponse({
        userId: spec.userId,
        model: dataExtractionModel,
        provider: dataExtractionModel.startsWith('anthropic') || dataExtractionModel.startsWith('claude') ? 'bedrock' : 'azure',
        feature: 'crm_enrichment_extract',
      }, retry);
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
    const metadata: Record<string, FieldCitation> = {};
    for (const field of spec.outputFields) {
      const raw = response?.[field];

      // Null / missing → null value, no metadata
      if (raw === null || raw === undefined) {
        fields[field] = null;
        continue;
      }

      // Legacy flat-string format → keep as-is, no metadata (skips citation verification)
      if (typeof raw === 'string') {
        fields[field] = raw.trim() || null;
        continue;
      }

      // Rich citation format → extract value and metadata
      if (typeof raw === 'object') {
        const rich = raw as Record<string, unknown>;
        const valueRaw = rich.value;
        // LLM may return value as JSON boolean (true/false), number (50000000), or string.
        // Coerce to string so downstream consumers (verifyCitations, normalizeFields,
        // customFields persistence) all work uniformly.
        let value: string | null;
        if (valueRaw === null || valueRaw === undefined) {
          value = null;
        } else if (typeof valueRaw === 'boolean') {
          value = valueRaw ? 'true' : 'false';
        } else if (typeof valueRaw === 'number') {
          value = String(valueRaw);
        } else if (typeof valueRaw === 'string') {
          value = valueRaw.trim() || null;
        } else {
          value = null;
        }
        fields[field] = value;
        if (value !== null) {
          const conf = rich.confidence;
          metadata[field] = {
            // Cap the quote at parse time so a hallucinated multi-KB quote
            // can't (a) bloat in-memory metadata across many parallel leads
            // or (b) explode verifyCitations' 5-word soft-match window scan.
            sourceQuote: trimQuote(typeof rich.sourceQuote === 'string' ? rich.sourceQuote : undefined),
            sourceUrl: typeof rich.sourceUrl === 'string' ? rich.sourceUrl.trim() : undefined,
            confidence: conf === 'high' || conf === 'medium' || conf === 'low' ? conf : undefined,
          };
        }
        continue;
      }

      // Anything else (number, boolean, array) — treat as missing
      fields[field] = null;
    }
    return { fields, metadata };
  }

  /**
   * Item #6 — Critic / verifier pass. After extraction + citation verification,
   * a cheap second LLM pass judges each remaining claim. Unsupported / contradicted
   * claims are dropped to null. Partially-supported claims have confidence downgraded
   * to "low" and a `criticVerdict` is recorded in metadata.
   *
   * Skipped if no claims have citations (legacy flat-string responses) or if the
   * env flag ENRICHMENT_CRITIC=0 is set.
   */
  private async runCriticPass(
    fields: Record<string, string | null>,
    citations: Record<string, FieldCitation>,
    sourceContext: string,
    enrichConfig: { dataExtractionModel: string },
    userId?: string
  ): Promise<void> {
    if (process.env.ENRICHMENT_CRITIC === '0') return;

    const claims: { field: string; value: string; sourceQuote?: string }[] = [];
    for (const [field, value] of Object.entries(fields)) {
      if (value == null || value === '') continue;
      // Only critique claims that have a citation (rich-format extractions). Legacy
      // flat-string responses lack quotes; nothing for the critic to compare against.
      const meta = citations[field];
      if (!meta) continue;
      claims.push({ field, value, sourceQuote: meta.sourceQuote });
    }
    if (claims.length === 0) return;

    try {
      const completion = await CrmEnrichmentService.llmCallWithTimeout(
        async (model) => {
          const llmClient = await agentModeService.getClientForModel(model);
          return llmClient.chat.completions.create({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: buildCriticSystemPrompt() },
              { role: 'user', content: buildCriticUserPrompt(claims, sourceContext) },
            ],
            response_format: { type: 'json_object' },
          }, { timeout: CrmEnrichmentService.LLM_CALL_TIMEOUT_MS });
        },
        enrichConfig.dataExtractionModel,
        'criticPass',
      );
      meterUsageFromResponse({
        userId,
        model: enrichConfig.dataExtractionModel,
        provider: enrichConfig.dataExtractionModel.startsWith('anthropic') || enrichConfig.dataExtractionModel.startsWith('claude') ? 'bedrock' : 'azure',
        feature: 'crm_enrichment_critic',
      }, completion);
      const raw = completion.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(raw) as Record<string, { verdict?: string; reason?: string }>;
      for (const c of claims) {
        const verdict = parsed[c.field]?.verdict;
        if (!verdict) continue;
        // Mutate citation entry with verdict for sidecar metadata
        const cite = citations[c.field] as FieldCitation & { criticVerdict?: string };
        cite.criticVerdict = verdict as any;
        // Only DROP when the critic explicitly says the source contradicts the claim.
        // "unsupported" is too aggressive for SERP snippets — they often lack the literal
        // value but still corroborate the claim contextually. We keep the value at low
        // confidence so the user can decide; verifyCitations already filtered out outright
        // hallucinations via substring matching.
        if (verdict === 'contradicted') {
          console.warn(`[CrmEnrichment] Critic dropped "${c.field}"="${c.value}" verdict=contradicted`);
          fields[c.field] = null;
        } else if (verdict === 'unsupported' || verdict === 'partially-supported') {
          if (cite.confidence !== 'low') cite.confidence = 'low';
        }
      }
    } catch (err: any) {
      // Critic failure is non-fatal — keep extraction results as-is
      console.warn(`[CrmEnrichment] Critic pass failed: ${err?.message}`);
    }
  }

  /**
   * Verify each extracted value is supported by the provided sources.
   *
   * Rejection rules (set value to null):
   *   - Field name contains "linkedin" but value isn't a valid /in/ or /company/ URL
   *   - LinkedIn URL slug doesn't appear in the source context (defense vs. plausible hallucinations)
   *   - Rich-format response present but sourceQuote is missing
   *   - sourceQuote (case-insensitive, whitespace-collapsed) is not a substring of the source context
   *
   * Legacy flat-string responses (no metadata entry) bypass citation verification for back-compat.
   */
  static verifyCitations(
    fields: Record<string, string | null>,
    metadata: Record<string, FieldCitation>,
    sourceContext: string,
    outputFields: string[]
  ): Record<string, string | null> {
    const normalizedSource = sourceContext.toLowerCase().replace(/\s+/g, ' ').trim();

    for (const field of outputFields) {
      const value = fields[field];
      if (!value) continue;

      // LinkedIn URL slug-validation (kept as defense-in-depth alongside citation check)
      if (/linkedin/i.test(field)) {
        const slugMatch = value.match(/linkedin\.com\/(in|company)\/([^/?#\s]+)/i);
        if (!slugMatch) {
          fields[field] = null;
          continue;
        }
        const slug = slugMatch[2].toLowerCase();
        if (!normalizedSource.includes(slug)) {
          console.warn(`[CrmEnrichment] Rejected hallucinated LinkedIn URL "${value}" for field "${field}" — slug not in source data`);
          fields[field] = null;
          continue;
        }
      }

      // Citation verification — only applies to rich-format responses (metadata entry exists)
      const meta = metadata[field];
      if (meta === undefined) continue;  // legacy flat-string → keep as-is

      const quote = meta.sourceQuote ? meta.sourceQuote.toLowerCase().replace(/\s+/g, ' ').trim() : '';
      if (!quote) {
        console.warn(`[CrmEnrichment] Rejected unsupported claim for field "${field}" — sourceQuote missing`);
        fields[field] = null;
        continue;
      }
      if (!normalizedSource.includes(quote)) {
        // Soft-match fallback: accept if any 5-consecutive-word window from the quote
        // appears verbatim in the source. Handles minor LLM rephrasing
        // (e.g. punctuation changes, dropped articles) without letting hallucinations through.
        // Defensive cap on the window-scan: trimQuote already enforces ~240 chars at
        // parse time, but a future caller could still push a long quote through here.
        const MAX_QUOTE_WORDS_FOR_SOFT_MATCH = 60;
        const words = quote.split(' ').filter(w => w.length > 0).slice(0, MAX_QUOTE_WORDS_FOR_SOFT_MATCH);
        let softMatch = false;
        if (words.length >= 5) {
          for (let i = 0; i + 5 <= words.length; i++) {
            const window = words.slice(i, i + 5).join(' ');
            if (normalizedSource.includes(window)) { softMatch = true; break; }
          }
        }
        if (!softMatch) {
          console.warn(`[CrmEnrichment] Rejected unsupported claim for field "${field}" — quote not found in source: "${meta.sourceQuote}"`);
          fields[field] = null;
          continue;
        }
      }
    }

    return fields;
  }

  private async enrichLead(
    lead: LeadRecord,
    spec: EnrichmentJobSpec,
    linkedInAccountId?: string | null,
    enrichConfig?: { enrichmentModel: string; dataExtractionModel: string }
  ): Promise<{
    fields: Record<string, string | null>;
    metadata: Record<string, FieldCitation>;
    normalized: Record<string, Normalized>;
  }> {
    const t0 = Date.now();
    if (!enrichConfig) {
      enrichConfig = await CrmEnrichmentService.getEnrichmentConfig();
    }
    this.validateLeadForEnrichment(lead);

    const effectiveSources = (field: string) => spec.sourcesPerField?.[field] ?? spec.sources;
    const linkedinFields = spec.outputFields.filter(f => effectiveSources(f).includes('linkedin'));
    const isEnrichingLinkedin = linkedinFields.some(f => /linkedin/i.test(f));
    const webSearchFields = spec.outputFields.filter(f => effectiveSources(f).includes('web_search'));
    console.log(`[CrmEnrichment][enrichLead] lead=${lead.leadId} webSearchFields=${webSearchFields.length} linkedinFields=${linkedinFields.length} isEnrichingLinkedin=${isEnrichingLinkedin}`);

    // ── Specialists (item #7) ────────────────────────────────────────────
    // Field-specific resolvers (e.g., Crunchbase for funding_round) run BEFORE
    // the LLM. Resolved values are removed from the LLM job to avoid duplicate
    // work; their source contexts are appended to combinedSource so the
    // pipeline's citation-verification step can still validate them.
    const specialistOut = await runSpecialists(spec.outputFields, lead, {
      userId: spec.userId,
      linkedInAccountId: linkedInAccountId ?? null,
      enrichmentFieldConfig: spec.enrichmentFieldConfig,
    });
    const specialistFields = specialistOut.resolvedFields;
    const specialistMeta = specialistOut.resolvedMeta;
    const specialistSourceContexts = specialistOut.sourceContexts;
    const fieldsForLLM = spec.outputFields.filter(f => !(f in specialistFields));
    if (Object.keys(specialistFields).length > 0) {
      console.log(`[CrmEnrichment][enrichLead] specialists resolved ${Object.keys(specialistFields).length} fields lead=${lead.leadId}: ${Object.keys(specialistFields).join(',')}`);
    }
    if (specialistOut.failures.length > 0) {
      // Non-fatal: LLM-extraction path still runs for these fields. Logged as
      // structured warnings so an operator can see *why* a value fell back.
      for (const f of specialistOut.failures) {
        console.warn(`[CrmEnrichment][enrichLead] specialist ${f.label} failed for ${f.field} (lead=${lead.leadId}): ${f.message}`);
      }
    }

    // Recompute effective field lists against the LLM-eligible set
    const llmLinkedinFields = linkedinFields.filter(f => fieldsForLLM.includes(f));
    const llmWebSearchFields = webSearchFields.filter(f => fieldsForLLM.includes(f));

    const forceRefreshCache = spec.forceRefreshCache ?? false;

    // ── Build extraction units ────────────────────────────────────────────
    // Each unit becomes one focused LLM call with only the context that field
    // group needs. Groups are independent (cache hit/miss + extraction), so
    // a 2-group job runs 2 parallel LLM calls instead of one mega-call.
    type Unit = { webContext: string; linkedinContext: string; fields: string[]; label: string };
    const units: Unit[] = [];

    // ── Tier 1: Apollo tech stack (optional) ─────────────────────────────────
    // Fires before web search when spec.apolloTechStack is true. Extracts domain
    // from emailDomain or website, calls matchOrg, and if technology_names are
    // returned builds a single LLM unit from the Apollo list — skipping web search.
    // Falls back to web search on any failure or empty result.
    let apolloTechStackContext: string | null = null;
    if (spec.apolloTechStack && llmWebSearchFields.length > 0 && isApolloServiceReady()) {
      const domain =
        lead.emailDomain ||
        (lead.website ? CrmEnrichmentService.extractDomain(lead.website) : null) ||
        (lead.email ? lead.email.split('@')[1]?.trim() || null : null) ||
        null;
      const isPersonalDomain = domain ? CrmEnrichmentService.isPersonalDomain(domain) : false;
      if (domain && !isPersonalDomain) {
        try {
          const orgResult = await getApolloService().matchOrg(domain);
          const techStack = orgResult.organization?.techStack;
          if (techStack && techStack.length > 0) {
            apolloTechStackContext = `Apollo technology data for ${domain}:\n${techStack.join(', ')}`;
            console.log(`[CrmEnrichment][enrichLead] apollo tech stack HIT domain=${domain} lead=${lead.leadId} tools=${techStack.length}`);
          } else {
            console.log(`[CrmEnrichment][enrichLead] apollo tech stack MISS domain=${domain} lead=${lead.leadId}, falling back to web search`);
          }
        } catch (err: any) {
          console.warn(`[CrmEnrichment][enrichLead] apollo tech stack error domain=${domain} lead=${lead.leadId}: ${err?.message}`);
        }
      } else {
        console.log(`[CrmEnrichment][enrichLead] apollo tech stack SKIP lead=${lead.leadId} reason=${!domain ? 'no-domain' : 'personal-domain'}`);
      }
      if (apolloTechStackContext) {
        units.push({ webContext: apolloTechStackContext, linkedinContext: '', fields: llmWebSearchFields, label: 'apollo:tech_stack' });
      }
    }

    if (llmWebSearchFields.length > 0 && !apolloTechStackContext) {
      const { byGroup, ungrouped } = splitFieldsByGroup(llmWebSearchFields, { aliases: spec.fieldAliases });

      for (const [groupName, groupFields] of byGroup) {
        const hasCompanyLinkedinField = groupFields.some(f =>
          /company_linkedin|company.*linkedin|linkedin.*company/.test(f.toLowerCase())
        );
        const cachedData = await getRawDataFromCache(lead, groupName, forceRefreshCache);

        let groupCtx = '';
        if (cachedData) {
          console.log(`[CrmEnrichment][enrichLead] web cache HIT group=${groupName} lead=${lead.leadId}`);
          groupCtx = buildWebContextFromCache(cachedData, hasCompanyLinkedinField);
        } else {
          console.log(`[CrmEnrichment][enrichLead] web cache MISS group=${groupName} lead=${lead.leadId}, fetching`);
          const { webContext: ctx, rawResults, linkedinCompanyResults, queryUsed } =
            await this.gatherWebContextForGroup(lead, spec, groupName, groupFields);
          groupCtx = ctx;
          console.log(`[CrmEnrichment][enrichLead] gatherWebContextForGroup DONE group=${groupName} lead=${lead.leadId} results=${rawResults.length} elapsed=${Date.now()-t0}ms`);

          if (rawResults.length > 0) {
            const rawCacheData: RawCacheData = { webResults: rawResults, linkedinCompanyResults, linkedinData: null };
            writeRawDataToCache(lead, groupName, rawCacheData, queryUsed, ['web_search']).catch(err =>
              console.warn(`[CrmEnrichment] web cache write failed group=${groupName} lead=${lead.leadId}: ${err.message}`)
            );
          }
        }

        units.push({ webContext: groupCtx, linkedinContext: '', fields: groupFields, label: `web:${groupName}` });
      }

      if (ungrouped.length > 0) {
        // Backward compat: if the caller explicitly provided a webSearchTemplate
        // (older API clients, existing tests), use the legacy single-search path.
        // New callers (UI, Emma) drop the template and get cluster-based dispatch.
        if (spec.webSearchTemplate && spec.webSearchTemplate.trim().length > 0) {
          console.log(`[CrmEnrichment][enrichLead] ungrouped fields=${ungrouped} lead=${lead.leadId}, using caller-provided webSearchTemplate (legacy path)`);
          const { webContext: ctx } = await this.gatherWebContext(lead, spec, ungrouped);
          units.push({ webContext: ctx, linkedinContext: '', fields: ungrouped, label: 'web:ungrouped-legacy' });
        } else {
          // Cluster ungrouped fields via the LLM-curated cluster service. Each
          // cluster gets its own search query — like an ad-hoc canonical group —
          // and bundles related fields together. Persisted per list so this
          // LLM call only fires once per (list, novel-field-set).
          const emailDomainForCtx = lead.email
            ? (CrmEnrichmentService.isPersonalEmailDomain(lead.email) ? '' : (String(lead.email).split('@')[1] || ''))
            : '';
          try {
            const clusterResult = await getOrCreateClustersForFields(
              spec.listId,
              ungrouped,
              spec.fieldDescriptions || {},
              { company: lead.company, emailDomain: emailDomainForCtx },
              spec.userId,
            );
            if (clusterResult.newlyCreated.length > 0) {
              console.log(`[CrmEnrichment][enrichLead] LLM-clustered ungrouped fields lead=${lead.leadId}: ${JSON.stringify(clusterResult.newlyCreated.map(c => ({ fields: c.fields, q: c.searchTemplate })))}`);
            }
            for (const cluster of clusterResult.clusters) {
              const { webContext: ctx } = await this.gatherWebContextForCluster(lead, spec, cluster);
              units.push({
                webContext: ctx,
                linkedinContext: '',
                fields: cluster.fields,
                label: `cluster:${cluster.fields.slice(0, 2).join('+')}`,
              });
            }
          } catch (err: any) {
            // Defense-in-depth: if clustering throws, fall back to single legacy search
            console.warn(`[CrmEnrichment][enrichLead] cluster service failed lead=${lead.leadId}: ${err?.message}`);
            const { webContext: ctx } = await this.gatherWebContext(lead, spec, ungrouped);
            units.push({ webContext: ctx, linkedinContext: '', fields: ungrouped, label: 'web:ungrouped-fallback' });
          }
        }
      }
    }

    // ── LinkedIn unit (cache-aware) ────────────────────────────────────────
    if (llmLinkedinFields.length > 0 && linkedInAccountId) {
      const linkedinCacheEligible = isLinkedInCacheEligible(llmLinkedinFields);
      const cachedLinkedinData = linkedinCacheEligible
        ? await getRawDataFromCache(lead, 'person_identity', forceRefreshCache)
        : null;

      let linkedinCtx = '';
      if (cachedLinkedinData?.linkedinData) {
        console.log(`[CrmEnrichment][enrichLead] linkedin cache HIT lead=${lead.leadId}`);
        linkedinCtx = buildLinkedInContextFromCache(cachedLinkedinData, isEnrichingLinkedin);
      } else {
        console.log(`[CrmEnrichment][enrichLead] gatherLinkedInContext START lead=${lead.leadId}`);
        const { linkedinContext: ctx, rawProfile, publicIdentifier, profileId, confidence } =
          await this.gatherLinkedInContext(lead, spec, linkedInAccountId, isEnrichingLinkedin);
        linkedinCtx = ctx;
        console.log(`[CrmEnrichment][enrichLead] gatherLinkedInContext DONE lead=${lead.leadId} contextLen=${linkedinCtx.length} confidence=${confidence} elapsed=${Date.now()-t0}ms`);

        // Don't cache low-confidence (wrong-company) profile data — that would
        // poison future enrichment runs for this lead.
        if (linkedinCacheEligible && rawProfile && confidence !== 'low') {
          const rawCacheData: RawCacheData = {
            webResults: [],
            linkedinCompanyResults: null,
            linkedinData: {
              profileId: profileId ?? '',
              publicIdentifier: publicIdentifier ?? '',
              rawProfile,
              fetchedAt: new Date().toISOString(),
            },
          };
          writeRawDataToCache(lead, 'person_identity', rawCacheData, '', ['linkedin']).catch(err =>
            console.warn(`[CrmEnrichment] linkedin cache write failed lead=${lead.leadId}: ${err.message}`)
          );
        }
      }

      // If we're enriching a LinkedIn URL, surface candidate URLs scraped from web results
      // so the LinkedIn extraction unit can copy them verbatim instead of hallucinating.
      if (isEnrichingLinkedin) {
        const combinedWebForUrlHint = units.filter(u => u.webContext).map(u => u.webContext).join('\n\n');
        if (combinedWebForUrlHint) {
          const linkedinUrlMatches = combinedWebForUrlHint.match(/https?:\/\/[a-z]{0,3}\.?linkedin\.com\/in\/[^\s"\\]+/gi) || [];
          if (linkedinUrlMatches.length > 0) {
            const uniqueUrls = [...new Set(linkedinUrlMatches)];
            linkedinCtx += `\n\nLinkedIn profile URLs found in search results (use these as candidates):\n${uniqueUrls.join('\n')}`;
          }
        }
      }

      units.push({ webContext: '', linkedinContext: linkedinCtx, fields: llmLinkedinFields, label: 'linkedin' });
    }

    // Fallback: a job with no LLM-eligible fields after specialists is fine —
    // we'll skip the LLM dispatch entirely. If there ARE LLM-eligible fields
    // but no context-bearing units, fall through with an empty-context unit.
    if (units.length === 0 && fieldsForLLM.length > 0) {
      units.push({ webContext: '', linkedinContext: '', fields: fieldsForLLM, label: 'no_context' });
    }

    const leadContext = this.buildLeadContext(lead, isEnrichingLinkedin);

    console.log(`[CrmEnrichment][enrichLead] dispatching ${units.length} extraction unit(s) lead=${lead.leadId} labels=${units.map(u => u.label).join(',')}`);
    const extractions = await Promise.all(units.map(unit =>
      this.extractFieldsViaLLM(
        leadContext,
        unit.webContext,
        unit.linkedinContext,
        { ...spec, outputFields: unit.fields },
        lead,
        enrichConfig!
      )
    ));

    // Merge: prefer non-null over null when same field appears in multiple units
    const fieldsMerged: Record<string, string | null> = {};
    const citationsMerged: Record<string, FieldCitation> = {};
    for (const ext of extractions) {
      for (const [k, v] of Object.entries(ext.fields)) {
        if (v !== null || !(k in fieldsMerged)) fieldsMerged[k] = v;
      }
      for (const [k, m] of Object.entries(ext.metadata)) {
        if (m && (!citationsMerged[k] || (m.sourceQuote && !citationsMerged[k].sourceQuote))) {
          citationsMerged[k] = m;
        }
      }
    }

    // Merge specialist results — they take precedence over LLM if both present
    // (specialists are higher-confidence by design)
    for (const [k, v] of Object.entries(specialistFields)) {
      if (v !== null && v !== undefined) fieldsMerged[k] = v;
    }
    for (const [k, m] of Object.entries(specialistMeta)) {
      citationsMerged[k] = {
        sourceQuote: (m as any).sourceQuote,
        sourceUrl: (m as any).sourceUrl,
        confidence: (m as any).confidence,
      };
    }

    // ── Targeted re-search (item #4) ──────────────────────────────────────
    // For each web unit where less than 50% of fields filled, do ONE more search
    // with field-name keywords appended, then re-extract just the missing fields.
    // Hard cap: 1 retry per group per lead. Gated by env flag for staged rollout.
    const sourceContextParts: string[] = [
      ...units.map(u => u.webContext + u.linkedinContext),
      ...specialistSourceContexts,  // include specialists' source spans for verification
    ];
    if (process.env.ENRICHMENT_TARGETED_RESEARCH !== '0') {
      const FILL_RATE_THRESHOLD = 0.5;
      const emailDomainForRetry = lead.email
        ? (CrmEnrichmentService.isPersonalEmailDomain(lead.email) ? '' : (String(lead.email).split('@')[1] || ''))
        : '';
      const companyForRetry = String(lead.company || '').trim();
      const companyTermForRetry = emailDomainForRetry || companyForRetry;

      for (const unit of units) {
        if (!unit.label.startsWith('web:')) continue;
        if (unit.fields.length === 0) continue;
        const filled = unit.fields.filter(f => fieldsMerged[f] != null && fieldsMerged[f] !== '').length;
        const fillRate = filled / unit.fields.length;
        if (fillRate >= FILL_RATE_THRESHOLD) continue;

        const missing = unit.fields.filter(f => fieldsMerged[f] == null || fieldsMerged[f] === '');
        if (missing.length === 0) continue;
        if (!companyTermForRetry) continue;

        const targetedQuery = `${companyTermForRetry} ${missing.join(' ').replace(/_/g, ' ')}`.trim();
        try {
          const targetedResult = await agentModeService.youSearchWeb(targetedQuery, 5);
          if (!targetedResult?.success || !Array.isArray(targetedResult.results) || targetedResult.results.length === 0) continue;
          const targetedCtx = JSON.stringify(targetedResult.results, null, 2);
          sourceContextParts.push(targetedCtx);

          const retryExtraction = await this.extractFieldsViaLLM(
            leadContext, targetedCtx, '',
            { ...spec, outputFields: missing },
            lead, enrichConfig!
          );
          for (const f of missing) {
            const v = retryExtraction.fields[f];
            if (v != null && v !== '') {
              fieldsMerged[f] = v;
              const m = retryExtraction.metadata[f];
              if (m) citationsMerged[f] = m;
            }
          }
        } catch (err: any) {
          console.warn(`[CrmEnrichment] Targeted re-search failed group=${unit.label} lead=${lead.leadId}: ${err?.message}`);
        }
      }
    }

    // Verify against the union of all sources — a quote may originate in any unit's context.
    // The lead's own context (existing customFields, name, email) is also a valid source —
    // the LLM sees it in the user prompt, so it can legitimately cite from it. Without
    // including it here, "city_orig: San Francisco" type quotes get false-rejected.
    const leadContextStr = JSON.stringify(leadContext);
    const combinedSource = leadContextStr + '\n\n' + sourceContextParts.join('\n\n');
    let fields = CrmEnrichmentService.verifyCitations(fieldsMerged, citationsMerged, combinedSource, spec.outputFields);

    // Critic / verifier pass (item #6) — drops unsupported claims, downgrades partial ones
    await this.runCriticPass(fields, citationsMerged, combinedSource, enrichConfig!, spec.userId);

    console.log(`[CrmEnrichment][enrichLead] extractFieldsViaLLM DONE lead=${lead.leadId} elapsed=${Date.now()-t0}ms fields=${JSON.stringify(fields)}`);

    // Normalize recognized fields (funding_stage, employee_count, etc.) into canonical/typed forms
    const normalizationResult = normalizeFields(fields);
    fields = normalizationResult.fields;
    return { fields, metadata: citationsMerged, normalized: normalizationResult.normalized };
  }

  /**
   * For each non-null enriched field, build a sidecar EnrichedFieldMeta record.
   * Standard fields get metadata too — UI joins by field name regardless of standard/custom.
   */
  private static buildEnrichmentMetadata(
    fields: Record<string, string | null>,
    citations: Record<string, FieldCitation>,
    normalized: Record<string, Normalized>,
    spec: EnrichmentJobSpec,
    jobId: string,
    enrichedAt: string
  ): Record<string, EnrichedFieldMeta> {
    const out: Record<string, EnrichedFieldMeta> = {};
    for (const [field, value] of Object.entries(fields)) {
      if (value === null || value === undefined || value === '') continue;
      // Pick a primary source: per-field override > linkedin in name > web_search default
      const perField = spec.sourcesPerField?.[field];
      const sources = perField && perField.length > 0 ? perField : spec.sources;
      const primarySource: EnrichedFieldMeta['source'] =
        sources.includes('linkedin') && /linkedin/i.test(field) ? 'linkedin'
        : sources.includes('web_search') ? 'web_search'
        : sources.includes('linkedin') ? 'linkedin'
        : sources.includes('existing_data') ? 'existing_data'
        : 'web_search';
      const citation = citations[field];
      out[field] = {
        source: primarySource,
        sourceUrl: citation?.sourceUrl,
        sourceQuote: trimQuote(citation?.sourceQuote),
        confidence: citation?.confidence,
        enrichedAt,
        enrichedJobId: jobId,
        normalized: normalized[field] ?? undefined,
        criticVerdict: citation?.criticVerdict,
      };
    }
    return out;
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
    console.log(`[CrmEnrichment][preview] START listId=${spec.listId} userId=${spec.userId} sources=${JSON.stringify(spec.sources)} outputFields=${JSON.stringify(spec.outputFields)}`);
    const t0 = Date.now();
    const { allLeads, leadsToProcess, alreadyEnriched, filteredTotal, storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate } = await this.loadAndFilterLeads(spec);
    console.log(`[CrmEnrichment][preview] loadAndFilterLeads done: allLeads=${allLeads.length} leadsToProcess=${leadsToProcess.length} alreadyEnriched=${alreadyEnriched} elapsed=${Date.now()-t0}ms`);

    spec = this.mergeStoredConfig(spec, { storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate });

    // Resolve user-named fields to canonical FIELD_GROUPS names. Once. Cached
    // per list. See enrichmentFieldAliasService.
    const aliasResult = await resolveFieldAliases(spec.listId, spec.outputFields, spec.userId);
    spec = { ...spec, fieldAliases: aliasResult.effectiveMap };
    if (Object.keys(aliasResult.newlyResolved).length > 0) {
      console.log(`[CrmEnrichment][preview] LLM-resolved new aliases: ${JSON.stringify(aliasResult.newlyResolved)}`);
    }

    // Process up to 2 samples
    const samples: EnrichmentPreviewResult['samples'] = [];
    const sampleLeads = leadsToProcess.slice(0, 2);
    console.log(`[CrmEnrichment][preview] sampleLeads count=${sampleLeads.length}`);

    if (sampleLeads.length > 0) {
      // Resolve LinkedIn account if needed
      let linkedInAccountId: string | null = null;
      if (spec.sources.includes('linkedin')) {
        console.log(`[CrmEnrichment][preview] resolving LinkedIn account for userId=${spec.userId}`);
        linkedInAccountId = await this.resolveLinkedInAccountId(spec.userId);
        console.log(`[CrmEnrichment][preview] linkedInAccountId=${linkedInAccountId}`);
      }

      console.log(`[CrmEnrichment][preview] loading enrichment config`);
      const enrichConfig = await CrmEnrichmentService.getEnrichmentConfig();
      console.log(`[CrmEnrichment][preview] enrichConfig model=${enrichConfig.dataExtractionModel}`);

      for (const lead of sampleLeads) {
        console.log(`[CrmEnrichment][preview] enriching sample lead ${lead.leadId} (${lead.email || lead.company || ''})`);
        try {
          // Disable apolloTechStack in preview — Apollo org calls burn real credits.
          const previewSpec = spec.apolloTechStack ? { ...spec, apolloTechStack: false } : spec;
          const { fields } = await this.enrichLead(lead, previewSpec, linkedInAccountId, enrichConfig);
          console.log(`[CrmEnrichment][preview] lead ${lead.leadId} enriched OK fields=${JSON.stringify(Object.keys(fields))}`);
          samples.push({ leadId: lead.leadId, lead, enrichedFields: fields });
        } catch (err) {
          console.error(`[CrmEnrichment][preview] lead ${lead.leadId} enrichment failed:`, err);
          samples.push({ leadId: lead.leadId, lead, enrichedFields: { _error: String(err) } });
        }
      }
    }
    console.log(`[CrmEnrichment][preview] DONE totalElapsed=${Date.now()-t0}ms samples=${samples.length}`);

    return {
      totalLeads: spec.leadIds ? filteredTotal : allLeads.length,
      leadsToProcess: leadsToProcess.length,
      alreadyEnriched,
      samples,
    };
  }

  private static pickMappedStandardFields(lead: LeadRecord, standardUpdates: Record<string, string>): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const key of Object.keys(standardUpdates)) {
      result[key] = (lead as any)[key] ?? null;
    }
    return result;
  }

  private static pickCustomFieldValues(customFields: Record<string, any> | undefined, customUpdates: Record<string, string | null>): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    for (const key of Object.keys(customUpdates)) {
      result[key] = customFields?.[key] ?? null;
    }
    return result;
  }

  async execute(spec: EnrichmentJobSpec, socketId?: string, options?: { progressEvent?: string; completeEvent?: string; socketEmit?: SocketEmitFn }): Promise<EnrichmentExecuteResult> {
    const progressEvent = options?.progressEvent || 'crm-enrichment-progress';
    const completeEvent = options?.completeEvent || 'crm-enrichment-complete';
    const jobId = uuidv4();
    const jobExpiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
    const warnings: string[] = [];

    const { leadsToProcess, storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate } = await this.loadAndFilterLeads(spec);

    spec = this.mergeStoredConfig(spec, { storedSourcesPerField, storedWebSearchTemplate, storedLinkedinSearchTemplate });

    // Resolve user-named fields to canonical FIELD_GROUPS names. Once per job.
    // Persisted per list — subsequent jobs hit the cache without an LLM call.
    const aliasResult = await resolveFieldAliases(spec.listId, spec.outputFields, spec.userId);
    spec = { ...spec, fieldAliases: aliasResult.effectiveMap };
    if (Object.keys(aliasResult.newlyResolved).length > 0) {
      console.log(`[CrmEnrichment][execute] LLM-resolved new aliases: ${JSON.stringify(aliasResult.newlyResolved)}`);
      warnings.push(`Mapped fields via LLM: ${Object.entries(aliasResult.newlyResolved).map(([k, v]) => `${k}→${v}`).join(', ')}`);
    }

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
    const attemptedLeadIds: string[] = [];
    const skippedLeadIds: string[] = [];
    const failureBreakdown = {
      searchWebFailed: 0,
      linkedinFailed: 0,
      llmOrParseFailed: 0,
      updateFailed: 0,
    };
    const failureRecords: Array<{ leadId: string; email?: string; step: string; message: string }> = [];
    // Tracks field names that received at least one non-null value across all
    // parallel workers. Written to list.fieldNames in a single post-job call
    // instead of per-lead to avoid read-modify-write races under parallel writes.
    const populatedFieldNames = new Set<string>();

    emitProgress('Starting enrichment...', 0, 0, 0);

    const enrichedAt = new Date().toISOString();
    const chunkProcessors = chunks.map(async (chunk) => {
      for (const lead of chunk) {
        if (lead?.leadId) attemptedLeadIds.push(lead.leadId);
        try {
          const { fields, metadata: citations, normalized } = await this.enrichLead(lead, spec, linkedInAccountId, enrichConfig);
          const { standardUpdates, customUpdates } = CrmEnrichmentService.splitFields(fields);
          const fieldMeta = CrmEnrichmentService.buildEnrichmentMetadata(fields, citations, normalized, spec, jobId, enrichedAt);

          // Snapshot previous values before overwriting
          const previousStandardFields = CrmEnrichmentService.pickMappedStandardFields(lead, standardUpdates);
          const previousCustomFields = CrmEnrichmentService.pickCustomFieldValues(lead.customFields, customUpdates);
          // Use original field names (not mapped camelCase) for standard fields so they
          // match the keys used in fieldMeta and lead.enrichmentMetadata (stored under
          // original names like 'first_name', not mapped names like 'firstName').
          const standardOriginalKeys: string[] = [];
          for (const key of Object.keys(fields)) {
            const mapped = CrmEnrichmentService.STANDARD_FIELD_MAP[key.toLowerCase()];
            if (mapped && standardUpdates[mapped] !== undefined) standardOriginalKeys.push(key);
          }
          const allUpdatedFields = [...standardOriginalKeys, ...Object.keys(customUpdates)];
          const previousEnrichmentMetadata: Record<string, any> = {};
          const fieldsEnriched: Array<{ field: string; provider: string; fromCache: boolean }> = [];
          for (const field of allUpdatedFields) {
            previousEnrichmentMetadata[field] = lead.enrichmentMetadata?.[field] ?? null;
            const meta = fieldMeta[field];
            if (meta) {
              fieldsEnriched.push({
                field,
                provider: meta.provider ?? meta.source ?? 'unknown',
                fromCache: meta.fromCache ?? false,
              });
            }
          }
          try {
            await crmDb.createEnrichmentSnapshotItem({
              jobId, leadId: lead.leadId,
              previousStandardFields, previousCustomFields, previousEnrichmentMetadata,
              fieldsEnriched,
              expiresAt: jobExpiresAt,
            });
          } catch (err: any) {
            console.error('[CrmEnrichment] Failed to write snapshot:', err);
          }

          // Split customUpdates: non-empty → SET per key, null/empty → REMOVE per key.
          // Both cleared-field metadata entries and the field values themselves are
          // removed atomically — prevents stale "—" badge in UI for cleared fields.
          const customSet: Record<string, string> = {};
          const clearKeys: string[] = [];
          for (const [k, v] of Object.entries(customUpdates)) {
            if (v === null || v === undefined || v === '') clearKeys.push(k);
            else customSet[k] = v as string;
          }

          // Normalize known top-level fields before writing.
          const topLevel: Record<string, string> = {};
          for (const [k, v] of Object.entries(standardUpdates)) {
            if (v !== null && v !== undefined && v !== '') topLevel[k] = String(v);
          }
          if (topLevel.email) topLevel.email = topLevel.email.trim().toLowerCase();
          if (topLevel.linkedin) topLevel.linkedin = topLevel.linkedin.trim();

          // Track which fields got real values for the consolidated fieldNames write
          for (const [k, v] of Object.entries(fields)) {
            if (v !== null && v !== undefined && v !== '') populatedFieldNames.add(k);
          }

          await crmDb.setLeadFields(spec.listId, lead.leadId, {
            topLevel,
            enrichmentMetadata: fieldMeta,
            customFields: customSet,
            removeEnrichmentMetadataKeys: clearKeys,
            removeCustomFieldKeys: clearKeys,
          });

          counters.processed++;
        } catch (error: any) {
          const step = error?.step || 'unknown';
          if (step === 'skipped_personal') {
            counters.skipped++;
            if (lead?.leadId) skippedLeadIds.push(lead.leadId);
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
            // Capture per-lead failure for the history dialog (item #11). Cap at 50 stored.
            if (failureRecords.length < 50) {
              failureRecords.push({
                leadId: lead?.leadId,
                email: lead?.email,
                step,
                message: String(error?.message || error).slice(0, 300),
              });
            }
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

    // Persist enrichment job metadata for history/revert (item #11 — failures included)
    if (counters.processed > 0 || counters.failed > 0) {
      Promise.resolve(crmDb.createEnrichmentJobMeta({
        jobId,
        listId: spec.listId,
        userId: spec.userId,
        outputFields: spec.outputFields,
        createdAt: new Date().toISOString(),
        status: 'completed',
        expiresAt: jobExpiresAt,
        processedCount: counters.processed,
        failedCount: counters.failed,
        skippedCount: counters.skipped,
        ...(attemptedLeadIds.length <= 5000
          ? { attemptedLeadIds }
          : { leadsDeduplicationUnavailable: true }),
        ...(skippedLeadIds.length > 0 && skippedLeadIds.length <= 5000
          ? { skippedLeadIds }
          : skippedLeadIds.length > 5000
          ? { skippedDeduplicationUnavailable: true }
          : {}),
        failureBreakdown,
        failures: failureRecords,
      })).catch((err: any) => console.error('[CrmEnrichment] Failed to write job meta:', err));
    }

    // Single consolidated fieldNames write after all workers finish — avoids
    // per-lead read-modify-write race where parallel workers clobber each other.
    try {
      await crmDb.mergeFieldNames(spec.listId, populatedFieldNames);
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
    },
    userId?: string
  ): Promise<{
    instruction: string;
    outputFields: string[];
    /** Deprecated. Cluster service now produces per-cluster search templates;
     *  this remains in the response shape only as a legacy fallback (always ''). */
    webSearchTemplate: string;
    linkedinSearchTemplate: string;
    sourcesPerField: Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>;
    sources: ('web_search' | 'linkedin' | 'existing_data')[];
    fieldDescriptions: Record<string, string>;
  }> {
    const { enrichmentModel } = await CrmEnrichmentService.getEnrichmentConfig();

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

    const systemPrompt = buildSuggestEnrichmentSystemPrompt();

    const userPrompt = `${existingFieldsSection}Enrichment goal or instruction:\n${goal}`;

    const llmClient = await agentModeService.getClientForModel(enrichmentModel);

    const fallback = {
      instruction: goal,
      outputFields: [] as string[],
      webSearchTemplate: '' as string,
      linkedinSearchTemplate: '' as string,
      sourcesPerField: {} as Record<string, ('web_search' | 'linkedin' | 'existing_data')[]>,
      sources: ['web_search'] as ('web_search' | 'linkedin' | 'existing_data')[],
      fieldDescriptions: {} as Record<string, string>,
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
      meterUsageFromResponse({
        userId,
        model: enrichmentModel,
        provider: enrichmentModel.startsWith('anthropic') || enrichmentModel.startsWith('claude') ? 'bedrock' : 'azure',
        feature: 'crm_enrichment_suggest',
      }, completion);
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
        meterUsageFromResponse({
          userId,
          model: enrichmentModel,
          provider: enrichmentModel.startsWith('anthropic') || enrichmentModel.startsWith('claude') ? 'bedrock' : 'azure',
          feature: 'crm_enrichment_suggest',
        }, retry);
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

    // Legacy: kept in the response for backward compat but no longer authored
    // by the LLM. New ungrouped fields use fieldDescriptions + cluster service.
    const webSearchTemplate: string =
      typeof parsed.webSearchTemplate === 'string' && parsed.webSearchTemplate.trim()
        ? parsed.webSearchTemplate.trim()
        : '';

    const linkedinSearchTemplate: string =
      typeof parsed.linkedinSearchTemplate === 'string' && parsed.linkedinSearchTemplate.trim()
        ? parsed.linkedinSearchTemplate.trim()
        : '';

    // Per-field 1-line descriptions for ungrouped/niche fields. Trimmed,
    // non-empty, capped at 300 chars to match validateFieldDescriptions.
    const fieldDescriptions: Record<string, string> =
      parsed.fieldDescriptions && typeof parsed.fieldDescriptions === 'object' && !Array.isArray(parsed.fieldDescriptions)
        ? Object.fromEntries(
            Object.entries(parsed.fieldDescriptions)
              .filter(([k, v]) => typeof k === 'string' && typeof v === 'string' && (v as string).trim().length > 0)
              .map(([k, v]) => [k, (v as string).trim().slice(0, 300)])
          )
        : {};

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
      fieldDescriptions,
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
          Object.keys(result.fieldDescriptions).length > 0 ? result.fieldDescriptions : undefined,
        );
      } catch (err) {
        console.warn('[CrmEnrichment] suggestEnrichment: failed to save config to list:', err);
      }
    }

    return result;
  }

  async revertJob(jobId: string, listId: string): Promise<{ revertedCount: number; failedCount: number }> {
    const snapshots = await crmDb.getEnrichmentSnapshotsByJobId(jobId);

    if (snapshots.length === 0) {
      throw new Error(`No snapshot data found for job ${jobId}. It may have already been reverted or expired.`);
    }

    const parallelism = 20;
    const chunkSize = Math.max(1, Math.ceil(snapshots.length / parallelism));
    const chunks: any[][] = [];
    for (let i = 0; i < snapshots.length; i += chunkSize) {
      chunks.push(snapshots.slice(i, i + chunkSize));
    }

    let revertedCount = 0;
    let failedCount = 0;

    await Promise.all(chunks.map(async (chunk) => {
      for (const snapshot of chunk) {
        try {
          const currentLead = await crmDb.getLeadById(listId, snapshot.leadId);
          if (!currentLead) {
            failedCount++;
            continue;
          }

          // Merge: start from current state, overwrite only snapshotted fields
          const restoredCustomFields: Record<string, any> = { ...(currentLead.customFields || {}) };
          for (const [key, prevValue] of Object.entries(snapshot.previousCustomFields || {})) {
            if (prevValue === null || prevValue === undefined) {
              delete restoredCustomFields[key];
            } else {
              restoredCustomFields[key] = prevValue;
            }
          }

          const restoredEnrichmentMetadata: Record<string, any> = { ...(currentLead.enrichmentMetadata || {}) };
          for (const [key, prevMeta] of Object.entries(snapshot.previousEnrichmentMetadata || {})) {
            if (prevMeta === null || prevMeta === undefined) {
              delete restoredEnrichmentMetadata[key];
            } else {
              restoredEnrichmentMetadata[key] = prevMeta;
            }
          }

          await crmDb.updateLead(listId, snapshot.leadId, {
            ...(snapshot.previousStandardFields || {}),
            customFields: restoredCustomFields,
            enrichmentMetadata: restoredEnrichmentMetadata,
          });

          revertedCount++;
        } catch (err: any) {
          failedCount++;
          console.error(`[CrmEnrichment] Revert failed for lead ${snapshot.leadId}:`, err);
        }
      }
    }));

    await crmDb.updateEnrichmentJobStatus(jobId, 'undone');

    return { revertedCount, failedCount };
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
