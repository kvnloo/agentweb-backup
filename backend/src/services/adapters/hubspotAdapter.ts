import { CrmAdapter, CrmAuth } from './crmAdapterTypes';
import { ExternalCrmSyncConfig, FieldMapping, SyncResult } from '../externalCrmSyncService';
import { HubSpotService } from '../hubspotService';
import { crmDb } from '../db';


/**
 * HubSpot CRM Adapter
 *
 * Thin orchestration + field-mapping layer on top of HubSpotService.
 * All HubSpot API calls go through HubSpotService — no raw axios here.
 *
 * Responsibilities:
 *  - Resolve auth → scoped HubSpotService instance (getSvc)
 *  - Map internal Lead fields to HubSpot contact/deal properties (buildHubSpotProps)
 *  - Orchestrate push/pull flow (property creation, upsert, deal sync)
 *
 * getSvc() calls svc.init() once for OAuth connections — the service instance
 * caches the resolved token for the lifetime of the operation, so no repeated
 * DB reads occur across the many API calls in a sync.
 */
export class HubspotAdapter implements CrmAdapter {
    private formatError(err: any): string {
        return err?.response?.data?.message
            || err?.response?.data?.error
            || err?.message
            || 'Unknown error';
    }

    // ─── Auth ──────────────────────────────────────────────────────────────────

    /**
     * Returns a HubSpotService scoped to the given auth context.
     * - OAuth: HubSpotService.create() — one DB read to resolve + cache token
     * - Token (Private App): HubSpotService.fromToken() — zero DB reads ever
     */
    private async getSvc(auth: CrmAuth): Promise<HubSpotService> {
        if (auth.type === 'token') return HubSpotService.fromToken(auth.apiKey);
        return HubSpotService.create(auth.userId, auth.accountId);
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
        const svc = await this.getSvc(auth); // token resolved ONCE here

        // ── 1. Pre-create any missing custom contact properties ──────────────────
        const customContactMappings = config.customFieldMapping.filter(m => m.enabled && m.direction !== 'pull');
        for (const m of customContactMappings) {
            const label = m.crmProperty.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            try {
                const propertyName = await svc.ensureContactProperty(m.crmProperty, label);
                console.log(`[HubspotAdapter] ensured contact property "${m.crmProperty}" as "${propertyName}"`);
            } catch (err: any) {
                console.error(`[HubspotAdapter] failed to ensure contact property "${m.crmProperty}": ${this.formatError(err)}`);
                throw err;
            }
        }

        // ── 2. Pre-create any missing custom deal properties ─────────────────────
        const dealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'pull');
        for (const m of dealMappings) {
            if (m.crmProperty === 'dealstage') continue;
            const label = m.crmProperty.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            try {
                const propertyName = await svc.ensureDealProperty(m.crmProperty, label);
                console.log(`[HubspotAdapter] ensured deal property "${m.crmProperty}" as "${propertyName}"`);
            } catch (err: any) {
                console.error(`[HubspotAdapter] failed to ensure deal property "${m.crmProperty}": ${this.formatError(err)}`);
                throw err;
            }
        }

        // ── 3. Sync each lead ────────────────────────────────────────────────────
        for (const lead of leads) {
            try {
                if (!lead.email) continue; // HubSpot requires email to upsert

                // Build contact properties from contact + custom mappings
                const contactProps = this.buildHubSpotProps(lead, config.contactFieldMapping);
                const customProps = this.buildHubSpotProps(lead, config.customFieldMapping);
                const allContactProps = { ...contactProps, ...customProps };

                if (Object.keys(allContactProps).length === 0) continue;

                // Upsert contact — service handles find-or-create
                const existingContactId = lead.syncMetadata?.hubspot_contact_id || lead.customFields?.hubspot_contact_id;
                const { contactId, isNew } = await svc.upsertContact({
                    email: lead.email,
                    ...this.propsToContactData(allContactProps),
                    customFields: this.extractCustomFields(allContactProps),
                });

                if (isNew) result.newCount++; else result.updatedCount++;
                result.successCount++;

                // Persist HubSpot contact ID back to our DB
                await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
                    syncMetadata: { ...(lead.syncMetadata || {}), hubspot_contact_id: contactId },
                }).catch((err) => {
                    console.error(`[HubspotAdapter] failed to persist hubspot_contact_id for ${lead.email}: ${this.formatError(err)}`);
                });

