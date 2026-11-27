/**
 * ENG-2840 (W2-7): limits on lead events written by outside agents through the MCP tool `add_lead_engagement` (route
 * `POST /api/emma/add-lead-engagement`). Emma's own tool and the portal are not limited by these.
 *
 * A lead's events live inside the lead's own DynamoDB item, which cannot exceed 400 KB; when it is full, every other writer on that lead
 * (provider webhooks, status changes) fails too. So an outside agent may add at most MCP_ENGAGEMENTS_PER_LEAD events to one lead (each is
 * at most about 2 KB, so about 100 KB in all), and none to a lead whose stored record is already MCP_ENGAGEMENT_MAX_LEAD_BYTES or more.
 */
export const MCP_ENGAGEMENTS_PER_LEAD = 50;
export const MCP_ENGAGEMENT_MAX_LEAD_BYTES = 300_000;

/** ENG-2840 (W2-7): the longest note kept on a pipeline status change (`status_note` of the MCP `manage_leads update`, `statusNote` of the lead update route). */
export const STATUS_NOTE_MAX_CHARS = 500;
