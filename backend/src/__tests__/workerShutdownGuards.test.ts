/**
 * Tests for installWorkerShutdownGuards.
 *
 * Regression coverage for ENG-201: a forked LLM worker must NOT die on the raw
 * SIGTERM/SIGINT that the OS delivers to the whole process group / cgroup during
 * a graceful shutdown or deploy. If it did, the in-flight scheduled run would be
 * aborted mid-generation before the parent's drain could let it finish — producing
 * a dead session with zero assistant messages and the error
 * "Worker process exited with code null and signal SIGTERM".
 *
 * The parent orchestrates shutdown: it drains in-flight requests, then force-kills
 * the worker with SIGKILL. The worker only exits on its own when the IPC channel to
 * the parent disconnects (so a crashed parent can never orphan it).
 */

import { EventEmitter } from 'events';
import { installWorkerShutdownGuards } from '../workers/workerShutdownGuards';

type FakeProc = EventEmitter & { exit: jest.Mock };

function makeFakeProc(): FakeProc {
  const emitter = new EventEmitter() as FakeProc;
  emitter.exit = jest.fn();
  return emitter;
}

describe('installWorkerShutdownGuards', () => {
  let proc: FakeProc;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    proc = makeFakeProc();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('ignores SIGTERM — does not exit the worker (drain must not be defeated)', () => {
    installWorkerShutdownGuards(proc as any);
    expect(proc.listenerCount('SIGTERM')).toBe(1);

    proc.emit('SIGTERM');

    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('ignores SIGINT — does not exit the worker', () => {
    installWorkerShutdownGuards(proc as any);
    expect(proc.listenerCount('SIGINT')).toBe(1);

    proc.emit('SIGINT');

    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('exits cleanly when the parent disconnects (no orphaned worker)', () => {
    installWorkerShutdownGuards(proc as any);
    expect(proc.listenerCount('disconnect')).toBe(1);

    proc.emit('disconnect');

    expect(proc.exit).toHaveBeenCalledWith(0);
  });

  it('survives repeated SIGTERM/SIGINT but still exits on disconnect', () => {
    installWorkerShutdownGuards(proc as any);

    proc.emit('SIGTERM');
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    expect(proc.exit).not.toHaveBeenCalled();

    proc.emit('disconnect');
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(0);
  });
});
