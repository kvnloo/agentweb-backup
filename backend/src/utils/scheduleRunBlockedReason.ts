/**
 * ENG-1131: recorded on a run result whose LinkedIn people-search was proven
 * unavailable for the account (the ENG-975 control-query guard fired). The run
 * itself may well have "succeeded" — produced a report, updated the CRM — while
 * sourcing zero prospects for a reason that has nothing to do with the filters.
 *
 * Lives in its own file (not `agentModeController.ts`, where the detector is)
 * because `emailService.ts` also needs it for the scheduled-run/daily-digest
 * emails, and `agentModeController.ts` already imports `emailService` — putting
 * the constant there would create a circular import.
 */
export const LINKEDIN_SEARCH_OUTAGE_BLOCK_REASON = 'linkedin_search_unavailable';
