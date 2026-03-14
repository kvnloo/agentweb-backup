import { crmDb } from './db';
import { agentModeService } from './agentModeService';
import { v4 as uuidv4 } from 'uuid';

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
  private async loadAndFilterLeads(spec: EnrichmentJobSpec): Promise<{ allLeads: any[]; leadsToProcess: any[]; alreadyEnriched: number }> {
    const list = await crmDb.getLeadListById(spec.listId);
    if (!list) {
      throw new Error('Lead list not found');
    }

    // Load all leads with pagination
    const allLeads: any[] = [];
    let lastKey: any = undefined;
    do {
      const result = await crmDb.getLeadsByListId(spec.listId, undefined, lastKey);
      allLeads.push(...(result.items || []));
      lastKey = result.lastEvaluatedKey;
    } while (lastKey);

    // Apply filters
    let filtered = allLeads;
    if (spec.filters && spec.filters.length > 0) {
      filtered = allLeads.filter(lead => {
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

    // Determine already-enriched leads (have ALL output fields populated)
    const hasAllFields = (lead: any) =>
      spec.outputFields.every(field => {
        const value = lead?.customFields?.[field];
        return typeof value === 'string' && value.trim().length > 0;
      });

    const alreadyEnriched = filtered.filter(hasAllFields).length;
    const leadsToProcess = spec.forceOverwrite
      ? filtered
      : filtered.filter(lead => !hasAllFields(lead));

    return { allLeads, leadsToProcess, alreadyEnriched };
  }

  private async resolveLinkedInAccountId(userId: string): Promise<string | null> {
    const { getAccountsByUserId } = await import('./connectedAccountsDb');
    const accounts = await getAccountsByUserId(userId);
    const unipileAccount = accounts.find((a: any) => a.platform === 'unipile');
    return unipileAccount?.account_id || null;
  }

  private static readonly ENRICH_MODEL = 'gemini-3.1-flash-lite-preview';

  private async enrichLead(
    lead: any,
    spec: EnrichmentJobSpec,
    linkedInAccountId?: string | null,
  ): Promise<{ fields: Record<string, string> }> {
    let webContext = '';
    let linkedinContext = '';

    // 1. Web search source
    if (spec.sources.includes('web_search')) {
      const companyName = String(lead.company || '').trim();
      if (companyName) {
        const webResult = await agentModeService.searchWeb(`${companyName} company overview`, 5);
        if (webResult?.success && Array.isArray(webResult.results) && webResult.results.length > 0) {
          webContext = `\nWeb search results for "${companyName}":\n${JSON.stringify(webResult.results, null, 2)}`;
        } else if (!webResult?.success) {
          const msg = webResult?.error || webResult?.message || '';
          if (!msg.toLowerCase().includes('no search results found')) {
            throw Object.assign(new Error(`Web search failed: ${msg}`), { step: 'search' });
          }
        }
      }
    }

    // 2. LinkedIn source
    if (spec.sources.includes('linkedin') && linkedInAccountId) {
      try {
        const linkedinUrl = lead.linkedin ? String(lead.linkedin).trim() : '';
        let profileData: any = null;

        if (linkedinUrl) {
          // Direct profile lookup
          const result = await agentModeService.linkedinOutreach(spec.userId, {
            action: 'get-profile',
            account_id: linkedInAccountId,
            profile_url: linkedinUrl,
          });
          if (result?.success) profileData = result.data;
        } else {
          // Search by name + company
          const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
          const company = String(lead.company || '').trim();
          if (name && company) {
            const searchResult = await agentModeService.linkedinOutreach(spec.userId, {
              action: 'search-people',
              account_id: linkedInAccountId,
              keywords: `${name} ${company}`,
            });
            const topResult = searchResult?.data?.items?.[0];
            if (topResult?.provider_id) {
              const profileResult = await agentModeService.linkedinOutreach(spec.userId, {
                action: 'get-profile',
                account_id: linkedInAccountId,
                provider_id: topResult.provider_id,
              });
              if (profileResult?.success) profileData = profileResult.data;
            }
          }
        }

        if (profileData) {
          linkedinContext = `\nLinkedIn profile data:\n${JSON.stringify(profileData, null, 2)}`;
        }
      } catch (err: any) {
        throw Object.assign(new Error(`LinkedIn lookup failed: ${err.message}`), { step: 'linkedin' });
      }
    }

    // 3. Build lead context
    const leadContext: Record<string, string> = {};
    const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
    if (name) leadContext.name = name;
    if (lead.email) leadContext.email = String(lead.email).trim();
    if (lead.title) leadContext.title = String(lead.title).trim();
    if (lead.company) leadContext.company = String(lead.company).trim();
    if (lead.linkedin) leadContext.linkedin = String(lead.linkedin).trim();
    // Include existing custom fields for context
    if (lead.customFields && Object.keys(lead.customFields).length > 0) {
      leadContext.existingCustomFields = JSON.stringify(lead.customFields);
    }

    // 4. Build prompt and call LLM
    const systemPrompt = `You are a data enrichment analyst.

Your task: ${spec.instruction}

Return ONLY a JSON object with these exact keys: ${JSON.stringify(spec.outputFields)}
Each value should be a string.

JSON formatting rules (mandatory):
- Output must be valid JSON parsable by JSON.parse
- Use double quotes for keys and string values
- Do not wrap output in markdown or code fences
- Do not include any text before or after the JSON object

If you cannot determine a field's value from the provided data, use "Unknown" as the value.`;

    const userPrompt = `Lead context:
${JSON.stringify(leadContext, null, 2)}
${webContext ? `\nWeb search results:${webContext}` : ''}${linkedinContext ? `\nLinkedIn data:${linkedinContext}` : ''}

Extract the requested fields now.`;

    // Call Gemini via the shared OpenAI-compatible client
    const geminiClient = await agentModeService.getGeminiClient();
    let response: Record<string, string> | null = null;
    try {
      const completion = await geminiClient.chat.completions.create({
        model: CrmEnrichmentService.ENRICH_MODEL,
        temperature: 1,
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
        temperature: 1,
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

    return { fields };
  }

  async preview(spec: EnrichmentJobSpec): Promise<EnrichmentPreviewResult> {
    const { allLeads, leadsToProcess, alreadyEnriched } = await this.loadAndFilterLeads(spec);

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
      totalLeads: allLeads.length,
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

    const { leadsToProcess } = await this.loadAndFilterLeads(spec);

    if (leadsToProcess.length === 0) {
      return {
        jobId,
        processedCount: 0,
        failedCount: 0,
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

          await crmDb.updateLead(spec.listId, lead.leadId, {
            customFields: {
              ...(lead.customFields || {}),
              ...fields,
            },
          });

          totalProcessedCount++;
        } catch (error: any) {
          const step = error?.step || 'unknown';
          if (step === 'search') {
            failureBreakdown.searchWebFailed++;
          } else if (step === 'linkedin') {
            failureBreakdown.linkedinFailed++;
          } else if (step === 'llm') {
            failureBreakdown.llmOrParseFailed++;
          } else {
            // Check if it's an update error or llm error
            failureBreakdown.llmOrParseFailed++;
          }
          totalFailedCount++;
          console.error(`[CrmEnrichment] Failed to enrich lead ${lead?.leadId}:`, error);
        }

        const completed = totalProcessedCount + totalFailedCount;
        const progress = Math.min((completed / leadsToProcess.length) * 100, 100);
        emitProgress(
          `Enriching ${completed}/${leadsToProcess.length} (${totalProcessedCount} enriched, ${totalFailedCount} failed)`,
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

    // Emit completion event
    const completionPayload = {
      jobId,
      listId: spec.listId,
      processedCount: totalProcessedCount,
      failedCount: totalFailedCount,
      outputFields: spec.outputFields,
      failureBreakdown,
    };
    if (emit) {
      if (socketId) {
        emit(socketId, completeEvent, completionPayload);
      }
      emit(userRoom, completeEvent, completionPayload);
    }

    return {
      jobId,
      processedCount: totalProcessedCount,
      failedCount: totalFailedCount,
      totalToProcess: leadsToProcess.length,
      outputFields: spec.outputFields,
      failureBreakdown,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
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
