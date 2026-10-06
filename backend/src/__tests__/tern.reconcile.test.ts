import { TspSurfaceReconciler } from '../tern/reconcile';
import type { TspNode } from '../tern/renderEmma';

function main(children: TspNode[], props?: Record<string, unknown>): TspNode {
  return {
    id: 'main',
    k: 'col',
    ...(props ? { p: props } : {}),
    c: children,
  };
}

describe('Tern keyed reconciler', () => {
  it('adds region roots under the surface on the first frame', () => {
    const reconciler = new TspSurfaceReconciler('surface-1');
    const roots: TspNode[] = [
      main([{ id: 'm1', k: 'md', p: { text: 'hello' } }]),
      { id: 'dock', k: 'col' },
      { id: 'layer', k: 'col' },
    ];

    const ops = reconciler.diff(roots);
    expect(ops.filter(op => op[0] === 'add')).toHaveLength(3);
    expect(ops).toContainEqual(['add', 'main', 'surface-1', 'dock', roots[0]]);
    expect(ops).toContainEqual(['add', 'dock', 'surface-1', 'layer', roots[1]]);
    expect(ops).toContainEqual(['add', 'layer', 'surface-1', null, roots[2]]);
  });

  it('updates text surgically without deleting the transcript root', () => {
    const reconciler = new TspSurfaceReconciler('surface-1');
    const before = [main([{ id: 'm1', k: 'md', p: { text: 'hello' } }])];
    reconciler.commit(before);

    const next = [main([{ id: 'm1', k: 'md', p: { text: 'hello world' } }])];
    const ops = reconciler.diff(next);

    expect(ops).toEqual([
      ['text', 'm1', 'append', ' world'],
    ]);
    expect(ops).not.toContainEqual(expect.arrayContaining(['del', 'main']));
  });

  it('adds a new keyed transcript child without repainting existing siblings', () => {
    const reconciler = new TspSurfaceReconciler('surface-1');
    const first = { id: 'm1', k: 'md', p: { text: 'one' } } as TspNode;
    const second = { id: 'm2', k: 'md', p: { text: 'two' } } as TspNode;
    reconciler.commit([main([first])]);

    expect(reconciler.diff([main([first, second])])).toEqual([
      ['add', 'm2', 'main', null, second],
    ]);
  });

  it('uses move ops for keyed reorder rather than delete/add', () => {
    const reconciler = new TspSurfaceReconciler('surface-1');
    const a = { id: 'a', k: 'text', p: { text: 'A' } } as TspNode;
    const b = { id: 'b', k: 'text', p: { text: 'B' } } as TspNode;
    const c = { id: 'c', k: 'text', p: { text: 'C' } } as TspNode;
    reconciler.commit([main([a, b, c])]);

    const ops = reconciler.diff([main([b, a, c])]);
    expect(ops.some(op => op[0] === 'move')).toBe(true);
    expect(ops.some(op => op[0] === 'del')).toBe(false);
    expect(ops.some(op => op[0] === 'add')).toBe(false);
  });

  it('clears a removed prop instead of serializing undefined', () => {
    const reconciler = new TspSurfaceReconciler('surface-1');
    reconciler.commit([main([], { tone: 'warning' })]);

    expect(reconciler.diff([main([], { tone: undefined })])).toEqual([
      ['set', 'main', { tone: null }],
    ]);
  });

  it('replays only a forgotten subtree after a node-level gone event', () => {
    const reconciler = new TspSurfaceReconciler('surface-1');
    const a = { id: 'a', k: 'text', p: { text: 'A' } } as TspNode;
    const b = { id: 'b', k: 'text', p: { text: 'B' } } as TspNode;
    const roots = [main([a, b])];
    reconciler.commit(roots);

    reconciler.forget(['b']);
    expect(reconciler.diff(roots)).toEqual([
      ['add', 'b', 'main', null, b],
    ]);
  });
});
