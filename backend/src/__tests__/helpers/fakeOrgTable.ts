/**
 * An in-memory org item behind `orgDb.getOrgById` / `orgDb.updateOrg` that evaluates the equality and
 * attribute_not_exists conditions the hot-lead-call code generates, so tests exercise the real compare-and-swap.
 */
export interface FakeOrgTable {
  org: Record<string, unknown> & { orgId: string };
  writes: Array<{ updates: Record<string, unknown>; condition?: { expression: string } }>;
  /** Runs before each write is evaluated; tests use it to simulate a concurrent editor. */
  beforeWrite: ((index: number) => void) | null;
}

type Condition = { expression: string; names?: Record<string, string>; values?: Record<string, unknown> };

// JSON, because structuredClone/isDeepStrictEqual compare prototypes across jest's vm realm.
export const cloneJson = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function installFakeOrgTable(
  orgDb: { getOrgById: jest.Mock; updateOrg: jest.Mock },
  table: FakeOrgTable,
): void {
  orgDb.getOrgById.mockImplementation(async () => cloneJson(table.org));
  orgDb.updateOrg.mockImplementation(async (_orgId: string, updates: Record<string, unknown>, options?: { condition?: Condition }) => {
    const index = table.writes.length;
    table.writes.push({ updates, condition: options?.condition });
    table.beforeWrite?.(index);
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(updates)) values[`:${k}`] = v;
    Object.assign(values, options?.condition?.values ?? {});
    const names = options?.condition?.names ?? {};
    for (const clause of (options?.condition?.expression ?? '').split(' AND ').filter(Boolean)) {
      const absent = /^attribute_not_exists\((#\w+)\)$/.exec(clause);
      const equal = /^(#\w+) = (:\w+)$/.exec(clause);
      if (!absent && !equal) throw new Error(`fake org table cannot evaluate: ${clause}`);
      const holds = absent ? table.org[names[absent[1]]] === undefined : same(table.org[names[equal![1]]], values[equal![2]]);
      if (!holds) throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) delete table.org[k];
      else table.org[k] = cloneJson(v);
    }
    return table.org;
  });
}
