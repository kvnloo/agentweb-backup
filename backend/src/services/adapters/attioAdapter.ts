import { CrmAdapter, CrmAuth } from './crmAdapterTypes';
import { ExternalCrmSyncConfig, FieldMapping, SyncResult } from '../externalCrmSyncService';
import { AttioService } from '../attioService';
import { crmDb } from '../db';

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
export class AttioAdapter implements CrmAdapter {

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

        // ── 1. Ensure the Attio people list exists ──
        const peopleListId = await this.ensurePeopleList(svc, config);

        // ── 2. Load attribute types (used for field mapping and entry values) ───
        const attrCache = await svc.loadAttributeTypes('people', peopleListId);

        // ── 3. Ensure list-entry attributes exist for deal + custom mappings ────
        const entryMappings = [
            ...config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'pull'),
            ...config.customFieldMapping.filter(m => m.enabled && m.direction !== 'pull'),
        ];
        const ensuredSlugs = new Set<string>();
        const resolvedSlugs = new Map<string, string>();
        for (const m of entryMappings) {
            const rawSlug = m.crmProperty;
            const cleanSlug = rawSlug.toLowerCase().replace(/[^a-z0-9_]/g, '_');

            let type = 'text';
            if (rawSlug === 'deal_status') type = 'status';
            else if (rawSlug === 'deal_value') type = 'currency';
            else if (rawSlug === 'deal_currency') type = 'text';
            else if (rawSlug.includes('value') || rawSlug.includes('amount')) type = 'number';

            await svc.ensureListAttribute(peopleListId, rawSlug, cleanSlug.replace(/_/g, ' '), type)
                .then(finalSlug => {
                    resolvedSlugs.set(rawSlug, finalSlug);
                    ensuredSlugs.add(finalSlug);
                    if (!attrCache.has(`list:${peopleListId!}:${finalSlug}`)) {
                        attrCache.set(`list:${peopleListId!}:${finalSlug}`, type);
                    }
                })
                .catch((e: any) => {
                    const errDetails = e.response?.data?.message || e.message || 'Unknown error';
                    console.error(`[AttioAdapter] Failed to ensure list attribute "${rawSlug}":`, errDetails);
                });
        }
        console.log(`[AttioAdapter] Ensured slugs for list ${peopleListId}:`, Array.from(ensuredSlugs));

        // ── 4. Sync each lead ───────────────────────────────────────────────────
        for (const lead of leads) {
            try {
                // Determine if we need to resolve a company relationship
                let companyId: string | undefined;
                const companyMapping = config.contactFieldMapping.find(m => m.enabled && m.direction !== 'pull' && m.crmProperty === 'company');
                const companyName = companyMapping ? this.getNestedValue(lead, companyMapping.agentwebField) : undefined;

                if (companyName) {
                    const existingCompany = await svc.findCompanyByName(companyName);
                    if (existingCompany) {
                        companyId = existingCompany.recordId;
                    } else {
                        const newCompany = await svc.createCompany(companyName);
                        companyId = newCompany.recordId;
                    }
                }

                const personValues = this.buildPersonValues(lead, config.contactFieldMapping, attrCache, companyId);
                let personId: string | undefined;

                if (lead.email) {
                    const { recordId, isNew } = await svc.upsertPersonByValues(personValues);
                    personId = recordId;
                    if (isNew) result.newCount++; else result.updatedCount++;
                } else if (lead.syncMetadata?.attio_record_id || lead.customFields?.attio_record_id || lead.attioRecordId) {
                    const existingId = lead.syncMetadata?.attio_record_id || lead.customFields?.attio_record_id || lead.attioRecordId;
                    await svc.updatePersonByValues(existingId, personValues);
                    personId = existingId;
                    result.updatedCount++;
                } else {
                    personId = await svc.createPersonByValues(personValues);
                    if (personId) {
                        await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                            syncMetadata: { ...(lead.syncMetadata || {}), attio_record_id: personId },
                        }).catch((err: any) => { });
                    }
                    result.newCount++;
                }

                if (!personId) {
                    result.errorCount++;
                    result.errors.push(`${lead.leadId}: Attio returned no record ID`);
                    continue;
                }

                // ── 5. Sync list entry (deal + custom fields) ──────────────────
                const entryValues: Record<string, any[]> = {};
                for (const m of entryMappings) {
                    const value = this.getNestedValue(lead, m.agentwebField) ?? lead.customFields?.[m.agentwebField];
                    if (value != null && String(value).trim() !== '') {
                        const finalSlug = resolvedSlugs.get(m.crmProperty);
                        if (!finalSlug) continue;

                        const type = attrCache.get(`list:${peopleListId}:${finalSlug}`) || 'text';
                        entryValues[finalSlug] = [this.formatAttioValue(value, type)];
                    }
                }
                console.log(`[AttioAdapter] lead=${lead.email || lead.leadId} entryValues=${JSON.stringify(entryValues)}`);

                const existingEntryId = await svc.findListEntry(peopleListId, personId)
                    .catch(() => null);

                if (existingEntryId) {
                    if (Object.keys(entryValues).length > 0) {
                        await svc.updateListEntry(peopleListId, existingEntryId, entryValues);
                    }
                } else {
                    try {
                        await svc.addPersonToList(peopleListId, personId, entryValues);
                    } catch (e: any) {
                        if (e.response?.status !== 409) {
                            const msg = e.response?.data?.message || e.message || 'Unknown error';
                            result.errors.push(`${lead.email || lead.leadId} (list entry): ${msg}`);
                            result.errorCount++;
                        }
                    }
                }

                result.successCount++;
            } catch (err: any) {
                result.errorCount++;
                const msg = err.response?.data?.message || err.response?.data || err.message || 'Unknown error';
                result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
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

        const peopleListId = await this.ensurePeopleList(svc, config);
        const attrCache = await svc.loadAttributeTypes('people', peopleListId);

        const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        const pullEntryMappings = [
            ...config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push'),
            ...config.customFieldMapping.filter(m => m.enabled && m.direction !== 'push'),
        ];

        let cursor: string | undefined;

        do {
            const { entries, nextCursor } = await svc.listListEntries(peopleListId, cursor);
            const pageLeadData: any[] = [];

            for (const entry of entries) {
                const personId = entry.parent_record_id ?? entry.record_id?.record_id ?? entry.record_id;
                if (!personId) {
                    console.log(`[Attio-Pull] Skipping entry ${entry.entry_id} because no parent_record_id was found.`);
                    continue;
                }

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

                        if (val != null && val !== '') leadData[m.agentwebField] = val;
                    }
                } catch (e: any) {
                    console.error(`[Attio-Pull] Failed to fetch values for person ${personId}:`, e.message);
                    continue;
                }

                if (!leadData.email) {
                    console.log(`[Attio-Pull] Skipping person ${personId} because no email was found.`);
                    continue;
                }

                const entryValues = entry.entry_values ?? {};
                const standardEntryFields = ['status', 'dealValue', 'dealCurrency', 'company'];

                for (const m of pullEntryMappings) {
                    const slug = m.crmProperty;
                    const type = attrCache.get(`list:${peopleListId}:${slug}`) || 'text';
                    const val = this.extractAttioValue(entryValues[slug], type);

                    if (val != null && val !== '') {
                        if (standardEntryFields.includes(m.agentwebField)) {
                            leadData[m.agentwebField] = val;
                        } else {
                            customFields[m.agentwebField] = val;
                        }
                    }
                }

                if (Object.keys(customFields).length > 0) leadData.customFields = customFields;
                if (Object.keys(syncMetadata).length > 0) leadData.syncMetadata = syncMetadata;
                pageLeadData.push(leadData);
            }

            if (pageLeadData.length > 0) {
                const batchResult = await crmDb.batchCreateLeads(listId, pageLeadData);
                result.successCount += batchResult.successCount;
                result.newCount += batchResult.newCount;
                result.updatedCount += batchResult.mergedCount;
                result.errorCount += batchResult.errorCount;
                if (batchResult.errors?.length > 0) {
                    result.errors.push(...batchResult.errors);
                }
            }

            cursor = nextCursor;
        } while (cursor);

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
            if (value == null || String(value).trim() === '') continue;

            const slug = m.crmProperty;

            const nativeFields = ['email_addresses', 'phone_numbers', 'first_name', 'last_name', 'job_title', 'linkedin'];
            if (!nativeFields.includes(slug) && !attrCache.has(`object:people:${slug}`)) continue;

            if (slug === 'email_addresses') {
                values.email_addresses = [{ email_address: String(value) }];
            } else if (slug === 'phone_numbers') {
                values.phone_numbers = [{ original_phone_number: String(value) }];
            } else if (slug === 'first_name' || slug === 'last_name') {
                if (!values.name) values.name = [{}];
                values.name[0][slug] = String(value);
            } else {
                const type = attrCache.get(`object:people:${slug}`) || 'text';
                values[slug] = [this.formatAttioValue(value, type)];
            }
        }

        if (companyId) {
            values.company = [{ target_object: 'companies', target_record_id: companyId }];
        }

        if (values.name?.[0]) {
            const first = values.name[0].first_name || '';
            const last = values.name[0].last_name || '';
            values.name[0].full_name = `${first} ${last}`.trim() || undefined;
        }

        return values;
    }

    private formatAttioValue(value: any, type: string): any {
        const str = String(value);
        const cleanType = type.replace(/-/g, '_');
        switch (cleanType) {
            case 'status': return { status: { target: str } };
            case 'select': return { select: { target: str } };
            case 'number': return { number_value: Number(str) };
            case 'currency': return { currency_value: Number(str) };
            case 'checkbox': return { value: str === 'true' || str === '1' };
            default: return { value: str };
        }
    }

    private extractAttioValue(values: any[], type: string): any {
        if (!values || !values.length) return undefined;
        const entry = values[0];
        const cleanType = type.replace(/-/g, '_');
        switch (cleanType) {
            case 'status': return entry.status?.title ?? entry.status?.target;
            case 'select': return entry.select?.title ?? entry.select?.target;
            case 'currency': return entry.currency_value;
            case 'number': return entry.number_value;
            case 'email_address': return entry.email_address;
            case 'phone_number': return entry.original_phone_number;
            case 'name': return `${entry.first_name || ''} ${entry.last_name || ''}`.trim();
            default: return entry.value;
        }
    }

    private async ensurePeopleList(
        svc: AttioService,
        config: ExternalCrmSyncConfig
    ): Promise<string> {
        let peopleListId = config.externalPeopleListId;
        if (peopleListId) {
            try {
                await svc.verifyList(peopleListId);
            } catch (e: any) {
                if (e.response?.status === 404) {
                    peopleListId = undefined;
                    config.externalPeopleListId = undefined;
                } else {
                    throw e;
                }
            }
        }
        if (!peopleListId) {
            const listName = config.listName || config.listId;
            peopleListId = await svc.findOrCreateList(listName, 'people');
            config.externalPeopleListId = peopleListId;
        }
        return peopleListId;
    }
}
