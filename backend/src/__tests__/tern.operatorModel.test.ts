import {
  confirmationMatches, displayOperatorJson, safeArtifactUrl, safeText,
  OperatorView,
} from '../tern/operatorModel';

describe('Tern operator redaction and explicit confirmation', () => {
  const running: OperatorView = {
    scope: 'executions',
    tasks: [{ taskId: 'task-1', name: 'Report', status: 'active' }],
    taskId: 'task-1',
    executions: [{ taskId: 'task-1', executionId: 'e-1', status: 'running' }],
    executionId: 'e-1',
    detail: { taskId: 'task-1', executionId: 'e-1', status: 'running' },
  };

  it('never serializes signed URLs or file bearer tokens into JSON projection', () => {
    expect(safeArtifactUrl('https://cdn.example/file?X-Amz-Signature=key')).toBeUndefined();
    expect(safeArtifactUrl('https://user:password@cdn.example/file')).toBeUndefined();
    expect(safeArtifactUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeArtifactUrl('https://cdn.example/file')).toBe('https://cdn.example/file');
    const view: OperatorView = {
      ...running,
      detail: {
        ...running.detail!,
        result: 'Authorization: Bearer abc123',
        error: 'secret=abc123',
        result_files: [
          { filename: 'result.html', url: 'https://cdn.example/file?token=abc', token: 'abc' },
        ],
      },
    };
    const output = JSON.stringify(displayOperatorJson(view));
    expect(output).toContain('result.html');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('token=abc');
    expect(output).not.toContain('"token"');
  });

  it('bounds and redacts display text', () => {
    expect(safeText('Bearer example-token')).toBe('Bearer [redacted]');
    expect(safeText('password=supersecret')).toBe('[redacted]');
    expect(safeText('a'.repeat(100), 20)).toHaveLength(21);
  });

  it('blocks stale, retargeted and already-completed stop requests', () => {
    const stop = { kind: 'stop' as const, taskId: 'task-1', executionId: 'e-1' };
    expect(confirmationMatches(running, stop)).toBe(true);
    expect(confirmationMatches({ ...running, busy: true }, stop)).toBe(false);
    expect(confirmationMatches({ ...running, executionId: 'e-2' }, stop)).toBe(false);
    expect(confirmationMatches({
      ...running, detail: { ...running.detail!, status: 'completed' },
    }, stop)).toBe(false);
    expect(confirmationMatches(running, { ...stop, taskId: 'another-task' })).toBe(false);
  });

  it('permits a run only against the selected known task, never a foreign id', () => {
    const run = { kind: 'run' as const, taskId: 'task-1' };
    expect(confirmationMatches(running, run)).toBe(true);
    expect(confirmationMatches(running, { ...run, taskId: 'task-2' })).toBe(false);
  });
});
