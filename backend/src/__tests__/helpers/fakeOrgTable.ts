/**
 * An in-memory org item behind `orgDb.getOrgById` / `orgDb.updateOrg` that evaluates the equality and
 * attribute_not_exists conditions the hot-lead-call code generates (unchangedSince in services/voice/setupWrites.ts),
 * so tests exercise the real compare-and-swap. It exists next to inMemoryDynamo because that fake evaluates
 * DynamoDB expressions at the table level, while these conditions arrive through orgDb.updateOrg's `condition`
 * option on a single org item, with the attribute names and values already split out.
 */
export interface FakeOrgTable {
  org: Record<string, unknown> & { orgId: string };
  writes: Array<{ updates: Record<string, unknown>; condition?: { expression: string; values?: Record<string, unknown> } }>;
  /** Runs before each write is evaluated; tests use it to simulate a concurrent editor. */
  beforeWrite: ((index: number) => void) | null;
}

type Condition = { expression: string; names?: Record<string, string>; values?: Record<string, unknown> };

// JSON, because structuredClone/isDeepStrictEqual compare prototypes across jest's vm realm.
export const cloneJson = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
// Key-sorted, like DynamoDB's map equality: the order a map was built in does not matter.
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'undefined';
};
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

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
      let holds: boolean;
      if (absent) holds = table.org[names[absent[1]]] === undefined;
      else if (equal) holds = same(table.org[names[equal[1]]], values[equal[2]]);
      else throw new Error(`fake org table cannot evaluate: ${clause}`);
      if (!holds) throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
    }
    for (const [k, v] of Object.entries(updates)) {
      if (v === null) delete table.org[k];
      else table.org[k] = cloneJson(v);
    }
    return table.org;
  });
}
