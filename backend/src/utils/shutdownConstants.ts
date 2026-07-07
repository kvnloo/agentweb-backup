/**
 * Shared timing constants for graceful-shutdown drains.
 * Both generateMarketingResponseWorkerService and cronJobRegistry poll
 * against these so their ceilings can't drift independently, and
 * server.ts derives its force-exit backstop from DRAIN_CEILING_MS.
 */

export const DRAIN_CEILING_MS = 10 * 60 * 1000; // 10 minutes
export const DRAIN_POLL_INTERVAL_MS = 2000; // 2 seconds
