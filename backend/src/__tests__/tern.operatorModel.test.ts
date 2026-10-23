import {
  applyNativeConfirmationEvent, confirmationMatches, displayOperatorJson, elapsedExecution,
  operatorConfirmNodeId, operatorPortalPath, parseOperatorBrowserLogHtml,
  safeArtifactUrl, safeOperatorPortalUrl, safeText, OperatorView,
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
    const token = 'm0n1p2q3r4s5t6u7v8w9';
    const capability = 'https://bucket.s3.amazonaws.com/task_results/e-1/' + token + '/result.html';
    expect(safeArtifactUrl(capability)).toBeUndefined();
    expect(safeArtifactUrl(capability.replace('task_results', 'task%5Fresults'))).toBeUndefined();
    expect(safeArtifactUrl('https://cdn.example/file', token)).toBeUndefined();
    const view: OperatorView = {
      ...running,
      detail: {
        ...running.detail!,
        result: 'Authorization: Bearer abc123',
        error: 'secret=abc123',
        result_files: [
          { filename: 'result.html', url: capability, token },
          { filename: 'private.html', url: 'https://cdn.example/file?token=abc', token: 'abc' },
          { filename: 'public.html', url: 'https://cdn.example/file' },
        ],
      },
    };
    const output = JSON.stringify(displayOperatorJson(view));
    expect(output).toContain('result.html');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('token=abc');
    expect(output).not.toContain(token);
    expect(output).not.toContain('task_results/e-1');
    expect(output).toContain('https://cdn.example/file');
    expect(output).toContain('/tasks/task-1/executions/e-1');
    expect(output).not.toContain('"token"');
  });

  it('bounds and redacts display text', () => {
    expect(safeText('Bearer example-token')).toBe('Bearer [redacted]');
    expect(safeText('password=supersecret')).toBe('[redacted]');
    expect(safeText('a'.repeat(100), 20)).toHaveLength(21);
  });

  it('blocks stale, retargeted and already-completed stop requests', () => {
    const stop = { kind: 'stop' as const, taskId: 'task-1', executionId: 'e-1',
      taskName: 'Report', generation: 1, surfaceId: 'agentweb-operator' };
    expect(confirmationMatches(running, stop)).toBe(true);
    expect(confirmationMatches({ ...running, busy: true }, stop)).toBe(false);
    expect(confirmationMatches({ ...running, executionId: 'e-2' }, stop)).toBe(false);
    expect(confirmationMatches({
      ...running, detail: { ...running.detail!, status: 'completed' },
    }, stop)).toBe(false);
    expect(confirmationMatches(running, { ...stop, taskId: 'another-task' })).toBe(false);
  });

  it('builds only credential-free references to the existing authenticated portal route', () => {
    expect(operatorPortalPath('task/a', 'run:b')).toBe('/tasks/task%2Fa/executions/run%3Ab');
    expect(safeOperatorPortalUrl('https://portal.example/', 'task-1', 'e-1'))
      .toBe('https://portal.example/tasks/task-1/executions/e-1');
    for (const base of [
      'https://user:secret@portal.example/',
      'https://portal.example/?token=credential',
      'https://portal.example/private/capability',
      'javascript:alert(1)',
    ]) expect(safeOperatorPortalUrl(base, 'task-1', 'e-1')).toBeUndefined();
  });

  it('rejects stale A native events after closing A and opening B, mutating B once only', () => {
    const view: OperatorView = {
      scope: 'executions',
      tasks: [
        { taskId: 'task-A', name: 'Alpha', status: 'active' },
        { taskId: 'task-B', name: 'Beta', status: 'active' },
      ],
      taskId: 'task-A',
      executions: [{ taskId: 'task-A', executionId: 'run-A', status: 'running' }],
      executionId: 'run-A',
      detail: { taskId: 'task-A', executionId: 'run-A', status: 'running' },
    };
    const a = { kind: 'stop' as const, taskId: 'task-A', taskName: 'Alpha',
      executionId: 'run-A', generation: 41, surfaceId: 'agentweb-operator' };
    const b = { kind: 'stop' as const, taskId: 'task-B', taskName: 'Beta',
      executionId: 'run-B', generation: 42, surfaceId: 'agentweb-operator' };
    const mutations: Array<{ taskId: string; executionId?: string }> = [];
    const feed = (event: { id: string; ev: string; item?: string; act?: string; sf?: string }) => {
      const decision = applyNativeConfirmationEvent(view, event, 'agentweb-operator');
      if (decision === 'cancel') {
        view.confirm = undefined;
        view.confirmSelected = undefined;
      } else if (decision === 'submit' && view.confirm) {
        mutations.push({ taskId: view.confirm.taskId, executionId: view.confirm.executionId });
        view.busy = true;
        view.confirm = undefined; // mirrors the CLI's synchronous submission guard
      }
      return decision;
    };
    view.confirm = a;
    view.confirmSelected = 'cancel';
    expect(feed({ id: operatorConfirmNodeId(a), ev: 'action', act: 'cancel' })).toBe('cancel');
    view.taskId = 'task-B';
    view.executionId = 'run-B';
    view.executions = [{ taskId: 'task-B', executionId: 'run-B', status: 'running' }];
    view.detail = { taskId: 'task-B', executionId: 'run-B', status: 'running' };
    view.confirm = b;
    view.confirmSelected = 'cancel';
    for (const event of [
      { id: operatorConfirmNodeId(a), ev: 'select', item: 'confirm' },
      { id: operatorConfirmNodeId(a), ev: 'activate', item: 'confirm' },
      { id: operatorConfirmNodeId(a), ev: 'action', act: 'confirm' },
    ]) expect(feed(event)).toBe('ignored');
    expect(feed({ id: operatorConfirmNodeId(b), sf: 'prior-surface', ev: 'action', act: 'confirm' }))
      .toBe('ignored');
    expect(view.confirmSelected).toBe('cancel');
    expect(mutations).toHaveLength(0);
    expect(feed({ id: operatorConfirmNodeId(b), ev: 'select', item: 'confirm' }))
      .toBe('selected');
    expect(mutations).toHaveLength(0);
    expect(feed({ id: operatorConfirmNodeId(b), ev: 'activate', item: 'confirm' }))
      .toBe('submit');
    expect(feed({ id: operatorConfirmNodeId(b), ev: 'action', act: 'confirm' }))
      .toBe('ignored');
    expect(mutations).toEqual([{ taskId: 'task-B', executionId: 'run-B' }]);
  });

  it('permits a run only against the selected known task, never a foreign id', () => {
    const run = { kind: 'run' as const, taskId: 'task-1',
      taskName: 'Report', generation: 1, surfaceId: 'agentweb-operator' };
    expect(confirmationMatches(running, run)).toBe(true);
    expect(confirmationMatches(running, { ...run, taskId: 'task-2' })).toBe(false);
  });
});

