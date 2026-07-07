/**
 * Tests for installWorkerSignalGuards.
 *
 * Regression coverage for ENG-202: scheduled runs crashing with "Worker process
 * exited with code null and signal SIGTERM" and zero assistant output. The LLM
 * worker is a forked child that shares the parent's process group, so a SIGTERM
 * broadcast to the group (EB instance termination, deploy, autoscaling
 * replacement) was killing the worker instantly mid-run — long before the
 * parent's graceful drain could let the in-flight scheduled run finish.
 *
 * The guard makes the worker IGNORE SIGTERM/SIGINT (the parent orchestrates
 * shutdown via a drain + explicit SIGKILL) while still exiting if the parent
 * process disappears (IPC 'disconnect') so it can never linger as an orphan.
 */

import { EventEmitter } from 'events';
import { installWorkerSignalGuards } from '../workers/workerSignalGuards';

function makeFakeProcess(): NodeJS.Process & { exit: jest.Mock } {
  const emitter = new EventEmitter() as any;
  emitter.exit = jest.fn();
  return emitter;
}

describe('installWorkerSignalGuards', () => {
  it('does NOT exit the worker when a SIGTERM reaches the process group', () => {
    const proc = makeFakeProcess();
    installWorkerSignalGuards(proc);

    proc.emit('SIGTERM');

    // The whole point: a group-broadcast SIGTERM must not abort an in-flight run.
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('does NOT exit the worker when a SIGINT reaches the process group', () => {
    const proc = makeFakeProcess();
    installWorkerSignalGuards(proc);

    proc.emit('SIGINT');

    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('exits cleanly when the parent IPC channel disconnects (orphan safety)', () => {
    const proc = makeFakeProcess();
    installWorkerSignalGuards(proc);

    proc.emit('disconnect');

    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('registers SIGTERM, SIGINT and disconnect listeners exactly once', () => {
    const proc = makeFakeProcess();
    installWorkerSignalGuards(proc);

    expect(proc.listenerCount('SIGTERM')).toBe(1);
    expect(proc.listenerCount('SIGINT')).toBe(1);
    expect(proc.listenerCount('disconnect')).toBe(1);
  });

  it('defaults to the real process when none is supplied', () => {
    // Should not throw when wiring guards onto the live process object.
    expect(() => installWorkerSignalGuards()).not.toThrow();

    // Clean up the listeners we just attached so we do not leak across tests.
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('disconnect');
  });
});
