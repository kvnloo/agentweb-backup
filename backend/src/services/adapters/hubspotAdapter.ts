import { CrmAdapter, CrmAuth, PushContext } from './crmAdapterTypes';
import { ExternalCrmSyncConfig, FieldMapping, SyncResult } from '../externalCrmSyncService';
import { HubSpotService } from '../hubspotService';
import { crmDb } from '../db';
import { validateEmail } from '../../utils/validation';
import { splitAndRetry } from '../../utils/hubspotBatchRetry';
import { buildSyncedMetadata, buildFailedMetadata } from '../../utils/leadSyncStatus';

/**
 * How many 100-record batches to send to HubSpot at once during a push. The
 * batch endpoints are otherwise issued one-at-a-time, which dominates the wall
 * clock on large lists. Kept modest (and env-overridable) to stay within
 * HubSpot's rate limits; the 429-retry interceptor absorbs occasional overage.
 */
const PUSH_BATCH_CONCURRENCY = Math.max(1, Number(process.env.HUBSPOT_PUSH_CONCURRENCY) || 6);

/**
 * System list-identity mappings: the source lead list's name and id, pushed to
 * HubSpot so contacts can be segmented by which Emma list they came from.
 * Push-only (the values are owned by Emma). Defined here — not in
 * externalCrmSyncService — because that module constructs a HubspotAdapter at
 * load time, so importing a runtime value the other way would form a cycle.
 * pushLeads injects these at push time when a stored config doesn't already
 * carry them, so lists connected before this feature shipped sync the fields
 * without a manual re-save. An explicit config entry (re-mapped or disabled in
 * the dialog) always wins.
 */
