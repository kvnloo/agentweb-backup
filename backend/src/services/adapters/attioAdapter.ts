import { CrmAdapter, CrmAuth } from './crmAdapterTypes';
import { ExternalCrmSyncConfig, FieldMapping, SyncResult } from '../externalCrmSyncService';
import { AttioService } from '../attioService';
import { crmDb } from '../db';
import { buildSyncedMetadataBase, buildFailedMetadata } from '../../utils/leadSyncStatus';
import { validateEmail } from '../../utils/validation';
import { mergeCustomFields } from '../../utils/customFieldsGuard';

/**
 * System list-identity mapping, mirroring HUBSPOT_LIST_IDENTITY_MAPPING
 * (hubspotAdapter.ts) exactly. Push-only (the values are owned by Emma).
 * pushLeads injects these at push time when a stored config doesn't already
 * carry them, so lists connected before this feature shipped sync the fields
 * without a manual re-save. An explicit config entry (re-mapped or disabled
 * in the dialog) always wins.
 */
export const ATTIO_LIST_IDENTITY_MAPPING: FieldMapping[] = [
    { agentwebField: 'listName', crmProperty: 'lead_list_name', direction: 'push', enabled: true },
    { agentwebField: 'listId', crmProperty: 'lead_list_id', direction: 'push', enabled: true },
];

/**
 * Attio CRM Adapter
 *
 * Thin orchestration + field-mapping layer on top of AttioService.
 * All Attio API calls go through AttioService — no raw axios here.
 *
 * Responsibilities:
 *  - Resolve auth → scoped AttioService instance (getSvc)
 *  - Map lead fields to Attio People values (buildPersonValues)
 *  - Orchestrate push/pull flow (list management, entry sync)
 *
 * getSvc() uses the static factories — one DB read for OAuth, zero for token.
 * The resolved token is cached on the instance for the lifetime of the operation.
 */
/**
 * Attio rejects phone numbers without a country (e.g. a bare US "2532344511"
 * from a landing-page form). Normalize to E.164 where the shape is
 * unambiguous, otherwise pass a US country hint.
 */
