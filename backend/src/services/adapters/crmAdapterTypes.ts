import { ExternalCrmSyncConfig, SyncResult } from '../externalCrmSyncService';

/**
 * Flexible authentication for CRM integrations.
 * - oauth: uses a connected account (DB lookup → access token)
 * - token: a raw, decrypted API key passed directly
 */
export type CrmAuth =
    | { type: 'oauth'; userId: string; accountId: string }
    | { type: 'token'; apiKey: string };

/**
 * Common interface every CRM adapter must implement.
 * ExternalCrmSyncService calls these methods and knows nothing
 * about the underlying CRM API details.
 */
export interface CrmAdapter {
    /** Verify that the provided credentials can reach the CRM */
    testConnection(auth: CrmAuth): Promise<{ valid: boolean; error?: string }>;

    /** Push internal leads to the external CRM */
    pushLeads(
        auth: CrmAuth,
        leads: any[],
        config: ExternalCrmSyncConfig
    ): Promise<SyncResult>;

    /** Pull external contacts back into our list */
    pullContacts(
        auth: CrmAuth,
        listId: string,
        config: ExternalCrmSyncConfig
    ): Promise<SyncResult>;

    /**
     * Delete a lead's record(s) from the CRM.
     * externalIds contains the CRM-side IDs to delete (e.g. contactId, dealId for HubSpot).
     * Optional — only adapters that support deletion need to implement this.
     */
    deleteRecord?(
        auth: CrmAuth,
        externalIds: { contactId?: string; dealId?: string; recordId?: string },
        config: ExternalCrmSyncConfig
    ): Promise<void>;
}