                // ── 4. Deal sync (non-critical) ────────────────────────────────────
                if (dealMappings.length > 0) {
                    const dealProps = this.applyHubSpotDealStageMapping(
                        this.buildHubSpotProps(lead, config.dealFieldMapping),
                        config,
                        lead
                    );
                    if (Object.keys(dealProps).length > 0) {
                        await this.syncDeal(svc, contactId, dealProps, lead, config);
                    }
                }
            } catch (err: any) {
                result.errorCount++;
                const msg = this.formatError(err);
                console.error(`[HubspotAdapter] lead sync failed for ${lead.email || lead.leadId}: ${msg}`);
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
        const svc = await this.getSvc(auth); // token resolved ONCE here

        const pullContactMappings = config.contactFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        const pullDealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'push');
        const pullCustomMappings = config.customFieldMapping.filter(m => m.enabled && m.direction !== 'push');

        const contactProps = [
            ...pullContactMappings.map(m => m.crmProperty),
            ...pullCustomMappings.map(m => m.crmProperty),
        ];
        if (contactProps.length === 0) contactProps.push('email', 'firstname', 'lastname');

        let cursor: string | undefined;

        do {
            const { results, nextCursor } = await svc.listContactsPage(contactProps, cursor);
            const pageLeadData: any[] = [];

            for (const contact of results) {
                result.seenExternalIds!.push(contact.id);
                const leadData: Record<string, any> = {};
                const customFields: Record<string, any> = {};
                const syncMetadata: Record<string, any> = { hubspot_contact_id: contact.id };

                const nativeFields = ['firstName', 'lastName', 'email', 'phone', 'company', 'title', 'linkedin', 'notes'];
                const nativeDealFields = ['status', 'dealValue', 'dealCurrency'];

                // Map standard contact fields
                for (const m of pullContactMappings) {
                    const val = contact.properties?.[m.crmProperty];
                    if (val != null && val !== '') {
                        if (nativeFields.includes(m.agentwebField)) {
                            leadData[m.agentwebField] = val;
                        } else {
                            customFields[m.agentwebField] = val;
                        }
                    }
                }

                // Map custom fields
                for (const m of pullCustomMappings) {
                    const val = contact.properties?.[m.crmProperty];
                    if (val != null && val !== '') customFields[m.agentwebField] = val;
                }

                // Map deal fields — fetch associated deal if needed
                if (pullDealMappings.length > 0) {
                    try {
                        const dealIds = await svc.getContactDealAssociations(contact.id);
                        if (dealIds.length > 0) {
                            console.log(`[HubspotAdapter] pull contact=${contact.id} associated deal=${dealIds[0]}`);
                            const dealPropsNeeded = pullDealMappings.map(m => m.crmProperty);
                            const deal = await svc.getDeal(dealIds[0], dealPropsNeeded);
                            if (deal) {
                                for (const m of pullDealMappings) {
                                    const val = deal.properties?.[m.crmProperty];
                                    if (val != null && val !== '') {
                                        const mappedVal = this.mapHubSpotStageIdToAgentWebValue(
                                            m.crmProperty,
                                            String(val),
                                            config
                                        );
                                        if (nativeDealFields.includes(m.agentwebField)) {
                                            leadData[m.agentwebField] = mappedVal;
                                        } else {
                                            customFields[m.agentwebField] = mappedVal;
                                        }
                                    }
                                }
                                syncMetadata.hubspot_deal_id = deal.id;
                            }
                        }
                    } catch (err: any) {
                        const msg = this.formatError(err);
                        console.error(`[HubspotAdapter] failed to pull associated deal for contact ${contact.id}: ${msg}`);
                        result.errorCount++;
                        result.errors.push(`Contact ${contact.id} deal pull: ${msg}`);
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
        externalIds: { contactId?: string; dealId?: string },
        _config: ExternalCrmSyncConfig
    ): Promise<void> {
        const svc = await this.getSvc(auth);
        if (externalIds.dealId) {
            await svc.deleteDeal(externalIds.dealId).catch(err =>
                console.error(`[HubspotAdapter] deleteRecord: failed to delete deal ${externalIds.dealId}:`, err.message)
            );
        }
        if (externalIds.contactId) {
            await svc.deleteContact(externalIds.contactId);
        }
    }

    // ─── Deal sync helper ────────────────────────────────────────────────────────

    private async syncDeal(
        svc: HubSpotService,
        contactId: string,
        dealProps: Record<string, string>,
        lead: any,
        config: ExternalCrmSyncConfig
    ): Promise<void> {
        let propsWithName = dealProps.dealname
            ? dealProps
            : { ...dealProps, dealname: this.buildDealName(lead) };

        // Inject pipeline if configured
        if (config.externalPipelineId) {
            propsWithName = { ...propsWithName, pipeline: config.externalPipelineId };
        }

        const existingDealId: string | undefined = lead.syncMetadata?.hubspot_deal_id || lead.customFields?.hubspot_deal_id;
        let dealId: string;

        if (existingDealId) {
            try {
                await svc.updateDeal(existingDealId, dealProps);
                dealId = existingDealId;
                console.log(`[HubspotAdapter] updated HubSpot deal ${existingDealId} for lead=${lead.email || lead.leadId}`);
            } catch (err: any) {
                console.error(
                    `[HubspotAdapter] update failed for HubSpot deal ${existingDealId} lead=${lead.email || lead.leadId}: ${this.formatError(err)}. Falling back to create.`,
                    err.response?.data
                );
                // Existing deal gone — create a new one
                dealId = await svc.createDeal(propsWithName);
                console.log(`[HubspotAdapter] created replacement HubSpot deal ${dealId} for lead=${lead.email || lead.leadId}`);
                await svc.associateContactToDeal(contactId, dealId);
                console.log(`[HubspotAdapter] associated contact ${contactId} to replacement deal ${dealId}`);
            }
        } else {
            try {
                dealId = await svc.createDeal(propsWithName);
                console.log(`[HubspotAdapter] created HubSpot deal ${dealId} for lead=${lead.email || lead.leadId}`);
                await svc.associateContactToDeal(contactId, dealId);
                console.log(`[HubspotAdapter] associated contact ${contactId} to deal ${dealId}`);
            } catch (err: any) {
                console.error(`[HubspotAdapter] creation failed for HubSpot deal for lead=${lead.email || lead.leadId}: ${this.formatError(err)}`, err.response?.data);
                throw err;
            }
        }

        await crmDb.updateLead(lead.listId || config.listId, lead.leadId, {
            syncMetadata: { ...(lead.syncMetadata || {}), hubspot_deal_id: dealId },
        }).catch((err: any) => {
            console.error(`[HubspotAdapter] failed to persist hubspot_deal_id for lead=${lead.email || lead.leadId}: ${this.formatError(err)}`);
        });
    }

    // ─── Field mapping helpers ────────────────────────────────────────────────────

    private getNestedValue(obj: any, path: string): any {
        return path.split('.').reduce((cur, part) => (cur == null ? undefined : cur[part]), obj);
    }

    /**
     * Maps lead fields to a flat HubSpot properties object using the provided mapping.
     * Skips disabled mappings and pull-only mappings.
     */
    private buildHubSpotProps(lead: any, mapping: FieldMapping[]): Record<string, string> {
        const props: Record<string, string> = {};
        for (const m of mapping) {
            if (!m.enabled || m.direction === 'pull') continue;
            const value = lead.customFields?.[m.agentwebField] ?? this.getNestedValue(lead, m.agentwebField);
            if (value != null && String(value).trim() !== '') {
                props[m.crmProperty] = String(value);
            }
        }
        return props;
    }

    private applyHubSpotDealStageMapping(
        dealProps: Record<string, string>,
        config: ExternalCrmSyncConfig,
        lead: any
    ): Record<string, string> {
        const stageValue = dealProps.dealstage;
        if (!stageValue) return dealProps;

        const mappedStageValue = config.hubspotDealStageMap?.[stageValue] || stageValue;
        if (mappedStageValue !== stageValue) {
            console.log(
                `[HubspotAdapter] mapped AgentWeb status "${stageValue}" to HubSpot dealstage "${mappedStageValue}" for lead=${lead.email || lead.leadId}`
            );
        }

        return { ...dealProps, dealstage: mappedStageValue };
    }

    private mapHubSpotStageIdToAgentWebValue(
        crmProperty: string,
        value: string,
        config: ExternalCrmSyncConfig
    ): string {
        if (crmProperty !== 'dealstage' || !config.hubspotDealStageMap) return value;

        const reverseEntry = Object.entries(config.hubspotDealStageMap).find(([, stageId]) => stageId === value);
        return reverseEntry?.[0] || value;
    }

    /**
     * Converts a flat HubSpot-keyed props object to HubSpotContact field names.
     * Only maps the known standard fields — everything else is a custom field.
     */
    private propsToContactData(props: Record<string, string>): Partial<{
        firstName: string; lastName: string; phone: string;
        jobTitle: string; company: string; linkedinUrl: string;
    }> {
        const data: any = {};
        if (props.firstname) data.firstName = props.firstname;
        if (props.lastname) data.lastName = props.lastname;
        if (props.phone) data.phone = props.phone;
        if (props.jobtitle) data.jobTitle = props.jobtitle;
        if (props.company) data.company = props.company;
        if (props.hs_linkedin_url) data.linkedinUrl = props.hs_linkedin_url;
        return data;
    }

    /**
     * Extracts non-standard properties from a props object as customFields.
     */
    private extractCustomFields(props: Record<string, string>): Record<string, string> | undefined {
        const standard = new Set(['email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url']);
        const custom: Record<string, string> = {};
        for (const [k, v] of Object.entries(props)) {
            if (!standard.has(k)) custom[k] = v;
        }
        return Object.keys(custom).length > 0 ? custom : undefined;
    }

    private buildDealName(lead: any): string {
        const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email || 'Unknown';
        return `${name} - Deal`;
    }

}
