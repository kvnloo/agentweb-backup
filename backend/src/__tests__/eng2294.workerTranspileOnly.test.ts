import path from 'path';
import { resolveWorkerLaunch } from '../services/generateMarketingResponseWorkerService';

describe('ENG-2294 marketing worker launch args', () => {
  const dir = '/repo/backend/src/services';

  it('dev mode loads ts-node in transpile-only mode so type errors cannot crash the worker', () => {
    const { workerScript, execArgv } = resolveWorkerLaunch(dir, true);
    expect(workerScript).toBe(path.join(dir, '../workers/generateMarketingResponseWorker.ts'));
    expect(execArgv).toEqual(['-r', 'ts-node/register/transpile-only', '--max-old-space-size=4096']);
    expect(require.resolve('ts-node/register/transpile-only')).toBeTruthy();
  });

  it('deployed (dist) mode is unchanged: compiled JS, no ts-node', () => {
    const { workerScript, execArgv } = resolveWorkerLaunch('/app/dist/services', false);
    expect(workerScript).toBe(path.join('/app/dist/services', '../workers/generateMarketingResponseWorker.js'));
    expect(execArgv).toEqual(['--max-old-space-size=4096']);
  });
});