export const HUBSPOT_LIST_IDENTITY_MAPPING: FieldMapping[] = [
  { agentwebField: 'listName', crmProperty: 'lead_list_name', direction: 'push', enabled: true },
  { agentwebField: 'listId', crmProperty: 'lead_list_id', direction: 'push', enabled: true },
];


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
    /**
     * HubSpot contact properties that exist natively on every portal. Anything
     * mapped to a property outside this set — regardless of whether it lives in
     * contactFieldMapping or customFieldMapping — must be pre-created before a
     * push, otherwise HubSpot rejects the upsert with PROPERTY_DOESNT_EXIST.
     */
    private static readonly STANDARD_CONTACT_PROPS = new Set([
        'email', 'firstname', 'lastname', 'phone', 'jobtitle', 'company', 'hs_linkedin_url',
    ]);

    /** agentwebFields that carry only source-list identity, not lead content. */
    private static readonly LIST_IDENTITY_FIELDS = new Set(
        HUBSPOT_LIST_IDENTITY_MAPPING.map(m => m.agentwebField)
    );

    private formatError(err: any): string {
        return err?.response?.data?.message
            || err?.response?.data?.error
            || err?.message
            || 'Unknown error';
    }

    /**
     * Flag gate: pushLeads uses the HubSpot batch APIs by DEFAULT. Set
     * HUBSPOT_BATCH_PUSH_ENABLED='false' to fall back to the per-lead path
     * (kill switch). Any other value (unset, 'true', etc.) → batched.
     */
    private batchEnabled(): boolean {
        return process.env.HUBSPOT_BATCH_PUSH_ENABLED !== 'false';
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
        config: ExternalCrmSyncConfig,
        ctx?: PushContext
    ): Promise<SyncResult> {
        const result: SyncResult = { successCount: 0, newCount: 0, updatedCount: 0, errorCount: 0, errors: [] };
        // Reuse one service across all chunks of a push (via the shared ctx) so the
        // token is resolved once and per-instance property-ensure caching kicks in —
        // otherwise each 500-lead chunk re-resolves auth and re-GETs every property.
        let svc = ctx?.svc as HubSpotService | undefined;
        if (!svc) {
            svc = await this.getSvc(auth);
            if (ctx) ctx.svc = svc;
        }

        // Resolve the source list's display name once so leads can be enriched with
        // listName/listId before mapping. Leads carry listId natively but not the
        // human-readable list name (it lives on the AW-LeadLists record). Mapping
        // these to CRM properties lets contacts be segmented by their Emma list.
        // Falls back to config.listName, then config.listId, so a failed/absent
        // lookup never aborts the push — the mapping just resolves to whatever's known.
        let resolvedListName = config.listName;
        try {
            const list = await crmDb.getLeadListById(config.listId);
            if (list?.name) resolvedListName = list.name;
        } catch (err: any) {
            console.warn(`[HubspotAdapter] failed to resolve list name for ${config.listId}: ${this.formatError(err)}`);
        }

        // Ensure the system list-identity mappings (listName/listId) are present.
        // Configs created before this feature shipped don't carry them in their
        // stored customFieldMapping, so inject them here unless the config already
        // has an explicit entry for that agentwebField — an explicit entry (user
        // re-mapped or disabled it in the dialog) always wins. This is the single
        // choke point for every push path (full push + auto-sync single lead).
        const effectiveCustomMapping = this.withListIdentityMappings(config.customFieldMapping);
        // CRM property names that carry only list identity — used to decide whether
        // a lead has any real content worth syncing (see the per-lead guard below).
        const listIdentityProps = new Set(
            effectiveCustomMapping
                .filter(m => HubspotAdapter.LIST_IDENTITY_FIELDS.has(m.agentwebField))
                .map(m => m.crmProperty)
        );

        // ── 1. Pre-create any missing non-standard contact properties ────────────
        // buildHubSpotProps pushes properties from BOTH contactFieldMapping and
        // customFieldMapping, so any non-standard property in either list must be
        // ensured here — not just those in customFieldMapping. (Legacy configs may
        // place a non-standard property such as "notes" in contactFieldMapping.)
        const pushContactMappings = [
            ...config.contactFieldMapping,
            ...effectiveCustomMapping,
        ].filter(m => m.enabled && m.direction !== 'pull');
        const ensuredProps = new Set<string>();
        for (const m of pushContactMappings) {
            const crmProperty = m.crmProperty.toLowerCase();
            if (HubspotAdapter.STANDARD_CONTACT_PROPS.has(crmProperty)) continue;
            if (ensuredProps.has(crmProperty)) continue;
            ensuredProps.add(crmProperty);
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

        // ── 3. Sync leads — batched or per-lead, depending on the feature flag ───
        // Collects succeeded contact IDs across both paths for post-sync import.
        const allContactIds = new Set<string>();

        if (!this.batchEnabled()) {
            await this.pushLeadsPerLead(
                svc, leads, config, result,
                effectiveCustomMapping, listIdentityProps, resolvedListName, allContactIds,
            );
        } else {
            await this.pushLeadsBatched(
                svc, leads, config, result, dealMappings,
                effectiveCustomMapping, listIdentityProps, resolvedListName, allContactIds,
            );
        }

        // Post-sync: mark contacts as non-marketing via HubSpot Imports API.
        // Async on HubSpot's side — changes reflect within seconds to minutes.
        // Non-critical: a failure here is logged but does NOT fail the sync.
        if (config.hubspotMarkAsNonMarketing && allContactIds.size > 0) {
            try {
                const jobId = await svc.importContactsMarketableStatus([...allContactIds], false);
                console.log(`[HubspotAdapter] marketing status import started: jobId=${jobId} contacts=${allContactIds.size}`);
            } catch (err: any) {
                console.warn(`[HubspotAdapter] marketing status import failed (non-critical): ${this.formatError(err)}`);
            }
        }

        return result;
    }

    /**
     * Per-lead push path (the original sequential loop). Each lead is upserted /
     * created / updated and its deal synced one at a time. Used when the batch
     * flag is off, and as the path for email-less leads in the batched path
     * (they cannot upsert-by-email).
     */
    private async pushLeadsPerLead(
        svc: HubSpotService,
        leads: any[],
        config: ExternalCrmSyncConfig,
        result: SyncResult,
        effectiveCustomMapping: FieldMapping[],
        listIdentityProps: Set<string>,
        resolvedListName: string | undefined,
        contactIdCollector?: Set<string>,
    ): Promise<void> {
        const dealMappings = config.dealFieldMapping.filter(m => m.enabled && m.direction !== 'pull');
        for (const lead of leads) {
            try {
                const email = typeof lead.email === 'string' ? lead.email.trim() : '';

                // Guard against non-email values (e.g. a social/profile URL landing
                // in the email field). HubSpot rejects these with INVALID_EMAIL and
                // aborts the whole upsert; skip them with a clear per-lead error so
                // the rest of the batch still syncs. An empty email is allowed — we
                // push those via create/update-by-id below.
                if (email && !validateEmail(email)) {
                    result.errorCount++;
                    const msg = `Invalid email "${email}" — skipped (not a valid email address)`;
                    console.warn(`[HubspotAdapter] ${msg} for lead=${lead.leadId}`);
                    result.errors.push(`${email}: ${msg}`);
                    await this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, msg));
                    continue;
                }

                // Enrich with the source lead-list identity so listName/listId
                // mappings resolve. listId is already on the lead; listName is not,
                // so we graft the resolved name on (without persisting it back).
                const enrichedLead = {
                    ...lead,
                    listId: lead.listId ?? config.listId,
                    listName: lead.listName ?? resolvedListName,
                };

                // Build contact properties from contact + custom mappings
                const contactProps = this.buildHubSpotProps(enrichedLead, config.contactFieldMapping);
                const customProps = this.buildHubSpotProps(enrichedLead, effectiveCustomMapping);
                const allContactProps = { ...contactProps, ...customProps };

                // Skip leads with no real content. List identity is injected onto
                // every lead, so a lead carrying ONLY list-identity props (e.g. an
                // empty email-less lead) has nothing worth syncing — pushing it
                // would create a junk HubSpot contact tagged with just a list.
                const hasRealProps = Object.keys(allContactProps).some(
                    k => !listIdentityProps.has(k)
                );
                if (!hasRealProps) continue;

                const contactData = {
                    ...(email ? { email } : {}),
                    ...this.propsToContactData(allContactProps),
                    customFields: this.extractCustomFields(allContactProps),
                };

                let contactId: string;
                let wasNew: boolean;
                if (email) {
                    // Email present — find-or-create by email (dedup).
                    const upserted = await svc.upsertContact(contactData);
                    contactId = upserted.contactId;
                    wasNew = upserted.isNew;
                } else {
                    // No email to dedup on. If we synced this lead before, update the
                    // known contact by id; otherwise create a fresh email-less contact.
                    const existingContactId: string | undefined =
                        lead.syncMetadata?.hubspot_contact_id || lead.customFields?.hubspot_contact_id;
                    if (existingContactId) {
                        const updated = await svc.updateContact(existingContactId, contactData);
                        contactId = updated.contactId;
                        wasNew = false;
                    } else {
                        const created = await svc.createContact(contactData);
                        contactId = created.contactId;
                        wasNew = true;
                    }
                }
                if (wasNew) result.newCount++; else result.updatedCount++;

                // Two-step lifecycle stage update (read → clear → set, with restore
                // on failure). Overcomes HubSpot's forward-only restriction. Skip if a
                // per-lead mapping already set lifecyclestage on the upsert above.
                // A failure here means the contact did NOT reach the target stage, so
                // the lead is recorded as an error (and healed on the next push)
                // rather than reported as a clean success — but the contact id is
                // still persisted so the link isn't lost. Deal sync is skipped for a
                // failed lead; a re-push re-runs it idempotently.
                let lifecycleReason: string | null = null;
                if (config.hubspotLifecycleStage && !('lifecyclestage' in allContactProps)) {
                    const r = await this.applyLifecycleStageSingle(svc, contactId, config.hubspotLifecycleStage);
                    if (!r.ok) lifecycleReason = r.reason;
                }

                if (lifecycleReason) {
                    // Demote: count as error, undo the new/updated tally, preserve the
                    // contact id in the failed metadata.
                    if (wasNew) result.newCount--; else result.updatedCount--;
                    result.errorCount++;
                    const msg = `lifecycle stage not set — ${lifecycleReason}`;
                    console.warn(`[HubspotAdapter] ${msg} for contact ${contactId} (lead=${lead.email || lead.leadId})`);
                    result.errors.push(`${lead.email || lead.leadId}: ${msg}`);
                    await this.persistSyncMetadata(lead, config.listId, {
                        ...buildFailedMetadata(lead.syncMetadata, msg),
                        hubspot_contact_id: contactId,
                    });
                    continue;
                }

                result.successCount++;
                if (contactIdCollector) contactIdCollector.add(contactId);

                // Persist HubSpot contact ID + synced status back to our DB.
                await this.persistSyncMetadata(
                    lead, config.listId,
                    buildSyncedMetadata(lead.syncMetadata, contactId, new Date().toISOString()),
                );

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
                await this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, msg));
            }
        }
    }

    /**
     * Batched push path (flag-gated). Upserts contacts, creates/updates/associates
     * deals through the HubSpot batch APIs, isolating bad items via splitAndRetry.
     * Email-bearing leads go through batch upsert-by-email; email-less leads (which
     * cannot dedup by email) are delegated to the per-lead path. Mirrors every
     * behavior of the per-lead path: invalid-email skip, skip-empty guard,
     * new/updated counting, and contact-id-before-deal idempotent writeback.
     */
    private async pushLeadsBatched(
        svc: HubSpotService,
        leads: any[],
        config: ExternalCrmSyncConfig,
        result: SyncResult,
        dealMappings: FieldMapping[],
        effectiveCustomMapping: FieldMapping[],
        listIdentityProps: Set<string>,
        resolvedListName: string | undefined,
        contactIdCollector?: Set<string>,
    ): Promise<void> {
        const t0 = Date.now();

        // ── Stage 1: partition leads into email-bearing vs email-less ──────────
        interface PreppedLead {
            lead: any;
            emailLower: string;            // '' for email-less
            allContactProps: Record<string, string>;
        }
        const emailLeads: PreppedLead[] = [];
        const emaillessLeads: any[] = [];
        // Tracks leads where a per-lead field mapping already set lifecyclestage —
        // these must skip the two-step so the explicit mapping value is preserved.
        const perLeadLifecycleSet = new Set<any>();

        for (const lead of leads) {
            const email = typeof lead.email === 'string' ? lead.email.trim() : '';

            // Invalid-email guard (mirror per-lead path): skip with a clear error.
            if (email && !validateEmail(email)) {
                result.errorCount++;
                const msg = `Invalid email "${email}" — skipped (not a valid email address)`;
                console.warn(`[HubspotAdapter] ${msg} for lead=${lead.leadId}`);
                result.errors.push(`${email}: ${msg}`);
                await this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, msg));
                continue;
            }

            // Enrich with source list identity so listName/listId mappings resolve.
            const enrichedLead = {
                ...lead,
                listId: lead.listId ?? config.listId,
                listName: lead.listName ?? resolvedListName,
            };

            const allContactProps = {
                ...this.buildHubSpotProps(enrichedLead, config.contactFieldMapping),
                ...this.buildHubSpotProps(enrichedLead, effectiveCustomMapping),
            };

            // Skip-empty guard: a lead carrying ONLY list-identity props has nothing
            // worth syncing — pushing it would create a junk contact tagged with a list.
            const hasRealProps = Object.keys(allContactProps).some(k => !listIdentityProps.has(k));
            if (!hasRealProps) continue;

            if ('lifecyclestage' in allContactProps) perLeadLifecycleSet.add(lead);

            if (email) {
                emailLeads.push({ lead, emailLower: email.toLowerCase(), allContactProps });
            } else {
                // Email-less leads cannot upsert-by-email; route to per-lead path (Stage 5).
                emaillessLeads.push(lead);
            }
        }

        // ── Stage 2: batch-upsert contacts for email leads ─────────────────────
        // Multiple DB leads may share one email; HubSpot upserts by email, so we
        // must send exactly ONE input per unique email (a duplicate input 409s and
        // produces phantom processing). leadByEmail keeps the FIRST prepped lead per
        // email purely to source the contact props for that single input.
        const leadByEmail = new Map<string, PreppedLead>();
        for (const p of emailLeads) {
            if (!leadByEmail.has(p.emailLower)) leadByEmail.set(p.emailLower, p);
        }
        // ALWAYS force properties.email so the upsert response echoes it for mapping.
        const upsertInputs = Array.from(leadByEmail.values()).map(p => ({
            email: p.emailLower,
            properties: { ...p.allContactProps, email: p.emailLower },
        }));
        const contactResults = new Map<string, { email: string; contactId: string; isNew: boolean }>();
        // Emails HubSpot rejected as invalid (e.g. a bad TLD that passed our local
        // format check). Collected here and reported as errors after the stage.
        const invalidEmails: string[] = [];

        const upsertOutcome = await splitAndRetry(
            upsertInputs,
            (batch) => this.upsertBatchDroppingInvalid(svc, batch, contactResults, invalidEmails),
            {
                maxBatchSize: 100,
                concurrency: PUSH_BATCH_CONCURRENCY,
                onSplit: (n, e) => console.log(`[HubspotAdapter] batch contact upsert of ${n} failed, splitting: ${this.formatError(e)}`),
            },
        );

        // Map each failed email to a reason (invalid-email drop, or other upsert
        // failure). Keyed by lowercased email to match emailLower below.
        const failureReason = new Map<string, string>();
        for (const f of upsertOutcome.failed) {
            failureReason.set(f.item.email.toLowerCase(), this.formatError(f.error));
        }
        for (const email of invalidEmails) {
            failureReason.set(email.toLowerCase(), 'invalid email (rejected by HubSpot)');
        }

        // Reconcile PER LEAD (not per de-duped email) so successCount + errorCount
        // always equals the number of email leads attempted — every lead is either
        // a success (its email upserted) or an error (its email failed/invalid),
        // counted exactly once. Iterating emailLeads also means leads sharing one
        // email are each counted and (on success) routed into the deal stage.
        const contactIdByLead = new Map<any, string>();      // lead → contactId
        const isNewByLead = new Map<any, boolean>();          // lead → isNew (for demotion)
        const succeededEmailLeads: any[] = [];
        const failedEmailLeads: Array<{ lead: any; reason: string }> = [];
        for (const p of emailLeads) {
            const r = contactResults.get(p.emailLower);
            if (r) {
                result.successCount++;
                if (r.isNew) result.newCount++; else result.updatedCount++;
                contactIdByLead.set(p.lead, r.contactId);
                isNewByLead.set(p.lead, r.isNew);
                succeededEmailLeads.push(p.lead);
            } else {
                result.errorCount++;
                const reason = failureReason.get(p.emailLower) || 'contact upsert failed';
                result.errors.push(`${p.emailLower}: ${reason}`);
                failedEmailLeads.push({ lead: p.lead, reason });
            }
        }

        // ── Stage 3: write back contact ids + synced status BEFORE deals ───────
        const stage3Now = new Date().toISOString();
        await Promise.all([
            ...succeededEmailLeads.map(lead =>
                this.persistSyncMetadata(
                    lead, config.listId,
                    buildSyncedMetadata(lead.syncMetadata, contactIdByLead.get(lead)!, stage3Now),
                )
            ),
            ...failedEmailLeads.map(({ lead, reason }) =>
                this.persistSyncMetadata(lead, config.listId, buildFailedMetadata(lead.syncMetadata, reason))
            ),
        ]);

        // Leads whose contact upserted but a post-upsert stage failed — tracked so
        // each is demoted from success → error exactly once and is not re-processed
        // by a later stage. A lead already failed here is already an error.
        const postUpsertFailedLeads = new Set<any>();
        const demote = (lead: any) => {
            if (postUpsertFailedLeads.has(lead)) return;
            postUpsertFailedLeads.add(lead);
            result.successCount--;
            if (isNewByLead.get(lead)) result.newCount--; else result.updatedCount--;
        };

        // ── Stage 4: deals (only if deal mappings configured) ──────────────────
        if (dealMappings.length > 0 && succeededEmailLeads.length > 0) {
            // A lead's contact synced but its deal failed is NOT a clean success:
            // pushDealsBatched records the error + collects the lead here; demote()
            // drops the earlier success. Counts each lead exactly once.
            const dealFailedLeads = new Set<any>();
            await this.pushDealsBatched(svc, succeededEmailLeads, contactIdByLead, config, result, dealFailedLeads);
            for (const lead of dealFailedLeads) demote(lead);
        }

        // ── Stage 4.5: lifecycle stage two-step (clear → set) ─────────────────
        // HubSpot's forward-only restriction blocks downgrading an existing stage
        // via a single PATCH, so we read each contact's current stage, clear it, then
        // set the target — restoring the original if the set fails, so a contact is
        // never left blank. Skips leads where a per-lead mapping already set
        // lifecyclestage (the upsert applied the explicit value) and leads already
        // failed by the deal stage (already errors — no point updating their stage,
        // and re-counting would double the error). Each remaining lead that doesn't
        // reach the target stage is recorded as an error and demoted.
        if (config.hubspotLifecycleStage && succeededEmailLeads.length > 0) {
            const lifecycleLeads = succeededEmailLeads.filter(
                lead => !perLeadLifecycleSet.has(lead) && !postUpsertFailedLeads.has(lead),
            );
            const lifecycleFailedLeads = new Set<any>();
            await this.applyLifecycleStageBatched(
                svc, lifecycleLeads, contactIdByLead, config.hubspotLifecycleStage, config.listId, result, lifecycleFailedLeads,
            );
            for (const lead of lifecycleFailedLeads) demote(lead);
        }

        // Collect succeeded (non-failed) email-lead contact IDs for post-sync import.
        if (contactIdCollector) {
            for (const lead of succeededEmailLeads) {
                if (!postUpsertFailedLeads.has(lead)) {
                    const id = contactIdByLead.get(lead);
                    if (id) contactIdCollector.add(id);
                }
            }
        }

        // ── Stage 5: email-less leads via per-lead path ────────────────────────
        if (emaillessLeads.length > 0) {
            await this.pushLeadsPerLead(
                svc, emaillessLeads, config, result,
                effectiveCustomMapping, listIdentityProps, resolvedListName, contactIdCollector,
            );
        }

        // ── Stage 6: completion log ────────────────────────────────────────────
        console.log('[HubspotAdapter] batch push complete', {
            listId: config.listId,
            leads: leads.length,
            newCount: result.newCount,
            updatedCount: result.updatedCount,
            errorCount: result.errorCount,
            durationMs: Date.now() - t0,
        });
    }

    /**
     * Upsert one contact batch, but instead of letting an invalid-email 400 fall
     * through to expensive binary-split bisection, parse the offending emails out
     * of HubSpot's error, drop them, and retry the remainder in a single call.
     * HubSpot lists every invalid email per 400, so this normally resolves in one
     * extra call; the loop guards against partial reporting and the no-shrink
     * check prevents any spin. Non-invalid-email failures rethrow so splitAndRetry
     * still bisects them. Dropped emails are recorded in `invalidEmails`.
     */
    private async upsertBatchDroppingInvalid(
        svc: HubSpotService,
        batch: Array<{ email: string; properties: Record<string, string> }>,
        contactResults: Map<string, { email: string; contactId: string; isNew: boolean }>,
        invalidEmails: string[],
    ): Promise<void> {
        let current = batch;
        for (;;) {
            try {
                const res = await svc.batchUpsertContacts(current);
                for (const r of res) contactResults.set(r.email, r);
                return;
            } catch (err: any) {
                const invalid = this.extractInvalidEmails(err);
                if (invalid.length === 0) throw err; // not an invalid-email failure → bisect
                const invalidSet = new Set(invalid);
                const before = current.length;
                current = current.filter(i => !invalidSet.has(i.email.toLowerCase()));
                // Record only those actually present in this batch.
                for (const i of batch) {
                    if (invalidSet.has(i.email.toLowerCase()) && !invalidEmails.includes(i.email)) {
                        invalidEmails.push(i.email);
                    }
                }
                if (current.length === before) throw err; // couldn't drop any → bisect
                if (current.length === 0) return;          // nothing left to send
                // loop: retry the cleaned batch
            }
        }
    }

    /**
     * Extract the email addresses HubSpot flagged as invalid from a 400 batch
     * error. HubSpot embeds them as "Email address <x> is invalid" in the error
     * body; we scan the stringified body so we catch them regardless of nesting.
     */
    private extractInvalidEmails(error: any): string[] {
        if (error?.response?.status !== 400) return [];
        const data = error.response.data;
        const blob = typeof data === 'string' ? data : JSON.stringify(data ?? '');
        const emails = new Set<string>();
        const re = /Email address (\S+) is invalid/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(blob)) !== null) emails.add(m[1].toLowerCase());
        return [...emails];
    }

    /**
     * A deal update that fails because the deal no longer exists surfaces either
     * as a top-level 404 (whole-batch throw) or a 207 Multi-Status per-record
     * OBJECT_NOT_FOUND (HubSpot's partial-failure shape, isolated to size 1 by
     * splitAndRetry). Both mean the same thing: recreate the deal.
     */
    private isDealNotFoundError(error: any): boolean {
        if (error?.response?.status === 404) return true;
        const errs = error?.response?.data?.errors;
        return Array.isArray(errs) && errs.some((e: any) => /NOT_FOUND/i.test(e?.category || ''));
    }

    /**
     * Deal stage of the batched push. Partitions succeeded leads into deal
     * updates (existing hubspot_deal_id) and creates, runs each through the batch
     * APIs via splitAndRetry, reclassifies not-found updates into creates (the
     * deal was deleted in HubSpot — mirrors the per-lead fallback), associates
     * created deals, and writes back hubspot_deal_id.
     */
    private async pushDealsBatched(
        svc: HubSpotService,
        succeededLeads: any[],
        contactIdByLead: Map<any, string>,
        config: ExternalCrmSyncConfig,
        result: SyncResult,
        dealFailedLeads: Set<any>,
    ): Promise<void> {
        interface UpdateItem { lead: any; dealId: string; properties: Record<string, string>; }
        interface CreateItem { lead: any; contactId: string; traceId: string; properties: Record<string, string>; }

        const updateSet: UpdateItem[] = [];
        const createSet: CreateItem[] = [];

        for (const lead of succeededLeads) {
            const dealProps = this.applyHubSpotDealStageMapping(
                this.buildHubSpotProps(lead, config.dealFieldMapping),
                config,
                lead,
            );
            if (Object.keys(dealProps).length === 0) continue;

            const contactId = contactIdByLead.get(lead)!;
            const existingDealId: string | undefined =
                lead.syncMetadata?.hubspot_deal_id || lead.customFields?.hubspot_deal_id;

            if (existingDealId) {
                updateSet.push({ lead, dealId: existingDealId, properties: dealProps });
            } else {
                createSet.push(this.buildDealCreateItem(lead, contactId, dealProps, config));
            }
        }

        // ── Batch UPDATE existing deals ────────────────────────────────────────
        // Leads whose stale deal 404'd and were recreated: their stale dealId must
        // NOT be written back (it would race/clobber the new recreated id).
        const recreatedLeads = new Set<any>();
        if (updateSet.length > 0) {
            const updateOutcome = await splitAndRetry(
                updateSet,
                (batch) => svc.batchUpdateDeals(batch.map(x => ({ dealId: x.dealId, properties: x.properties }))),
                { maxBatchSize: 100, concurrency: PUSH_BATCH_CONCURRENCY },
            );
            for (const f of updateOutcome.failed) {
                if (this.isDealNotFoundError(f.error)) {
                    // Deal was deleted in HubSpot — recreate it (mirror per-lead fallback).
                    const item = f.item;
                    recreatedLeads.add(item.lead);
                    const dealProps = this.applyHubSpotDealStageMapping(
                        this.buildHubSpotProps(item.lead, config.dealFieldMapping),
                        config,
                        item.lead,
                    );
                    createSet.push(this.buildDealCreateItem(
                        item.lead, contactIdByLead.get(item.lead)!, dealProps, config,
                    ));
                    console.log(`[HubspotAdapter] deal ${item.dealId} gone (404), recreating for lead=${item.lead.email || item.lead.leadId}`);
                } else {
                    result.errorCount++;
                    result.errors.push(`${f.item.lead.email || f.item.lead.leadId}: ${this.formatError(f.error)}`);
                    dealFailedLeads.add(f.item.lead);
                }
            }
        }

        // ── Batch CREATE new deals ─────────────────────────────────────────────
        const dealIdByTrace = new Map<string, string>();
        if (createSet.length > 0) {
            const createOutcome = await splitAndRetry(
                createSet,
                async (batch) => {
                    const res = await svc.batchCreateDeals(batch.map(x => ({ traceId: x.traceId, properties: x.properties })));
                    for (const r of res) dealIdByTrace.set(r.traceId, r.dealId);
                },
                { maxBatchSize: 100, concurrency: PUSH_BATCH_CONCURRENCY },
            );
            for (const f of createOutcome.failed) {
                result.errorCount++;
                result.errors.push(`${f.item.lead.email || f.item.lead.leadId}: ${this.formatError(f.error)}`);
                dealFailedLeads.add(f.item.lead);
            }
        }

        // ── Associate created deals to their contacts ──────────────────────────
        // Map each created deal back to its lead so an association failure can
        // demote the right lead.
        const leadByDealId = new Map<string, any>();
        for (const item of createSet) {
            const dealId = dealIdByTrace.get(item.traceId);
            if (dealId) leadByDealId.set(dealId, item.lead);
        }
        const pairs = createSet
            .filter(item => dealIdByTrace.has(item.traceId))
            .map(item => ({ contactId: item.contactId, dealId: dealIdByTrace.get(item.traceId)! }));
        if (pairs.length > 0) {
            const assocOutcome = await splitAndRetry(
                pairs,
                (batch) => svc.batchAssociateContactsToDeals(batch),
                { maxBatchSize: 100, concurrency: PUSH_BATCH_CONCURRENCY },
            );
            for (const f of assocOutcome.failed) {
                result.errorCount++;
                result.errors.push(`deal ${f.item.dealId}: ${this.formatError(f.error)}`);
                const lead = leadByDealId.get(f.item.dealId);
                if (lead) dealFailedLeads.add(lead);
            }
        }

        // ── Write back hubspot_deal_id (created by trace + updated) ─────────────
        const writebacks: Array<Promise<any>> = [];
        for (const item of createSet) {
            const dealId = dealIdByTrace.get(item.traceId);
            if (!dealId) continue;
            writebacks.push(this.writebackDealId(item.lead, dealId, config));
        }
        for (const item of updateSet) {
            // Skip leads whose stale deal 404'd and was recreated above — writing
            // back the stale dealId would clobber the new recreated id.
            if (recreatedLeads.has(item.lead)) continue;
            writebacks.push(this.writebackDealId(item.lead, item.dealId, config));
        }
        await Promise.all(writebacks);
    }

    /**
     * Applies a target lifecycle stage to a set of already-upserted contacts using
     * the clear→set two-step that overcomes HubSpot's forward-only restriction
     * (a single PATCH can't move a contact to an earlier stage).
     *
     * Per contact, working in 100-id chunks (the batch limit):
     *   1. READ the contact's current lifecyclestage (so a failed set can be rolled
     *      back, and so we can skip contacts already at the target — making a
     *      re-push nearly free and avoiding needless writes).
     *   2. SKIP contacts already at the target.
     *   3. CLEAR the stage (set to '').
     *   4. SET the target stage.
     *   5. If SET fails, best-effort RESTORE the original stage so the contact is
     *      never left blank, and mark the lead failed.
     *
     * There is NO cross-call transaction in HubSpot, so this is best-effort: a
     * contact that fails the set (and possibly the restore) is recorded in
     * `failedLeads` + as an error + flagged in syncMetadata, and is healed on the
     * next push (the stage is re-applied every push). failedLeads excludes leads
     * whose stage was already correct or successfully set.
     *
     * Failures are isolated per contact-id via splitAndRetry (mirrors the deal
     * stage), so one bad id never fails a whole chunk. Each step's 429s are
     * absorbed by the service's built-in retry interceptor.
     */
    private async applyLifecycleStageBatched(
        svc: HubSpotService,
        leads: any[],
        contactIdByLead: Map<any, string>,
        targetStage: string,
        listId: string,
        result: SyncResult,
        failedLeads: Set<any>,
    ): Promise<void> {
        if (leads.length === 0) return;

        // Multiple leads can share one contact id (same email). Operate on unique
        // ids; map each id back to all its leads so a per-id failure fails them all.
        const leadsByContactId = new Map<string, any[]>();
        for (const lead of leads) {
            const id = contactIdByLead.get(lead);
            if (!id) continue; // defensive: only succeeded-upsert leads reach here
            const arr = leadsByContactId.get(id);
            if (arr) arr.push(lead); else leadsByContactId.set(id, [lead]);
        }
        const allIds = Array.from(leadsByContactId.keys());
        if (allIds.length === 0) return;

        // ── Step 1: read current stages so we can skip-if-correct and restore-on-fail.
        const originalStages = await svc.getContactLifecycleStages(allIds);

        // ── Step 2: only act on ids NOT already at the target stage.
        const idsToUpdate = allIds.filter(id => originalStages.get(id) !== targetStage);
        if (idsToUpdate.length === 0) return;

        // Record a per-id failure: mark every lead on that contact failed (once),
        // add one error line, and persist failed metadata while PRESERVING the
        // contact id (the upsert did succeed — only the stage didn't take).
        const failPersists: Array<Promise<void>> = [];
        const markIdFailed = (id: string, reason: string) => {
            for (const lead of leadsByContactId.get(id) ?? []) {
                if (failedLeads.has(lead)) continue;
                failedLeads.add(lead);
                result.errorCount++;
                result.errors.push(`${lead.email || lead.leadId}: lifecycle stage not set — ${reason}`);
                failPersists.push(
                    this.persistSyncMetadata(
                        lead, listId,
                        buildFailedMetadata(lead.syncMetadata, `lifecycle stage not set — ${reason}`),
                    ),
                );
            }
        };

        for (let i = 0; i < idsToUpdate.length; i += 100) {
            const chunk = idsToUpdate.slice(i, i + 100);

            // ── Step 3: CLEAR. A clear failure leaves the contact at its original
            // stage (no change) — record the failure and skip set/restore for it.
            const clearedIds = new Set<string>();
            const clearOutcome = await splitAndRetry(
                chunk,
                async (ids) => {
                    await svc.batchUpdateContacts(ids.map(id => ({ id, properties: { lifecyclestage: '' } })));
                    for (const id of ids) clearedIds.add(id);
                },
                { maxBatchSize: 100, concurrency: PUSH_BATCH_CONCURRENCY },
            );
            for (const f of clearOutcome.failed) {
                markIdFailed(f.item, `clear failed: ${this.formatError(f.error)}`);
            }

            // ── Step 4: SET the target stage on the cleared ids.
            const setTargets = chunk.filter(id => clearedIds.has(id));
            if (setTargets.length === 0) continue;
            const setFailedIds = new Set<string>();
            const setOutcome = await splitAndRetry(
                setTargets,
                (ids) => svc.batchUpdateContacts(ids.map(id => ({ id, properties: { lifecyclestage: targetStage } }))),
                { maxBatchSize: 100, concurrency: PUSH_BATCH_CONCURRENCY },
            );
            for (const f of setOutcome.failed) setFailedIds.add(f.item);

            // ── Step 5: RESTORE the original stage for ids whose set failed, so the
            // contact isn't left blank. Best-effort: a restore that also fails just
            // leaves the contact blank until the next push re-applies the stage.
            // Only restore ids that HAD a non-empty original (else '' is already the
            // current cleared state — nothing to restore).
            if (setFailedIds.size > 0) {
                const restoreInputs = Array.from(setFailedIds)
                    .filter(id => (originalStages.get(id) ?? '') !== '')
                    .map(id => ({ id, properties: { lifecyclestage: originalStages.get(id)! } }));
                if (restoreInputs.length > 0) {
                    await splitAndRetry(
                        restoreInputs,
                        (batch) => svc.batchUpdateContacts(batch),
                        { maxBatchSize: 100, concurrency: PUSH_BATCH_CONCURRENCY },
                    ).catch(() => { /* best-effort; failure leaves contact blank, healed next push */ });
                }
                for (const id of setFailedIds) {
                    const orig = originalStages.get(id) ?? '';
                    markIdFailed(id, orig ? `set failed, restored prior stage "${orig}"` : 'set failed');
                }
            }
        }

        await Promise.all(failPersists);
    }

    /**
     * Single-contact version of the lifecycle-stage two-step (used by the per-lead
     * path). Reads the current stage, skips if already at the target, else
     * clear→set, and restores the original stage if the set fails so the contact is
     * never left blank.
     *
     * Returns { ok: true } when the contact ends at the target stage (or already
     * was), or { ok: false, reason } when it does not — the caller treats that lead
     * as a failure. Best-effort: HubSpot has no cross-call transaction, so a failed
     * set (and possibly a failed restore) is healed on the next push.
     */
    private async applyLifecycleStageSingle(
        svc: HubSpotService,
        contactId: string,
        targetStage: string,
    ): Promise<{ ok: true } | { ok: false; reason: string }> {
        // Read current stage: skip-if-correct (cheap re-pushes) and enable restore.
        let original = '';
        try {
            const props = await svc.getContactById(contactId, ['lifecyclestage']);
            original = String(props.lifecyclestage ?? '');
        } catch (err: any) {
            // A read failure is non-fatal: fall through and attempt the two-step
            // with an unknown original (restore simply won't have a value to write).
            console.warn(`[HubspotAdapter] could not read lifecyclestage for contact ${contactId}: ${this.formatError(err)}`);
        }
        if (original === targetStage) return { ok: true };

        // CLEAR. If it fails the contact is unchanged (still at original) — report.
        try {
            await svc.updateContact(contactId, { customFields: { lifecyclestage: '' } });
        } catch (err: any) {
            return { ok: false, reason: `clear failed: ${this.formatError(err)}` };
        }

        // SET the target. On failure, best-effort restore the prior stage.
        try {
            await svc.updateContact(contactId, { customFields: { lifecyclestage: targetStage } });
            return { ok: true };
        } catch (err: any) {
            const reason = this.formatError(err);
            if (original) {
                try {
                    await svc.updateContact(contactId, { customFields: { lifecyclestage: original } });
                    return { ok: false, reason: `set failed, restored prior stage "${original}": ${reason}` };
                } catch {
                    // Restore also failed — contact left blank, healed next push.
                }
            }
            return { ok: false, reason: `set failed: ${reason}` };
        }
    }

    /**
     * Builds a deal-create item with a guaranteed dealname (falling back to
     * buildDealName) and the configured pipeline injected — mirrors syncDeal.
     */
    private buildDealCreateItem(
        lead: any,
        contactId: string,
        dealProps: Record<string, string>,
        config: ExternalCrmSyncConfig,
    ): { lead: any; contactId: string; traceId: string; properties: Record<string, string> } {
        let propsWithName = dealProps.dealname
            ? dealProps
            : { ...dealProps, dealname: this.buildDealName(lead) };
        if (config.externalPipelineId) {
            propsWithName = { ...propsWithName, pipeline: config.externalPipelineId };
        }
        return { lead, contactId, traceId: lead.leadId, properties: propsWithName };
    }

    /**
     * Persist a syncMetadata map for a lead AND update the in-memory lead so
     * later writebacks in the SAME push spread the latest value instead of a
     * stale snapshot (updateLead replaces the whole map). Non-critical: logs on
     * failure, never throws.
     */
    private async persistSyncMetadata(lead: any, listId: string, meta: Record<string, any>): Promise<void> {
        lead.syncMetadata = meta;
        await crmDb.updateLead(lead.listId || listId, lead.leadId, { syncMetadata: meta })
            .catch((err: any) => {
                console.error(`[HubspotAdapter] failed to persist syncMetadata for ${lead.email || lead.leadId}: ${this.formatError(err)}`);
            });
    }

    /** Persists hubspot_deal_id back to our DB (non-critical, logs on failure). */
    private writebackDealId(lead: any, dealId: string, config: ExternalCrmSyncConfig): Promise<any> {
        // Merge onto the latest in-memory syncMetadata (set by Stage 3's synced
        // writeback) so we don't clobber hubspot_contact_id / syncStatus.
        return this.persistSyncMetadata(lead, config.listId, {
            ...(lead.syncMetadata || {}),
            hubspot_deal_id: dealId,
        });
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

                leadData.customFields = customFields;
                if (Object.keys(syncMetadata).length > 0) leadData.syncMetadata = syncMetadata;
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
                // Include the configured pipeline on update too (not just create) so an
                // existing deal MOVES when the list's pipeline changes. The stage-mapped
                // dealstage in dealProps is valid for that pipeline (stage map is rebuilt
                // for the pipeline before the push), satisfying HubSpot's rule that a
                // deal's stage must belong to its pipeline.
                const updateProps = config.externalPipelineId
                    ? { ...dealProps, pipeline: config.externalPipelineId }
                    : dealProps;
                await svc.updateDeal(existingDealId, updateProps);
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
     * Returns the custom mapping with the system list-identity mappings
     * (listName/listId) appended for any agentwebField the config doesn't already
     * define. An existing entry — whether the user re-mapped its CRM property or
     * disabled it — is left untouched so explicit configuration always wins.
     * Lets lists connected before this feature shipped sync listName/listId
     * without a manual re-save.
     */
    private withListIdentityMappings(customMapping: FieldMapping[]): FieldMapping[] {
        const present = new Set(customMapping.map(m => m.agentwebField));
        const missing = HUBSPOT_LIST_IDENTITY_MAPPING.filter(m => !present.has(m.agentwebField));
        return missing.length > 0 ? [...customMapping, ...missing] : customMapping;
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

        const mappedStageValue = config.hubspotDealStageMap?.[stageValue];
        if (mappedStageValue === undefined) {
            // No mapping for this AgentWeb status → DON'T send the raw value as a
            // dealstage; HubSpot rejects unknown stages with INVALID_OPTION and
            // fails the whole deal. Omit it so the deal syncs on the pipeline's
            // default stage instead.
            const { dealstage, ...rest } = dealProps;
            console.log(`[HubspotAdapter] no dealstage mapping for status "${stageValue}", omitting dealstage for lead=${lead.email || lead.leadId}`);
            return rest;
        }
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
        const custom: Record<string, string> = {};
        for (const [k, v] of Object.entries(props)) {
            if (!HubspotAdapter.STANDARD_CONTACT_PROPS.has(k.toLowerCase())) custom[k] = v;
        }
        return Object.keys(custom).length > 0 ? custom : undefined;
    }

    private buildDealName(lead: any): string {
        const name = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.email || 'Unknown';
        return `${name} - Deal`;
    }

}
