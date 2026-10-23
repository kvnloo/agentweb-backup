import { renderOperator } from '../tern/renderOperator';
import { parseOperatorBrowserLogHtml } from '../tern/operatorModel';
import type { OperatorView } from '../tern/operatorModel';
import { TspSurfaceReconciler } from '../tern/reconcile';
import type { TspNode } from '../tern/renderEmma';

function all(node: TspNode): TspNode[] {
  return [node, ...(node.c ?? []).reduce((out: TspNode[], child) => out.concat(all(child)), [])];
}

function sample(status: string): OperatorView {
  const run = {
    taskId: 'task-one',
    executionId: 'run-one',
    status,
    result_files: [
      { filename: 'report.html', url: 'https://files.example/report.html' },
      { filename: 'private.html', url: 'https://files.example/private?signature=example' },
    ],
  };
  return {
    scope: 'executions',
    taskId: 'task-one',
    tasks: [{ taskId: 'task-one', name: 'Research task', status: 'active' }],
    executions: [run],
    executionId: 'run-one',
    detail: run,
  };
}

describe('Native Tern task/run surface', () => {
  it('shows a keyboard-first native task picker', () => {
    const view = { ...sample('running'), scope: 'tasks' as const };
    const nodes = renderOperator(view).reduce((out: TspNode[], root) => out.concat(all(root)), []);
    expect(nodes.find(node => node.id === 'operator.tasks')).toMatchObject({
      k: 'picker', p: { size: 'screen', selected: 'task-one' },
    });
  });

  it('shows safe artifact links and withholds signed ones', () => {
    const nodes = renderOperator(sample('completed'))
      .reduce((out: TspNode[], root) => out.concat(all(root)), []);
    expect(nodes.find(node => node.id === 'operator.run.artifact.0')?.p?.href)
      .toBe('https://files.example/report.html');
    expect(nodes.find(node => node.id === 'operator.run.artifact.1')?.p?.href)
      .toBeUndefined();
  });

  it('starts every confirmation at Cancel', () => {
    const view = sample('running');
    view.confirm = { kind: 'stop', taskId: 'task-one', executionId: 'run-one' };
    expect(renderOperator(view).reduce((out: TspNode[], root) => out.concat(all(root)), [])
      .find(node => node.id === 'operator.confirm')?.p?.selected)
      .toBe('cancel');
  });

  it('patches running to complete to failed without replacing the list root', () => {
    const r = new TspSurfaceReconciler('agentweb-operator');
    r.commit(renderOperator(sample('running')));
    const completed = sample('completed');
    completed.detail = { ...completed.detail!, result: 'Done' };
    const ops = r.diff(renderOperator(completed));
    expect(ops.length).toBeGreaterThan(0);
    expect(ops).not.toContainEqual(['del', 'main']);
    r.commit(renderOperator(completed));
    const failed = sample('failed');
    failed.detail = { ...failed.detail!, error: 'Failure' };
    expect(r.diff(renderOperator(failed))).not.toContainEqual(['del', 'operator.runs']);
  });
});

describe('Actual browser activity and incremental keyed TSP updates', () => {
  const log = (lines: string[]) => '<html><body><pre>' + lines.join('\n') + '</pre></body></html>';
  const step = '2026-10-22 21:00:01,000 - browser_use.agent - INFO - Step 1';
  const click = '2026-10-22 21:00:03,000 - browser_use.agent - INFO - Action 1: click({"secret":"private"})';
  const finish = '2026-10-22 21:00:05,000 - browser_use.agent - INFO - Task completed';
  const failure = '2026-10-22 21:00:05,000 - browser_use.agent - ERROR - Authorization: Bearer private';

  function withLog(status: string, lines: string[]): OperatorView {
    const view = sample(status);
    view.detail = {
      ...view.detail!, userInteractions: [],
      startTime: '2026-10-22T21:00:00.000Z',
      llmName: 'model-1',
      endTime: status === 'running' ? undefined : '2026-10-22T21:00:06.000Z',
      result: status === 'completed' ? 'Report ready' : undefined,
      error: status === 'failed' ? 'Task failed' : undefined,
      browser_use_log: 'https://bucket.s3.amazonaws.com/private/log?token=never-render',
      activity: parseOperatorBrowserLogHtml(log(lines)),
    };
    view.lastUpdated = '2026-10-22T21:00:04.000Z';
    return view;
  }

  it('shows elapsed, current activity, and a real timeline without any user question', () => {
    const view = withLog('running', [step, click]);
    const nodes = renderOperator(view).reduce(
      (out: TspNode[], root) => out.concat(all(root)), [] as TspNode[],
    );
    const facts = nodes.find(node => node.id === 'operator.run.facts');
    expect(facts?.p?.items).toEqual(expect.arrayContaining([
      { k: 'Model', v: 'model-1' },
      { k: 'Elapsed', v: '4s' },
    ]));
    const latest = nodes.find(node => node.id === 'operator.run.latest');
    expect(JSON.stringify(latest)).toContain('Browser action: click');
    const timeline = nodes.find(node => node.id === 'operator.run.timeline');
    expect(timeline?.k).toBe('table');
    expect((timeline?.p?.rows as unknown[])).toHaveLength(2);
    expect(nodes.find(node => node.id === 'operator.run.user-requests')).toBeUndefined();
    const wire = JSON.stringify(nodes);
    for (const secret of ['token=never-render', '"secret"', 'private/log', 'Bearer private']) {
      expect(wire).not.toContain(secret);
    }
  });

  it('patches real running -> completed and running -> failed streams without recreating nodes', () => {
    for (const [status, tail] of [
      ['completed', finish], ['failed', failure],
    ]) {
      const running = withLog('running', [step, click]);
      const terminal = withLog(status, [step, click, tail]);
      const r = new TspSurfaceReconciler('agentweb-operator');
      const a = renderOperator(running);
      const b = renderOperator(terminal);
      const firstRows = all(a[0]).find(node => node.id === 'operator.run.timeline')?.p?.rows as any[];
      const lastRows = all(b[0]).find(node => node.id === 'operator.run.timeline')?.p?.rows as any[];
      expect(lastRows.slice(0, 2)).toEqual(firstRows);
      expect(lastRows).toHaveLength(3);
      r.commit(a);
      const ops = r.diff(b);
      expect(ops).toContainEqual(['set', 'operator.run.timeline', expect.objectContaining({
        rows: lastRows,
      })]);
      expect(ops).not.toContainEqual(['del', 'main']);
      expect(ops).not.toContainEqual(['del', 'operator.runs']);
      expect(ops).not.toContainEqual(['del', 'operator.run.preview']);
      expect(ops).not.toContainEqual(['del', 'operator.run.timeline']);
      r.commit(b);
      expect(r.diff(b)).toEqual([]);
      expect(JSON.stringify(b)).not.toContain('private');
    }
  });

  it('treats activity-read failures as unavailable, never as fake browser steps', () => {
    const view = withLog('failed', []);
    view.detail = { ...view.detail!, activityUnavailable: true };
    const nodes = renderOperator(view).reduce(
      (out: TspNode[], root) => out.concat(all(root)), [] as TspNode[],
    );
    expect(nodes.find(node => node.id === 'operator.run.timeline')).toBeUndefined();
    expect(nodes.find(node => node.id === 'operator.run.activity-state')?.p?.text)
      .toBe('Execution activity temporarily unavailable.');
  });
});
