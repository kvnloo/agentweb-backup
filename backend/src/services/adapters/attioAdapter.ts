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

        // Load person-level attribute types first.
        // ── 1. Load person-level attribute types ─────────────────────────────────
        const attrCache = await svc.loadAttributeTypes('people');

        const customPersonMappings = config.customFieldMapping.filter(
            m => m.enabled && m.direction !== 'pull'
        );
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
                })
                .catch((e: any) => {
                    const errDetails = e.response?.data?.message || e.message || 'Unknown error';
                    console.error(`[AttioAdapter] Failed to ensure person attribute "${rawSlug}":`, errDetails);
                });
        }
        console.log(`[AttioAdapter] Ensured person-level slugs:`, Array.from(ensuredSlugs));

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

                // Build person values including custom mapped person attributes.
                const personValues = this.buildPersonValues(lead, config.contactFieldMapping, attrCache, companyId);
                for (const m of customPersonMappings) {
                    const value = this.getNestedValue(lead, m.agentwebField) ?? lead.customFields?.[m.agentwebField];
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

                let personId: string | undefined;

                // Only treat as email if it looks like a real address (not a placeholder like "unknown").
                const hasEmail = lead.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email);

                if (hasEmail) {
                    const { recordId, isNew } = await svc.upsertPersonByValues(personValues);
                    personId = recordId;
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
                            result.newCount++;
                            // Clear stale record ID so it gets overwritten below
                            lead.syncMetadata = { ...(lead.syncMetadata || {}), attio_record_id: undefined };
                        } else {
                            throw updateErr;
                        }
                    }
                } else {
                    personId = await svc.createPersonByValues(personValues);
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

        const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        const attrCache = await svc.loadAttributeTypes('people');

        const pullCustomMappings = config.customFieldMapping.filter(
            m => m.enabled && m.direction !== 'push'
        );
        const standardEntryFields = ['company'];

        let cursor: string | undefined;

        do {
            const { people, nextCursor } = await svc.listPeople(cursor);
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

                        if (val != null && val !== '') leadData[m.agentwebField] = val;
                    }

                    for (const m of pullCustomMappings) {
                        const slug = m.crmProperty;
                        const type = attrCache.get(`object:people:${slug}`) || 'text';
                        const val = this.extractAttioValue(personValues[slug], type);
                        if (val != null && val !== '') {
                            customFields[m.agentwebField] = val;
                        }
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
                const batchResult = await crmDb.batchCreateLeads(listId, pageLeadData);
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
                values.phone_numbers = [{ original_phone_number: strValue }];
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

    private formatAttioValue(value: any, type: string): any {
        const str = String(value);
        const cleanType = type.replace(/-/g, '_');
        switch (cleanType) {
            case 'status': return { status: str };
            case 'select': return { select: { target: str } };
            case 'number': return { number_value: Number(str) };
            case 'currency': return { currency_value: Number(String(value).replace(/[^0-9.]/g, '')) };
            case 'checkbox': return { value: str === 'true' || str === '1' };
            case 'personal_name': {
                const parts = str.trim().split(/\s+/);
                const firstName = parts[0] || '';
                const lastName = parts.slice(1).join(' ') || '';
                return { first_name: firstName, last_name: lastName, full_name: [firstName, lastName].filter(Boolean).join(' ') };
            }
            case 'email_address': return { email_address: str };
            case 'phone_number': return { original_phone_number: str };
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
            case 'personal_name':
            case 'name':
                return `${entry.first_name || ''} ${entry.last_name || ''}`.trim();
            default: return entry.value;
        }
    }
}
