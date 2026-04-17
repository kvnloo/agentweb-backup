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

        // Load attribute types for person-level attributes (no list required)
        const attrCache = await svc.loadAttributeTypes('people');

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

        // Map from Attio API slugs to AttioPerson fields (for respecting the field mapping config)
        const ATTIO_PERSON_FIELD_MAP: Record<string, string> = {
            'email_addresses': 'email',
            'first_name': 'firstName',
            'last_name': 'lastName',
            'phone_numbers': 'phone',
            'job_title': 'jobTitle',
            'linkedin': 'linkedinUrl',
        };

        let cursor: string | undefined;

        do {
            const { people, nextCursor } = await svc.listPeople(cursor);
            const pageLeadData: any[] = [];

            for (const person of people) {
                if (!person.email) {
                    console.log(`[Attio-Pull] Skipping person ${person.recordId} because no email was found.`);
                    continue;
                }

                result.seenExternalIds!.push(person.recordId);
                const leadData: Record<string, any> = {};
                const syncMetadata: Record<string, any> = { attio_record_id: person.recordId };

                for (const m of pullContactMappings) {
                    const personField = ATTIO_PERSON_FIELD_MAP[m.crmProperty];
                    if (!personField) continue;
                    const val = (person as any)[personField];
                    if (val != null && val !== '') {
                        leadData[m.agentwebField] = val;
                    }
                }

                if (!leadData.email) continue;

                leadData.syncMetadata = syncMetadata;
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

}