export function toAttioPhone(raw: string): { original_phone_number: string; country_code?: string } {
    const s = String(raw).trim();
    if (s.startsWith('+')) return { original_phone_number: s };
    // Never fold extension digits into the number ("253-2345 ext 678").
    if (/(?:ext\.?|extension|x|#)\s*\d+\s*$/i.test(s)) return { original_phone_number: s, country_code: 'US' };
    const digits = s.replace(/\D/g, '');
    if (digits.length === 10) return { original_phone_number: `+1${digits}` };
    if (digits.length === 11 && digits.startsWith('1')) return { original_phone_number: `+${digits}` };
    return { original_phone_number: s, country_code: 'US' };
}

export class AttioAdapter implements CrmAdapter {

    /** agentwebFields that carry only source-list identity, not lead content. */
    private static readonly LIST_IDENTITY_FIELDS = new Set(
        ATTIO_LIST_IDENTITY_MAPPING.map(m => m.agentwebField)
    );

    /**
     * Returns the custom mapping with the system list-identity mappings
     * (listName/listId) appended for any agentwebField the config doesn't already
     * define. An existing entry — whether the user re-mapped its Attio attribute
     * or disabled it — is left untouched so explicit configuration always wins.
     * Lets lists connected before this feature shipped sync listName/listId
     * without a manual re-save. Mirrors hubspotAdapter.ts's identical method.
     */
    private withListIdentityMappings(customMapping: FieldMapping[]): FieldMapping[] {
        const present = new Set(customMapping.map(m => m.agentwebField));
        const missing = ATTIO_LIST_IDENTITY_MAPPING.filter(m => !present.has(m.agentwebField));
        return missing.length > 0 ? [...customMapping, ...missing] : customMapping;
    }

    // ─── Auth ──────────────────────────────────────────────────────────────────

    /**
     * Returns an AttioService scoped to the given auth context.
     * OAuth → AttioService.create() — one DB read, token cached on instance.
     * Raw token → AttioService.fromToken() — zero DB reads.
     */
    private async getSvc(auth: CrmAuth): Promise<AttioService> {
        if (auth.type === 'oauth') return AttioService.create(auth.userId, auth.accountId);
        return AttioService.fromToken(auth.apiKey);
    }

    // ─── testConnection ─────────────────────────────────────────────────────────

    async testConnection(auth: CrmAuth): Promise<{ valid: boolean; error?: string }> {
        const svc = await this.getSvc(auth);
        return svc.testConnection();
    }

    // ─── pushLeads ──────────────────────────────────────────────────────────────

    async pushLeads(
        auth: CrmAuth,
        leads: any[],
        config: ExternalCrmSyncConfig
    ): Promise<SyncResult> {
        const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };
        const svc = await this.getSvc(auth);

        // Resolve the source list's display name once so leads can be enriched
        // with listName/listId before mapping. Mirrors hubspotAdapter.ts's
        // identical resolution — falls back to config.listName, then undefined,
        // so a failed/absent lookup never aborts the push.
        let resolvedListName = config.listName;
        try {
            const list = await crmDb.getLeadListById(config.listId);
            if ((list as any)?.name) resolvedListName = (list as any).name;
        } catch (err: any) {
            console.warn(`[AttioAdapter] failed to resolve list name for ${config.listId}: ${err?.message}`);
        }

        // Ensure the system list-identity mappings (listName/listId) are present.
        // Configs created before this feature shipped don't carry them in their
        // stored customFieldMapping, so inject them here unless the config
        // already has an explicit entry for that agentwebField.
        const effectiveCustomMapping = this.withListIdentityMappings(config.customFieldMapping);

        // Load person-level attribute types first.
        // ── 1. Load person-level attribute types ─────────────────────────────────
        const attrCache = await svc.loadAttributeTypes('people');

        const customPersonMappings = effectiveCustomMapping.filter(
            m => m.enabled && m.direction !== 'pull'
        );
        // Attio attribute slugs (post-ensure) that carry only list identity — used
        // to decide whether a lead has any real content worth syncing (see the
        // hasRealProps guard below). Populated once the ensure loop below resolves
        // each mapping's final slug.
        const listIdentitySlugs = new Set<string>();
        const ensuredSlugs = new Set<string>();
        const resolvedSlugs = new Map<string, string>();
        for (const m of customPersonMappings) {
            const rawSlug = m.crmProperty;
            const cleanSlug = rawSlug.toLowerCase().replace(/[^a-z0-9_]/g, '_');

            let type = 'text';
            if (rawSlug.includes('value') || rawSlug.includes('amount')) type = 'number';

            await svc.ensurePersonAttribute(rawSlug, cleanSlug.replace(/_/g, ' '), type)
                .then(finalSlug => {
                    resolvedSlugs.set(rawSlug, finalSlug);
                    ensuredSlugs.add(finalSlug);
                    if (!attrCache.has(`object:people:${finalSlug}`)) {
                        attrCache.set(`object:people:${finalSlug}`, type);
                    }
                    if (AttioAdapter.LIST_IDENTITY_FIELDS.has(m.agentwebField)) {
                        listIdentitySlugs.add(finalSlug);
                    }
                })
                .catch((e: any) => {
                    const errDetails = e.response?.data?.message || e.message || 'Unknown error';
                    console.error(`[AttioAdapter] Failed to ensure person attribute "${rawSlug}":`, errDetails);
                });
        }
        console.log(`[AttioAdapter] Ensured person-level slugs:`, Array.from(ensuredSlugs));

        // ── 2. Resolve the deal list (Attio's Deal/Opportunity analog) ───────────
        // Attio has no native Deal object. AgentWeb represents "a deal" as an entry
        // in a dedicated Attio List, with deal-shaped fields (value, stage, etc.)
        // stored as per-entry attributes and linked to the synced Person record.
        // Resolved once per push run, not per lead. A failure here is non-critical
        // — it degrades to person-only sync for the rest of the run rather than
        // failing every lead, since list/attribute setup is best-effort.
        const dealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'pull');
        let dealListId: string | undefined;
        const dealSlugs = new Map<string, string>();  // mapped crmProperty -> resolved Attio list-attribute slug
        const dealTypes = new Map<string, string>();  // resolved slug -> Attio attribute type
        if (dealMappings.length > 0) {
            try {
                dealListId = config.attioDealListId;
                if (!dealListId) {
                    dealListId = await svc.findOrCreateList(config.listName || 'AgentWeb Deals', 'people');
                    config.attioDealListId = dealListId;
                }
                for (const m of dealMappings) {
                    const rawSlug = m.crmProperty;
                    const type = (rawSlug.includes('value') || rawSlug.includes('amount')) ? 'number' : 'text';
                    try {
                        const finalSlug = await svc.ensureListAttribute(dealListId, rawSlug, rawSlug.replace(/_/g, ' '), type);
                        dealSlugs.set(rawSlug, finalSlug);
                        dealTypes.set(finalSlug, type);
                    } catch (e: any) {
                        console.error(`[AttioAdapter] Failed to ensure deal-list attribute "${rawSlug}":`, e.response?.data?.message || e.message);
                    }
                }
            } catch (e: any) {
                console.error('[AttioAdapter] Failed to resolve deal list — degrading to person-only sync:', e.response?.data?.message || e.message);
                dealListId = undefined;
            }
        }

        // ── 4. Sync each lead ───────────────────────────────────────────────────
        for (const lead of leads) {
            try {
                // Guard against non-email values (e.g. a social/profile URL landing
                // in the email field). An invalid email used to fall through to the
                // update/create-by-id branches silently — the record still synced,
                // but with no email at all, and the lead was reported a clean
                // success. Surface it as a per-lead error instead, mirroring
                // hubspotAdapter.ts's identical guard. An empty email is allowed —
                // those push via create/update-by-id below, unaffected.
                const trimmedEmail = typeof lead.email === 'string' ? lead.email.trim() : '';
                if (trimmedEmail && !validateEmail(trimmedEmail)) {
                    result.errorCount++;
                    const msg = `Invalid email "${trimmedEmail}" — skipped (not a valid email address)`;
                    console.warn(`[AttioAdapter] Invalid email for lead=${lead.leadId} — skipped (not a valid email address)`);
                    result.errors.push(`${trimmedEmail}: ${msg}`);
                    await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                        syncMetadata: buildFailedMetadata(lead.syncMetadata, msg),
                    }).catch((updateErr: any) => { });
                    continue;
                }

                // Enrich with the source lead-list identity so listName/listId
                // mappings resolve. listId is already on the lead; listName is not,
                // so we graft the resolved name on (without persisting it back).
                // Mirrors hubspotAdapter.ts's identical enrichment.
                const enrichedLead = {
                    ...lead,
                    listId: lead.listId ?? config.listId,
                    listName: lead.listName ?? resolvedListName,
                };

                // Determine if we need to resolve a company relationship
                let companyId: string | undefined;
                const companyMapping = config.contactFieldMapping.find(m => m.enabled && m.direction !== 'pull' && m.crmProperty === 'company');
                const companyName = companyMapping ? this.getNestedValue(enrichedLead, companyMapping.agentwebField) : undefined;

                if (companyName) {
                    const existingCompany = await svc.findCompanyByName(companyName);
                    if (existingCompany) {
                        companyId = existingCompany.recordId;
                    } else {
                        const newCompany = await svc.createCompany(companyName);
                        companyId = newCompany.recordId;
                    }
                }

                // Build person values including custom mapped person attributes.
                const personValues = this.buildPersonValues(enrichedLead, config.contactFieldMapping, attrCache, companyId);
                for (const m of customPersonMappings) {
                    const value = this.getNestedValue(enrichedLead, m.agentwebField) ?? enrichedLead.customFields?.[m.agentwebField];
                    if (value != null && String(value).trim() !== '') {
                        const finalSlug = resolvedSlugs.get(m.crmProperty);
                        if (!finalSlug) continue;
                        let finalValue = value;
                        const type = attrCache.get(`object:people:${finalSlug}`) || 'text';
                        if (type === 'status') {
                            try {
                                finalValue = await svc.ensureStatusOption('people', finalSlug, String(value));
                            } catch (err: any) {
                                console.error(`[AttioAdapter] failed to ensure person status option '${value}' for slug '${finalSlug}':`,
                                    err.response?.data?.message || err.message);
                            }
                        }
                        personValues[finalSlug] = [this.formatAttioValue(finalValue, type)];
                    }
                }

                // Skip leads with no real content. List identity is injected onto
                // every lead, so a lead carrying ONLY list-identity attributes (e.g.
                // an empty email-less lead) has nothing worth syncing — pushing it
                // would create a junk Attio Person tagged with just a list. Mirrors
                // hubspotAdapter.ts's identical hasRealProps guard.
                const hasRealProps = Object.keys(personValues).some(k => !listIdentitySlugs.has(k));
                if (!hasRealProps) continue;

                let personId: string | undefined;
                // Tracks whether this lead was counted as new or updated, so a
                // later deal-entry failure can demote the count it already
                // incremented (mirrors hubspotAdapter.ts's demote() pattern).
                let personWasNew = false;

                // Only treat as email if it looks like a real address (not a placeholder like "unknown").
                // Invalid emails already handled (and skipped) by the guard above,
                // so an email present here is either valid or absent.
                const hasEmail = trimmedEmail && validateEmail(trimmedEmail);

                if (hasEmail) {
                    const { recordId, isNew } = await svc.upsertPersonByValues(personValues);
                    personId = recordId;
                    personWasNew = isNew;
                    if (isNew) result.newCount++; else result.updatedCount++;
                } else if (lead.syncMetadata?.attio_record_id || lead.customFields?.attio_record_id || lead.attioRecordId) {
                    const existingId = lead.syncMetadata?.attio_record_id || lead.customFields?.attio_record_id || lead.attioRecordId;
                    try {
                        if (Object.keys(personValues).length > 0) {
                            await svc.updatePersonByValues(existingId, personValues);
                        }
                        personId = existingId;
                        result.updatedCount++;
                    } catch (updateErr: any) {
                        const status = updateErr.response?.status;
                        if (status === 404) {
                            // Record was deleted from Attio — create a new one
                            personId = await svc.createPersonByValues(personValues);
                            personWasNew = true;
                            result.newCount++;
                            // Clear stale record ID so it gets overwritten below
                            lead.syncMetadata = { ...(lead.syncMetadata || {}), attio_record_id: undefined };
                        } else {
                            throw updateErr;
                        }
                    }
                } else {
                    personId = await svc.createPersonByValues(personValues);
                    personWasNew = true;
                    result.newCount++;
                }

                if (!personId) {
                    result.errorCount++;
                    result.errors.push(`${lead.leadId}: Attio returned no record ID`);
                    continue;
                }

                // Persist attio_record_id if not already stored
                if (!lead.syncMetadata?.attio_record_id) {
                    await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                        syncMetadata: { ...(lead.syncMetadata || {}), attio_record_id: personId },
                    }).catch((err: any) => { });
                    lead.syncMetadata = { ...(lead.syncMetadata || {}), attio_record_id: personId };
                }

                // Deal-list entry sync. A failure here demotes the lead to an
                // error (mirrors hubspotAdapter.ts's demote() pattern) — the
                // Person record synced, but the lead as a whole didn't fully
                // sync, so it must not be counted or reported as success.
                if (dealListId) {
                    try {
                        const entryValues = this.buildDealEntryValues(lead, dealMappings, dealSlugs, dealTypes);
                        let existingEntryId = lead.syncMetadata?.attio_list_entry_id;
                        let entryId: string | undefined = existingEntryId;

                        if (existingEntryId) {
                            try {
                                await svc.updateListEntry(dealListId, existingEntryId, entryValues);
                            } catch (updateErr: any) {
                                // A stamped entry id can go stale after changePipeline
                                // re-points this list's deal list — the entry lives in
                                // the OLD list, not dealListId. Self-heal: treat a 404
                                // as "gone, recreate it" via the same fallback an
                                // entry-less lead already uses, rather than a bulk
                                // migration copier run at re-point time.
                                if (updateErr?.response?.status !== 404) throw updateErr;
                                existingEntryId = undefined;
                                entryId = undefined;
                            }
                        }
                        if (!existingEntryId) {
                            const foundEntryId = await svc.findListEntry(dealListId, personId);
                            if (foundEntryId) {
                                await svc.updateListEntry(dealListId, foundEntryId, entryValues);
                                entryId = foundEntryId;
                            } else {
                                entryId = await svc.addPersonToList(dealListId, personId, entryValues);
                            }
                        }

                        if (entryId && entryId !== existingEntryId) {
                            // Stamp attio_deal_list_id alongside the entry id so a
                            // later delete (deleteLeadFromCrm) targets the list this
                            // entry actually lives in, not whatever attioDealListId
                            // the config happens to point at by then — changePipeline
                            // re-points the config without migrating existing leads'
                            // pointers (self-heals lazily on next push, same as here),
                            // so those can diverge for a lead not yet re-pushed.
                            await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                                syncMetadata: { ...(lead.syncMetadata || {}), attio_list_entry_id: entryId, attio_deal_list_id: dealListId },
                            }).catch((err: any) => { });
                            lead.syncMetadata = { ...(lead.syncMetadata || {}), attio_list_entry_id: entryId, attio_deal_list_id: dealListId };
                        }
                    } catch (e: any) {
                        const msg = e.response?.data?.message || e.message || 'Unknown error';
                        console.error(`[AttioAdapter] Deal-list sync failed for lead ${lead.leadId}:`, msg);
                        result.errorCount++;
                        if (personWasNew) result.newCount--; else result.updatedCount--;
                        result.errors.push(`${lead.email || lead.leadId}: deal sync failed - ${msg}`);
                        await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                            syncMetadata: buildFailedMetadata(lead.syncMetadata, msg),
                        }).catch((updateErr: any) => { });
                        continue;
                    }
                }

                // Stamp the provider-agnostic sync status (Gap 1: without this,
                // the CRM leads page's synced badge/filter never recognizes an
                // Attio-only sync, since it primarily reads syncMetadata.syncStatus).
                await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                    syncMetadata: buildSyncedMetadataBase(lead.syncMetadata, new Date().toISOString()),
                }).catch((err: any) => { });

                result.successCount++;
            } catch (err: any) {
                result.errorCount++;
                const msg = err.response?.data?.message || err.response?.data || err.message || 'Unknown error';
                result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
                await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                    syncMetadata: buildFailedMetadata(lead.syncMetadata, msg),
                }).catch((updateErr: any) => { });
            }
        }

        return result;
    }

    // ─── pullContacts ────────────────────────────────────────────────────────────

    async pullContacts(
        auth: CrmAuth,
        listId: string,
        config: ExternalCrmSyncConfig
    ): Promise<SyncResult> {
        const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [], seenExternalIds: [] };
        const svc = await this.getSvc(auth);

        const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        const attrCache = await svc.loadAttributeTypes('people');

        const pullCustomMappings = config.customFieldMapping.filter(
            m => m.enabled && m.direction !== 'push'
        );
        // Attio-only, pull-only (not wired into the webhook auto-sync — a Company
        // record change never touches the linked Person's own attributes, so
        // there's no reliable real-time trigger; this rides on Pull re-resolving
        // each person's company fresh every run). Attribute types loaded once per
        // run, only when actually configured, to avoid an extra API call for the
        // common case where no company fields are mapped.
        const pullCompanyMappings = (config.companyFieldMapping || []).filter(
            m => m.enabled && m.direction !== 'push'
        );
        const companiesAttrCache = pullCompanyMappings.length > 0
            ? await svc.loadAttributeTypes('companies')
            : new Map<string, string>();
        // Cache one getCompanyValues() call per distinct company for the whole
        // run — otherwise every person sharing the same company re-fetches it,
        // an N+1 pattern this list's own person count doesn't need to pay for.
        const companyValuesCache = new Map<string, Record<string, any>>();
        const pullDealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        const standardEntryFields = ['company'];
        const nativeDealFields = ['status', 'dealValue', 'dealCurrency'];
        // Mirrors hubspotAdapter.ts's pull-side nativeFields allow-list exactly.
        // A contactFieldMapping targeting any other agentwebField must route to
        // customFields — crmDb.batchCreateLeads/createLead/updateLead only write
        // a fixed whitelist of top-level lead columns and silently drop anything
        // else, so writing it to leadData[agentwebField] directly loses the data.
        const nativeFields = ['firstName', 'lastName', 'email', 'phone', 'company', 'title', 'linkedin', 'notes'];

        // Bulk-prefetch the deal list's entries (Attio's Deal analog) once per
        // pull run, keyed by person id — avoids an API call per person, unlike
        // HubSpot's per-contact association lookup, since Attio's List Entries
        // are bulk-queryable. Only reads a list that already exists (pull must
        // not create one — that's push's job); a prefetch failure is
        // non-critical and degrades to contact-only pull for the whole run.
        const dealEntriesByPersonId = new Map<string, { entryId: string; values: Record<string, any> }>();
        let dealAttrCache: Map<string, string> | undefined;
        if (pullDealMappings.length > 0 && config.attioDealListId) {
            try {
                dealAttrCache = await svc.loadAttributeTypes('people', config.attioDealListId);
                // Bounded so an enormous deal list can't retain an unbounded number
                // of entries in memory for one pull run — people beyond this many
                // pages of deal entries simply pull without their deal fields
                // (non-critical, same graceful-degrade convention as a total
                // prefetch failure below).
                const MAX_DEAL_PREFETCH_PAGES = 200;
                let dealOffset: number | undefined = 0;
                let dealPages = 0;
                do {
                    const { entries, nextOffset: nextDealOffset } = await svc.listListEntriesDetailed(config.attioDealListId, dealOffset);
                    for (const entry of entries) {
                        dealEntriesByPersonId.set(entry.personRecordId, { entryId: entry.entryId, values: entry.values });
                    }
                    dealOffset = nextDealOffset;
                    dealPages++;
                    if (dealOffset !== undefined && dealPages >= MAX_DEAL_PREFETCH_PAGES) {
                        console.warn(`[Attio-Pull] Deal-list ${config.attioDealListId} has more than ${MAX_DEAL_PREFETCH_PAGES} pages of entries — stopping prefetch early, some people will pull without deal fields.`);
                        break;
                    }
                } while (dealOffset !== undefined);
            } catch (e: any) {
                console.error('[Attio-Pull] Failed to prefetch deal-list entries (non-critical):', e.response?.data?.message || e.message);
            }
        }

        let offset: number | undefined = 0;

        do {
            const { people, nextOffset } = await svc.listPeople(offset);
            const pageLeadData: any[] = [];

            for (const person of people) {
                const personId = person.recordId;
                result.seenExternalIds!.push(personId);
                const leadData: Record<string, any> = {};
                const customFields: Record<string, any> = {};
                const syncMetadata: Record<string, any> = { attio_record_id: personId };

                try {
                    const personValues = await svc.getPersonValues(personId);

                    for (const m of pullContactMappings) {
                        const slug = m.crmProperty;
                        let val: any;

                        if (slug === 'first_name' || slug === 'last_name') {
                            const nameAttr = personValues['name'];
                            if (Array.isArray(nameAttr) && nameAttr.length > 0) {
                                val = nameAttr[0][slug];
                            }
                        } else if (slug === 'company') {
                            const companyRef = personValues['company']?.[0]?.target_record_id;
                            if (companyRef) {
                                const comp = await svc.getCompanyById(companyRef);
                                val = comp?.name;
                            }
                        } else {
                            const type = attrCache.get(`object:people:${slug}`) || 'text';
                            val = this.extractAttioValue(personValues[slug], type);
                        }

                        if (val != null && val !== '') {
                            if (nativeFields.includes(m.agentwebField)) {
                                leadData[m.agentwebField] = val;
                            } else {
                                customFields[m.agentwebField] = val;
                            }
                        }
                    }

                    for (const m of pullCustomMappings) {
                        const slug = m.crmProperty;
                        const type = attrCache.get(`object:people:${slug}`) || 'text';
                        const val = this.extractAttioValue(personValues[slug], type);
                        if (val != null && val !== '') {
                            customFields[m.agentwebField] = val;
                        }
                    }

                    // Company field mapping — a separate fetch from the company-name
                    // resolution above (getCompanyById), only made when the user has
                    // actually mapped additional Company attributes. One extra API
                    // call per person with a linked company, but only when opted in
                    // (default empty mapping = zero extra calls for existing users).
                    if (pullCompanyMappings.length > 0) {
                        const companyRef = personValues['company']?.[0]?.target_record_id;
                        if (companyRef) {
                            try {
                                let companyValues = companyValuesCache.get(companyRef);
                                if (!companyValues) {
                                    companyValues = await svc.getCompanyValues(companyRef);
                                    companyValuesCache.set(companyRef, companyValues);
                                }
                                for (const m of pullCompanyMappings) {
                                    const slug = m.crmProperty;
                                    const type = companiesAttrCache.get(`object:companies:${slug}`) || 'text';
                                    const val = this.extractAttioValue(companyValues[slug], type);
                                    if (val != null && val !== '') {
                                        customFields[m.agentwebField] = val;
                                    }
                                }
                            } catch (e: any) {
                                console.error(`[Attio-Pull] Failed to fetch company values for companyRef ${companyRef} (non-critical):`, e.message);
                            }
                        }
                    }

                    const dealEntry = dealEntriesByPersonId.get(personId);
                    if (dealEntry && pullDealMappings.length > 0) {
                        for (const m of pullDealMappings) {
                            const slug = m.crmProperty;
                            const type = dealAttrCache?.get(`list:${config.attioDealListId}:${slug}`) || 'text';
                            const val = this.extractAttioValue(dealEntry.values[slug], type);
                            if (val != null && val !== '') {
                                if (nativeDealFields.includes(m.agentwebField)) {
                                    leadData[m.agentwebField] = val;
                                } else {
                                    customFields[m.agentwebField] = val;
                                }
                            }
                        }
                        syncMetadata.attio_list_entry_id = dealEntry.entryId;
                        // See pushLeads' identical stamp for why: lets a later
                        // delete target the list this entry actually lives in.
                        syncMetadata.attio_deal_list_id = config.attioDealListId;
                    }

                } catch (e: any) {
                    console.error(`[Attio-Pull] Failed to fetch values for person ${personId}:`, e.message);
                    continue;
                }

                if (!leadData.email) {
                    console.log(`[Attio-Pull] Skipping person ${personId} because no email was found.`);
                    continue;
                }

                if (Object.keys(customFields).length > 0) leadData.customFields = customFields;
                leadData.syncMetadata = syncMetadata;
                pageLeadData.push(leadData);
            }

            if (pageLeadData.length > 0) {
                const batchResult = await crmDb.batchCreateLeads(listId, pageLeadData, { origin: 'integration' });
                result.successCount += batchResult.successCount;
                result.newCount += batchResult.newCount;
                result.updatedCount += batchResult.mergedCount;
                result.errorCount += batchResult.errorCount;
                // ENG-1002: carry refused placeholder rows so the sync totals
                // still account for every record handed to the CRM.
                result.anonymizedSkipped = (result.anonymizedSkipped || 0) + (batchResult.anonymizedSkipped || 0);
                if (batchResult.errors?.length > 0) {
                    result.errors.push(...batchResult.errors);
                }
            }

            offset = nextOffset;
        } while (offset !== undefined);

        return result;
    }

    // ─── deleteRecord ────────────────────────────────────────────────────────────

    async deleteRecord(
        auth: CrmAuth,
        externalIds: { recordId?: string },
        _config: ExternalCrmSyncConfig
    ): Promise<void> {
        if (!externalIds.recordId) return;
        const svc = await this.getSvc(auth);
        await svc.deletePerson(externalIds.recordId);
    }

    // ─── Webhook: list-entry (deal-analog) events ─────────────────────────────────

    /**
     * Applies a single `list-entry.*` webhook event — the Deal-analog side of
     * real-time auto-pull, alongside applyAttioPersonEvent's Person side.
     * Reuses gap 2's field-extraction/routing logic (extractAttioValue,
     * nativeDealFields) narrowed to the one changed entry, via a targeted
     * single-entry fetch (AttioService.getListEntry) rather than
     * re-paginating the whole deal list per event.
     *
     * `list-entry.deleted` clears the link (syncMetadata.attio_list_entry_id)
     * rather than deleting the lead itself — a deal being removed doesn't
     * mean the person is gone, unlike record.deleted's hard-delete.
     */
    async applyListEntryWebhookEvent(
        listId: string,
        config: ExternalCrmSyncConfig,
        svc: AttioService,
        entryId: string,
        eventType: string,
        // Deal-list attribute types are scoped to config.attioDealListId. A
        // caller processing many list-entry events across lists in one job
        // can fetch this once per distinct deal-list id and share it —
        // otherwise every event refetches it fresh, with no cache of its own.
        sharedDealAttrCache?: Map<string, string>,
    ): Promise<void> {
        if (!config.attioDealListId) return;
        const pullDealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        if (pullDealMappings.length === 0) return;

        if (eventType === 'list-entry.deleted') {
            const lead = await crmDb.getLeadByAttioListEntryId(listId, entryId);
            if (!lead) return;
            // syncMetadata is a whole-object SET at the DynamoDB layer (no
            // per-key REMOVE support), so the cleared key must be genuinely
            // absent from the merged object, not set to undefined — an
            // explicit `undefined` value would still be a key on the object
            // as far as DynamoDB's marshaller is concerned.
            const syncMetadata = { ...(lead.syncMetadata || {}) };
            delete syncMetadata.attio_list_entry_id;
            delete syncMetadata.attio_deal_list_id;
            await crmDb.updateLead(listId, lead.leadId, { syncMetadata });
            console.log(`[AttioWebhook] Cleared deal link on lead ${lead.leadId} in list ${listId} (entry ${entryId} deleted)`);
            return;
        }

        const entry = await svc.getListEntry(config.attioDealListId, entryId);
        if (!entry) return; // not in our deal list — irrelevant event

        const lead = await crmDb.getLeadByAttioRecordId(listId, entry.personRecordId);
        if (!lead) return; // deal entry for a person we haven't pulled/pushed — nothing to update

        const dealAttrCache = sharedDealAttrCache ?? await svc.loadAttributeTypes('people', config.attioDealListId);
        const nativeDealFields = ['status', 'dealValue', 'dealCurrency'];
        const leadUpdates: Record<string, any> = {};
        const customFieldUpdates: Record<string, any> = {};

        for (const m of pullDealMappings) {
            const slug = m.crmProperty;
            const type = dealAttrCache.get(`list:${config.attioDealListId}:${slug}`) || 'text';
            const val = this.extractAttioValue(entry.values[slug], type);
            if (val == null || val === '') continue;
            if (nativeDealFields.includes(m.agentwebField)) {
                leadUpdates[m.agentwebField] = val;
            } else {
                customFieldUpdates[m.agentwebField] = val;
            }
        }

        if (Object.keys(customFieldUpdates).length > 0) {
            leadUpdates.customFields = mergeCustomFields(
                lead.customFields,
                customFieldUpdates,
                { source: 'attioAdapter.applyListEntryWebhookEvent', listId, leadId: lead.leadId },
            );
        }
        leadUpdates.syncMetadata = { ...(lead.syncMetadata || {}), attio_list_entry_id: entryId, attio_deal_list_id: config.attioDealListId };

        await crmDb.updateLead(listId, lead.leadId, leadUpdates);
        console.log(`[AttioWebhook] Updated deal fields on lead ${lead.leadId} in list ${listId} from entry ${entryId}`);
    }

    // ─── Field mapping helpers ────────────────────────────────────────────────────

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), obj);
    }

    private buildPersonValues(
        lead: any,
        contactMapping: FieldMapping[],
        attrCache: Map<string, string>,
        companyId?: string
    ): Record<string, any> {
        const values: Record<string, any> = {};

        for (const m of contactMapping) {
            if (!m.enabled || m.direction === 'pull') continue;

            // Skip company here as it's passed explicitly via companyId
            if (m.crmProperty === 'company') continue;

            const value = this.getNestedValue(lead, m.agentwebField);
            if (value == null || typeof value === 'object') continue;
            const strValue = String(value).trim();
            // Skip empty or known placeholder values that carry no real data.
            if (!strValue || /^(unknown|n\/a|none|null|undefined|-)$/i.test(strValue)) continue;

            // Normalize legacy/variant slugs to the canonical Attio API names.
            const slugAliases: Record<string, string> = {
                email: 'email_addresses',
                phone: 'phone_numbers',
                firstname: 'first_name',
                lastname: 'last_name',
                jobtitle: 'job_title',
                job_title_alias: 'job_title',
                hs_linkedin_url: 'linkedin',
            };
            const slug = slugAliases[m.crmProperty] ?? m.crmProperty;

            const nativeFields = ['email_addresses', 'phone_numbers', 'first_name', 'last_name', 'job_title', 'linkedin'];
            if (!nativeFields.includes(slug) && !attrCache.has(`object:people:${slug}`)) continue;

            if (slug === 'email_addresses') {
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strValue)) continue;
                values.email_addresses = [{ email_address: strValue }];
            } else if (slug === 'phone_numbers') {
                values.phone_numbers = [toAttioPhone(strValue)];
            } else if (slug === 'first_name' || slug === 'last_name') {
                if (!values.name) values.name = [{}];
                values.name[0][slug] = strValue;
            } else {
                const type = attrCache.get(`object:people:${slug}`) || 'text';
                values[slug] = [this.formatAttioValue(strValue, type)];
            }
        }

        if (companyId) {
            values.company = [{ target_object: 'companies', target_record_id: companyId }];
        }

        if (values.name?.[0]) {
            const first = String(values.name[0].first_name || '').trim();
            const last = String(values.name[0].last_name || '').trim();
            if (!first && !last) {
                delete values.name;
            } else {
                // Attio personal-name payloads are more reliable when both keys are present.
                values.name[0].first_name = first;
                values.name[0].last_name = last;
                values.name[0].full_name = [first, last].filter(Boolean).join(' ');
            }
        }

        return values;
    }

    private buildDealEntryValues(
        lead: any,
        dealMappings: FieldMapping[],
        dealSlugs: Map<string, string>,
        dealTypes: Map<string, string>
    ): Record<string, any[]> {
        const entryValues: Record<string, any> = {};

        for (const m of dealMappings) {
            const finalSlug = dealSlugs.get(m.crmProperty);
            if (!finalSlug) continue; // attribute-ensure failed for this field — skip it

            const value = this.getNestedValue(lead, m.agentwebField) ?? lead.customFields?.[m.agentwebField];
            if (value == null || typeof value === 'object') continue;
            const strValue = String(value).trim();
            if (!strValue) continue;

            const type = dealTypes.get(finalSlug) || 'text';
            entryValues[finalSlug] = [this.formatAttioValue(strValue, type)];
        }

        return entryValues;
    }

    private formatAttioValue(value: any, type: string): any {
        const str = String(value);
        const cleanType = type.replace(/-/g, '_');
        switch (cleanType) {
            case 'status': return { status: str };
            // select/number shapes confirmed against Attio's official docs
            // (docs.attio.com/rest-api/attribute-types/attribute-types-select
            // and .../attribute-types-number): select writes as {option: str},
            // number writes as {value: num} — matches extractAttioValue's
            // read-side entry.option?.title / entry.value below exactly.
            case 'select': return { option: str };
            case 'number': return { value: Number(str) };
            case 'currency': return { currency_value: Number(String(value).replace(/[^0-9.]/g, '')) };
            case 'checkbox': return { value: str === 'true' || str === '1' };
            case 'personal_name': {
                const parts = str.trim().split(/\s+/);
                const firstName = parts[0] || '';
                const lastName = parts.slice(1).join(' ') || '';
                return { first_name: firstName, last_name: lastName, full_name: [firstName, lastName].filter(Boolean).join(' ') };
            }
            case 'email_address': return { email_address: str };
            case 'phone_number': return toAttioPhone(str);
            default: return { value: str };
        }
    }





    private extractAttioValue(values: any[], type: string): any {
        return extractAttioValue(values, type);
    }
}

// Shared with applyAttioPersonEvent (attioPersonWebhookEvent.ts) so the
// webhook auto-pull path interprets Attio value shapes identically to
// pullContacts's manual pull — a standalone export rather than a private
// class method since it has no adapter-instance state.
export function extractAttioValue(values: any[], type: string): any {
    if (!values || !values.length) return undefined;
    const entry = values[0];
    const cleanType = type.replace(/-/g, '_');
    switch (cleanType) {
        case 'status': return entry.status?.title ?? entry.status?.target;
        case 'select': return entry.option?.title ?? entry.option?.target;
        case 'currency': return entry.currency_value;
        case 'number': return entry.value;
        case 'email_address': return entry.email_address;
        case 'phone_number': return entry.original_phone_number;
        case 'personal_name':
        case 'name':
            return `${entry.first_name || ''} ${entry.last_name || ''}`.trim();
        default: return entry.value;
    }
}
