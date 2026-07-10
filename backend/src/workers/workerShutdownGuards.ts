/**
 * Guard a forked LLM worker against the raw SIGTERM/SIGINT the OS delivers to the
 * whole process group / cgroup during a graceful shutdown or deploy.
 *
 * The parent process (server.ts) orchestrates shutdown: on SIGTERM it disables cron,
 * stops accepting connections, and DRAINS in-flight worker requests (up to
 * DRAIN_CEILING_MS) so scheduled chats / EMMA runs can finish naturally, and only
 * then force-kills the worker. But the worker is a forked child that sits in the same
 * process group / cgroup, so it receives that SIGTERM at the same instant as the
 * parent. With Node's default signal handling the worker would terminate immediately,
 * aborting the in-flight generation before the drain could let it complete — the root
 * cause of dead scheduled runs recorded as "Worker process exited with code null and
 * signal SIGTERM" with zero assistant messages (ENG-201).
 *
 * We therefore IGNORE SIGTERM/SIGINT inside the worker and let the parent be the sole
 * authority on when the worker dies: after draining it sends SIGKILL (which cannot be
 * caught). To avoid orphaning the worker if the parent ever vanishes without killing
 * it, we exit promptly when the IPC channel to the parent disconnects.
 */
export function installWorkerShutdownGuards(proc: NodeJS.Process = process): void {
  const ignore = (signal: string) => {
    console.log(
      `[Worker] Ignoring ${signal} — parent orchestrates graceful shutdown by draining ` +
      `in-flight requests before force-killing the worker`
    );
  };

  proc.on('SIGTERM', () => ignore('SIGTERM'));
  proc.on('SIGINT', () => ignore('SIGINT'));

  // If the parent process goes away (normal exit after draining, or a crash), the IPC
  // channel disconnects — exit so we never linger as an orphaned worker.
  proc.once('disconnect', () => {
    console.log('[Worker] Parent process disconnected — exiting');
    proc.exit(0);
  });
}