describe('Authorized browser log projection (real agent-engine HTML shape)', () => {
  const first = '2026-10-22 21:15:00,123 - browser_use.agent - INFO - 📍 Step 1';
  const second = '2026-10-22 21:15:01,456 - browser_use.agent - INFO - Action 1: click({password: supersecret, url: https://private.example/?X-Amz-Signature=abc})';
  const failed = '2026-10-22 21:15:02,789 - browser_use.agent - ERROR - Failed with Authorization: Bearer private-access-key';
  const html = (lines: string) =>
    '<!DOCTYPE html><html><head><script>const token = "hidden";</script></head><body>'
    + '<pre>' + lines + '</pre><div class="timestamp">Last updated</div></body></html>';

  it('creates only true persisted browser-use events with stable line keys', () => {
    const running = parseOperatorBrowserLogHtml(html(first + '\n' + second));
    const completed = parseOperatorBrowserLogHtml(html(first + '\n' + second
      + '\n2026-10-22 21:15:03,111 - browser_use.agent - INFO - Task completed'));
    const failure = parseOperatorBrowserLogHtml(html(first + '\n' + second + '\n' + failed));

    expect(running).toHaveLength(2);
    expect(running[0]).toMatchObject({
      when: '2026-10-22 21:15:00,123', kind: 'step',
      level: 'INFO', summary: 'Browser step 1',
    });
    expect(running[1]).toMatchObject({ kind: 'action', summary: 'Browser action: click' });
    expect(completed.slice(0, 2)).toEqual(running);
    expect(failure.slice(0, 2)).toEqual(running);
    expect(failure[2]).toMatchObject({ kind: 'log', level: 'ERROR', summary: 'Browser log error' });
    expect(completed[2].id).not.toEqual(failure[2].id);
    const all = JSON.stringify([running, completed, failure]);
    for (const secret of ['supersecret', 'private.example', 'private-access-key',
      'X-Amz-Signature', 'hidden', 'Authorization']) {
      expect(all).not.toContain(secret);
    }
  });

  it('does not reinterpret arbitrary HTML/status content or invented polls as activity', () => {
    expect(parseOperatorBrowserLogHtml(html('Task is running but no browser-use line'))).toEqual([]);
    expect(parseOperatorBrowserLogHtml(html(
      '2026-10-22 21:15:00,123 - external.logger - INFO - fake browser event',
    ))).toEqual([]);
    expect(parseOperatorBrowserLogHtml('<script>Step 1</script>')).toEqual([]);
  });

  it('bounds a long log tail and keeps source-derived IDs stable', () => {
    const lines = Array.from({ length: 55 }, (_, i) =>
      '2026-10-22 21:15:' + String(i % 60).padStart(2, '0')
      + ',123 - browser_use.agent - INFO - Step ' + (i + 1));
    const events = parseOperatorBrowserLogHtml(html(lines.join('\n')));
    expect(events).toHaveLength(40);
    expect(events[0].summary).toBe('Browser step 16');
    expect(new Set(events.map(evt => evt.id)).size).toBe(40);
    expect(parseOperatorBrowserLogHtml(html(lines.concat(
      '2026-10-22 21:15:59,123 - browser_use.agent - INFO - Step 56',
    ).join('\n')))[0].id).toBe(events[1].id);
  });

  it('uses persisted endTime or a supplied read clock for elapsed, not status polling events', () => {
    const run = { taskId: 't', executionId: 'e', status: 'running',
      startTime: '2026-10-22T21:00:00.000Z' };
    expect(elapsedExecution(run, '2026-10-22T21:02:03.000Z')).toBe('2m 3s');
    expect(elapsedExecution({
      ...run, status: 'failed', endTime: '2026-10-22T21:01:04.000Z',
    }, '2026-10-22T22:00:00.000Z')).toBe('1m 4s');
    expect(elapsedExecution({ ...run, startTime: 'not-a-date' })).toBeUndefined();

    const projection = displayOperatorJson({
      scope: 'executions', tasks: [], executions: [run],
      taskId: 't', executionId: 'e',
      detail: { ...run, activity: parseOperatorBrowserLogHtml(html(first)) },
      lastUpdated: '2026-10-22T21:02:03.000Z',
    });
    expect((projection.detail as any).elapsed).toBe('2m 3s');
    expect((projection.detail as any).timeline).toHaveLength(1);
  });
});
