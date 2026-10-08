import { cronJobRegistry } from "./cronJobRegistry";

/**
 * Launch a fire-and-forget background run that graceful shutdown waits for AND
 * whose crash is still logged.
 *
 * `cronJobRegistry.track()` attaches its own rejection handlers to the promise,
 * which also stops Node from raising `unhandledRejection` for it. So a bare
 * `void cronJobRegistry.track(...)` turns a crashed run from a logged
 * "Unhandled Rejection" into complete silence, leaving the axis `running` with
 * no trace. This logs the rejection instead.
 */
export function trackBackgroundRun(name: string, run: Promise<unknown>): void {
  void cronJobRegistry.track(name, Promise.resolve(run)).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[${name}] background run crashed`, err);
  });
}
