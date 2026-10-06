/**
 * Minimal keyed TSP reconciler for AgentWeb's three native surface regions.
 *
 * This is intentionally narrower than the official Stencil SDK reconciler but
 * follows the same wire rules: stable ids, prop/text diffs, keyed child
 * add/delete/move, and region roots parented directly to the surface.
 *
 * Credit: adapted from stencil-hq/tern-sdk typescript/src/reconcile.ts.
 */
import type { TspNode } from './renderEmma';

export type TspOp =
  | ['add', string, string, string | null, TspNode]
  | ['set', string, Record<string, unknown>]
  | ['text', string, 'append' | 'replace', string]
  | ['move', string, string, string | null]
  | ['del', string]
  | ['focus', string | null]
  | ['settle', string];

const TEXT_KINDS = new Set([
  'text',
  'md',
  'code',
  'ansi',
  'math',
  'editor',
  'input',
  'shimmer',
  'el',
]);

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    typeof a !== 'object'
    || typeof b !== 'object'
    || a === null
    || b === null
  ) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    if (!(key in right) || !jsonEqual(left[key], right[key])) return false;
  }
  return true;
}

function normalizeNode(node: TspNode): TspNode {
  const rawProps = node.p ?? {};
  const props: Record<string, unknown> = {};
  for (const key of Object.keys(rawProps)) {
    if (rawProps[key] !== undefined) props[key] = rawProps[key];
  }

  const children = node.c?.map(normalizeNode);
  return {
    id: node.id,
    k: node.k,
    ...(Object.keys(props).length ? { p: props } : {}),
    ...(children?.length ? { c: children } : {}),
  };
}

/** Indices of one longest strictly increasing subsequence. */
function rising(sequence: readonly number[]): number[] {
  const tails: number[] = [];
  const previous: Array<number | undefined> = new Array(sequence.length);

  sequence.forEach((value, index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const tailIndex = tails[mid] ?? 0;
      if ((sequence[tailIndex] ?? 0) < value) lo = mid + 1;
      else hi = mid;
    }
    previous[index] = lo > 0 ? tails[lo - 1] : undefined;
    tails[lo] = index;
  });

  const result: number[] = [];
  let current = tails[tails.length - 1];
  while (current !== undefined) {
    result.push(current);
    current = previous[current];
  }
  return result.reverse();
}

function diffNode(oldNode: TspNode, nextNode: TspNode, ops: TspOp[]): void {
  if (oldNode.k !== nextNode.k) {
    throw new Error(`TSP node kind changed without parent context: ${oldNode.id}`);
  }

  const beforeProps = oldNode.p ?? {};
  const afterProps = nextNode.p ?? {};
  const textKind = TEXT_KINDS.has(nextNode.k);
  const changed: Record<string, unknown> = {};

  for (const key of Object.keys(afterProps)) {
    if (textKind && key === 'text') continue;
    const value = afterProps[key];
    if (!jsonEqual(beforeProps[key], value)) changed[key] = value;
  }
  for (const key of Object.keys(beforeProps)) {
    if (textKind && key === 'text') continue;
    if (!(key in afterProps)) changed[key] = null;
  }
  if (Object.keys(changed).length) ops.push(['set', nextNode.id, changed]);

  if (textKind) {
    const before = beforeProps.text;
    const after = afterProps.text;
    if (!jsonEqual(before, after)) {
      if (typeof after === 'string') {
        if (typeof before === 'string' && before !== '' && after.startsWith(before)) {
          ops.push(['text', nextNode.id, 'append', after.slice(before.length)]);
        } else {
          ops.push(['text', nextNode.id, 'replace', after]);
        }
      } else {
        ops.push(['set', nextNode.id, { text: null }]);
      }
    }
  }

  diffChildren(oldNode, nextNode, ops);
}

function diffChildren(oldNode: TspNode, nextNode: TspNode, ops: TspOp[]): void {
  const beforeChildren = oldNode.c ?? [];
  const afterChildren = nextNode.c ?? [];
  const before = new Map<string, { at: number; node: TspNode }>();

  beforeChildren.forEach((node, at) => before.set(node.id, { at, node }));

  const kept = new Set(afterChildren.map(node => node.id));
  for (const child of beforeChildren) {
    if (!kept.has(child.id)) ops.push(['del', child.id]);
  }

  const same: Array<{ at: number; was: number }> = [];
  afterChildren.forEach((child, at) => {
    const previous = before.get(child.id);
    if (previous && previous.node.k === child.k) {
      same.push({ at, was: previous.at });
    }
  });
  const stay = new Set(rising(same.map(entry => entry.was)).map(index => same[index]!.at));

  let nextSibling: string | null = null;
  for (let at = afterChildren.length - 1; at >= 0; at--) {
    const child = afterChildren[at]!;
    const previous = before.get(child.id);

    if (!previous) {
      ops.push(['add', child.id, nextNode.id, nextSibling, child]);
    } else if (previous.node.k !== child.k) {
      ops.push(['del', child.id]);
      ops.push(['add', child.id, nextNode.id, nextSibling, child]);
    } else {
      if (!stay.has(at)) ops.push(['move', child.id, nextNode.id, nextSibling]);
      diffNode(previous.node, child, ops);
    }
    nextSibling = child.id;
  }
}

function forgetNode(node: TspNode, forgotten: ReadonlySet<string>): TspNode | null {
  if (forgotten.has(node.id)) return null;
  if (!node.c?.length) return node;

  let changed = false;
  const children: TspNode[] = [];
  for (const child of node.c) {
    const kept = forgetNode(child, forgotten);
    if (!kept) {
      changed = true;
      continue;
    }
    if (kept !== child) changed = true;
    children.push(kept);
  }

  return changed ? { ...node, c: children } : node;
}

export class TspSurfaceReconciler {
  private roots = new Map<string, TspNode>();

  constructor(private readonly surfaceId: string) {}

  diff(nextRoots: readonly TspNode[]): TspOp[] {
    const ops: TspOp[] = [];
    const normalizedRoots = nextRoots.map(normalizeNode);
    const next = new Map(normalizedRoots.map(node => [node.id, node] as const));

    for (const [id] of this.roots) {
      if (!next.has(id)) ops.push(['del', id]);
    }

    // Surface regions are stable and ordered by the caller. If a new root is
    // introduced, add it in that order using the following root as the anchor.
    for (let i = normalizedRoots.length - 1; i >= 0; i--) {
      const node = normalizedRoots[i]!;
      const oldNode = this.roots.get(node.id);
      const nextSibling = normalizedRoots[i + 1]?.id ?? null;

      if (!oldNode) {
        ops.push(['add', node.id, this.surfaceId, nextSibling, node]);
      } else if (oldNode.k !== node.k) {
        ops.push(['del', node.id]);
        ops.push(['add', node.id, this.surfaceId, nextSibling, node]);
      } else {
        diffNode(oldNode, node, ops);
      }
    }

    return ops;
  }

  commit(nextRoots: readonly TspNode[]): void {
    const normalizedRoots = nextRoots.map(normalizeNode);
    this.roots = new Map(normalizedRoots.map(node => [node.id, node] as const));
  }

  forget(ids: readonly string[]): void {
    if (!ids.length) return;
    const forgotten = new Set(ids);
    const next = new Map<string, TspNode>();
    for (const [id, root] of this.roots) {
      const kept = forgetNode(root, forgotten);
      if (kept) next.set(id, kept);
    }
    this.roots = next;
  }

  reset(): void {
    this.roots.clear();
  }
}
