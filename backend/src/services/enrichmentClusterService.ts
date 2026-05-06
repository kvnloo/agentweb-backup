/**
 * Ungrouped-field clustering service.
 *
 * For fields that don't map to any canonical FIELD_GROUP (after alias
 * resolution), we used to fall back to a single user-editable
 * `webSearchTemplate` covering all of them. That had two problems:
 *   - The textbox in the UI was a foot-gun: users edited it expecting their
 *     change to take effect, but for grouped fields it was silently ignored.
 *   - One generic query for all ungrouped fields produced compromise results.
 *
 * Replacement: at suggest/execute time, the LLM clusters ungrouped fields by
 * what data source / search would find them, and produces ONE search template
 * per cluster. Each cluster then behaves like an ad-hoc canonical group.
 *
 * Clusters are persisted on `list.ungroupedClusters` so we only pay the LLM
 * cost once per list per novel set of fields.
 */

import { crmDb } from './db';
import { agentModeService } from './agentModeService';
import { buildClusterFieldsSystemPrompt, buildClusterFieldsUserPrompt } from './enrichmentPrompts';

export interface FieldCluster {
  /** User-facing field names this cluster covers. */
  fields: string[];
  /** Search template with {{placeholder}} tokens (same syntax as FIELD_GROUPS.searchTemplate). */
  searchTemplate: string;
  /** Optional LLM rationale, kept for audit/debug. */
  rationale?: string;
}

export interface FieldDescriptor {
  name: string;
  description?: string;
}

/**
 * For an LLM-generated cluster to be safe to use, both:
 *   - fields must be a non-empty array of strings, and
 *   - searchTemplate must be a non-empty string.
 */
function isValidCluster(c: any): c is FieldCluster {
  return (
    !!c &&
    Array.isArray(c.fields) &&
    c.fields.length > 0 &&
    c.fields.every((f: any) => typeof f === 'string' && f.length > 0) &&
    typeof c.searchTemplate === 'string' &&
    c.searchTemplate.trim().length > 0
  );
}

async function llmClusterFields(
  fields: FieldDescriptor[],
  exampleLead?: { company?: string; emailDomain?: string }
): Promise<FieldCluster[]> {
  if (fields.length === 0) return [];

  try {
    const { CrmEnrichmentService } = await import('./crmEnrichmentService');
    const { enrichmentModel } = await CrmEnrichmentService.getEnrichmentConfig();
    const llm = await agentModeService.getClientForModel(enrichmentModel);

    const completion = await llm.chat.completions.create({
      model: enrichmentModel,
      temperature: 0.1,
      messages: [
        { role: 'system', content: buildClusterFieldsSystemPrompt() },
        { role: 'user', content: buildClusterFieldsUserPrompt(fields, exampleLead) },
      ],
      response_format: { type: 'json_object' },
    });
    const raw = completion.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(raw);
    const candidates = Array.isArray(parsed) ? parsed : (parsed?.clusters || []);
    if (!Array.isArray(candidates)) return [];
    return candidates.filter(isValidCluster);
  } catch (err: any) {
    console.warn(`[enrichmentCluster] LLM clustering failed: ${err?.message}`);
    return [];
  }
}

/**
 * Returns clusters covering the given ungrouped fields. Reads existing clusters
 * from the list, generates new ones for any uncovered fields, and persists.
 *
 * If the LLM call fails, returns a single fallback cluster covering all
 * passed fields with a generic search template — keeps the pipeline working.
 */
export interface GetOrCreateResult {
  clusters: FieldCluster[];
  newlyCreated: FieldCluster[];
}

export async function getOrCreateClustersForFields(
  listId: string,
  ungroupedFields: string[],
  fieldDescriptions: Record<string, string> = {},
  exampleLead?: { company?: string; emailDomain?: string }
): Promise<GetOrCreateResult> {
  if (ungroupedFields.length === 0) {
    return { clusters: [], newlyCreated: [] };
  }

  const list = await crmDb.getLeadListById(listId).catch(() => null);
  const persisted = ((list as any)?.ungroupedClusters as FieldCluster[]) || [];

  // Find which input fields are already covered by a persisted cluster
  const coveredSet = new Set<string>();
  const relevantClusters: FieldCluster[] = [];
  for (const cluster of persisted) {
    const covers = cluster.fields.filter(f => ungroupedFields.includes(f));
    if (covers.length > 0) {
      relevantClusters.push(cluster);
      for (const f of covers) coveredSet.add(f);
    }
  }

  const uncovered = ungroupedFields.filter(f => !coveredSet.has(f));

  if (uncovered.length === 0) {
    return { clusters: relevantClusters, newlyCreated: [] };
  }

  // LLM-cluster the uncovered fields
  const descriptors: FieldDescriptor[] = uncovered.map(f => ({
    name: f,
    description: fieldDescriptions[f],
  }));
  const newClusters = await llmClusterFields(descriptors, exampleLead);

  // If the LLM call failed entirely, fall back to one cluster per uncovered
  // field with a generic per-field query. Worse than a tuned cluster but
  // keeps the pipeline live.
  let effectiveNew: FieldCluster[];
  if (newClusters.length === 0) {
    effectiveNew = [{
      fields: uncovered,
      searchTemplate: '{{emailDomain}} ' + uncovered.join(' ').replace(/_/g, ' '),
      rationale: 'fallback: LLM clustering unavailable',
    }];
  } else {
    // Validate that LLM didn't drop fields. Any uncovered field still missing
    // gets a fallback single-field cluster so it's not silently lost.
    const newCovered = new Set(newClusters.flatMap(c => c.fields));
    const stillMissing = uncovered.filter(f => !newCovered.has(f));
    effectiveNew = newClusters.slice();
    if (stillMissing.length > 0) {
      effectiveNew.push({
        fields: stillMissing,
        searchTemplate: '{{emailDomain}} ' + stillMissing.join(' ').replace(/_/g, ' '),
        rationale: 'fallback: not covered by LLM clusters',
      });
    }
  }

  // Persist (best-effort, non-blocking on failure)
  try {
    await crmDb.updateLeadList(listId, {
      ungroupedClusters: [...persisted, ...effectiveNew],
    });
  } catch (err: any) {
    console.warn(`[enrichmentCluster] Failed to persist clusters: ${err?.message}`);
  }

  return {
    clusters: [...relevantClusters, ...effectiveNew],
    newlyCreated: effectiveNew,
  };
}
