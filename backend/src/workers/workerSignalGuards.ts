/**
 * Signal guards for the generateMarketingResponse worker process.
 *
 * The worker is a forked child that, by default, shares its parent's process
 * group. When the platform terminates the instance (Elastic Beanstalk deploy,
 * autoscaling replacement, health-check restart) it broadcasts SIGTERM to the
 * whole group, so the worker used to receive SIGTERM directly and — with no
 * handler installed — Node's default action killed it instantly, mid-run. Any
 * scheduled chat that happened to be in flight died with "Worker process exited
 * with code null and signal SIGTERM" and zero persisted assistant messages
 * (ENG-202), even though the parent's graceful drain would gladly have waited
 * for it to finish.
 *
 * The fix: the worker IGNORES SIGTERM/SIGINT. Its lifecycle is owned entirely by
 * the parent, which drains in-flight requests and then issues an explicit
 * SIGKILL (see GenerateMarketingResponseWorkerService.shutdown). Ignoring the
 * racing group-signal lets the in-flight run complete during that drain instead
 * of being aborted. As an orphan-safety net, the worker still exits if the IPC
 * channel to the parent closes ('disconnect') — at that point there is no parent
 * left to orchestrate shutdown, so lingering would leak a process.
 */
export function installWorkerSignalGuards(proc: NodeJS.Process = process): void {
  const ignore = (signal: string) => {
    console.log(
      `[Worker] Ignoring ${signal} — parent orchestrates graceful shutdown (drain + SIGKILL)`
    );
  };

  proc.on('SIGTERM', () => ignore('SIGTERM'));
  proc.on('SIGINT', () => ignore('SIGINT'));

  proc.on('disconnect', () => {
    console.log('[Worker] Parent IPC channel disconnected — exiting to avoid orphan');
    proc.exit(0);
  });
}
