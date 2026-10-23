import { renderOperator } from '../tern/renderOperator';
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
    expect(renderOperator(view).flatMap(all).find(node => node.id === 'operator.confirm')?.p?.selected)
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
