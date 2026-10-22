/**
 * A tiny in-memory stand-in for the DynamoDB DocumentClient, just faithful
 * enough to run `userDb.updateUser` against real UpdateExpression /
 * ConditionExpression strings. It exists because mocking `updateUser` itself
 * only ever checks the arguments, never what DynamoDB would do with them:
 *
 *  - an `ExpressionAttributeNames/Values` entry no expression uses is a
 *    ValidationException, and a placeholder used but not defined is too;
 *  - `SET list[n] = :v` APPENDS when n is past the end of the list;
 *  - a failed ConditionExpression leaves the item untouched.
 *
 * Supported grammar (all this codebase's onboarding writes need):
 *   Update:    SET a = :v, #a.#b[2] = :v   REMOVE #x, #y, #l[2] (a list element is spliced out)
 *   Condition: OR of AND-groups, parenthesised groups allowed; each clause is `PATH = :v`, `PATH <> :v`,
 *              `PATH <= :v`, `attribute_exists(PATH)`, `attribute_not_exists(PATH)` or `attribute_type(PATH, :t)`
 *
 * Eventual consistency: set `table.indexRow` to make `query` (the UserIdIndex
 * GSI) keep returning that older snapshot while `get` (a base-table read)
 * returns the current row, as DynamoDB does for a moment after any write.
 */

export interface FakeTable {
  /** The single user row, keyed by email like the real AW-Users table. */
  row: Record<string, any>;
  /** When set, GSI queries return this stale snapshot instead of `row`. */
  indexRow?: Record<string, any> | null;
  /** Every UpdateItem the client received, for assertions. */
  updates: any[];
  /** Called before an UpdateItem is applied, to force interleavings. */
  beforeUpdate?: (params: any, table: FakeTable) => Promise<void> | void;
}

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

type Step = { key: string; index?: number };

function parsePath(path: string, names: Record<string, string>): Step[] {
  return path.split(".").map((seg) => {
    const m = seg.trim().match(/^(#\w+|\w+)(?:\[(\d+)\])?$/);
    if (!m) throw validation(`Invalid path segment: ${seg}`);
    const key = m[1].startsWith("#") ? names[m[1]] : m[1];
    if (key === undefined) throw validation(`Undefined name placeholder ${m[1]}`);
    return { key, index: m[2] === undefined ? undefined : Number(m[2]) };
  });
}

function validation(message: string): Error {
  return Object.assign(new Error(message), { code: "ValidationException" });
}

function readPath(root: any, steps: Step[]): { exists: boolean; value?: any } {
  let cur = root;
  for (const s of steps) {
    if (cur == null || typeof cur !== "object" || !(s.key in cur)) return { exists: false };
    cur = cur[s.key];
    if (s.index !== undefined) {
      if (!Array.isArray(cur) || s.index >= cur.length) return { exists: false };
      cur = cur[s.index];
    }
  }
  return { exists: true, value: cur };
}

function writePath(root: any, steps: Step[], value: any): void {
  let cur = root;
  steps.forEach((s, i) => {
    const last = i === steps.length - 1;
    if (last) {
      if (s.index === undefined) {
        cur[s.key] = value;
      } else {
        const list = cur[s.key];
        if (!Array.isArray(list)) throw validation("The document path provided in the update expression is invalid for update");
        if (s.index >= list.length) list.push(value);
        else list[s.index] = value;
      }
      return;
    }
    if (cur[s.key] == null) throw validation("The document path provided in the update expression is invalid for update");
    cur = cur[s.key];
    if (s.index !== undefined) cur = cur[s.index];
  });
}

/** `REMOVE path`: splice a list element out (later ones shift down) or delete a key, as DynamoDB does. A missing path is a no-op. */
function removePath(root: any, steps: Step[]): void {
  let cur = root;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const last = i === steps.length - 1;
    if (cur == null || typeof cur !== "object" || !(s.key in cur)) return;
    if (last) {
      if (s.index === undefined) delete cur[s.key];
      else if (Array.isArray(cur[s.key]) && s.index < cur[s.key].length) cur[s.key].splice(s.index, 1);
      return;
    }
    cur = cur[s.key];
    if (s.index !== undefined) {
      if (!Array.isArray(cur) || s.index >= cur.length) return;
      cur = cur[s.index];
    }
  }
}

function placeholdersIn(expr: string): { names: Set<string>; values: Set<string> } {
  return {
    names: new Set(expr.match(/#\w+/g) ?? []),
    values: new Set(expr.match(/:\w+/g) ?? []),
  };
}

function evalClause(clause: string, row: any, names: Record<string, string>, values: Record<string, any>): boolean {
  const exists = clause.match(/^attribute_exists\((.+)\)$/);
  if (exists) return readPath(row, parsePath(exists[1], names)).exists;
  const typed = clause.match(/^attribute_type\((.+?),\s*(:\w+)\)$/);
  if (typed) {
    const got = readPath(row, parsePath(typed[1], names));
    if (!got.exists) return false;
    const v = got.value;
    const kind = v === null ? "NULL" : Array.isArray(v) ? "L" : typeof v === "object" ? "M" : typeof v === "string" ? "S" : typeof v === "number" ? "N" : typeof v === "boolean" ? "BOOL" : "?";
    return kind === values[typed[2]];
  }
  const notExists = clause.match(/^attribute_not_exists\((.+)\)$/);
  if (notExists) return !readPath(row, parsePath(notExists[1], names)).exists;
  const cmp = clause.match(/^(.+?)\s*(<>|<=|=)\s*(:\w+)$/);
  if (!cmp) throw validation(`Unsupported condition clause: ${clause}`);
  const got = readPath(row, parsePath(cmp[1], names));
  const want = values[cmp[3]];
  if (cmp[2] === "=") return got.exists && JSON.stringify(got.value) === JSON.stringify(want);
  if (cmp[2] === "<>") return !got.exists || JSON.stringify(got.value) !== JSON.stringify(want);
  return got.exists && typeof got.value === typeof want && got.value <= want;
}

/** Split on a top-level `AND` / `OR`, leaving anything inside parentheses (a group or a function call) intact. */
function splitTopLevel(expr: string, keyword: "AND" | "OR"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  const re = new RegExp(`^\\s+${keyword}\\s+`);
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0) {
      const hit = expr.slice(i).match(re);
      if (hit) {
        parts.push(expr.slice(last, i));
        i += hit[0].length - 1;
        last = i + 1;
      }
    }
  }
  parts.push(expr.slice(last));
  return parts;
}

function isWrappedInParens(clause: string): boolean {
  if (!clause.startsWith("(") || !clause.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < clause.length; i++) {
    if (clause[i] === "(") depth++;
    else if (clause[i] === ")" && --depth === 0 && i < clause.length - 1) return false;
  }
  return true;
}

function evalCondition(expr: string, row: any, names: Record<string, string>, values: Record<string, any>): boolean {
  // OR binds looser than AND, as in DynamoDB.
  return splitTopLevel(expr, "OR").some((group) =>
    splitTopLevel(group, "AND").every((c) => {
      const clause = c.trim();
      return isWrappedInParens(clause) ? evalCondition(clause.slice(1, -1), row, names, values) : evalClause(clause, row, names, values);
    }),
  );
}

export function createFakeDocClient(table: FakeTable) {
  const find = (p: any) => ({ promise: async () => ({ Items: [clone(table.indexRow ?? table.row)] }) });
  return {
    query: jest.fn(find),
    get: jest.fn(() => ({ promise: async () => ({ Item: clone(table.row) }) })),
    update: jest.fn((params: any) => ({
      promise: async () => {
        await table.beforeUpdate?.(params, table);
        table.updates.push(clone(params));
        const names = params.ExpressionAttributeNames ?? {};
        const values = params.ExpressionAttributeValues ?? {};
        const update: string = params.UpdateExpression ?? "";
        const cond: string = params.ConditionExpression ?? "";

        // DynamoDB rejects placeholders that are defined but unused, or used
        // but undefined.
        const used = placeholdersIn(`${update} ${cond}`);
        for (const n of Object.keys(names)) {
          if (!used.names.has(n)) throw validation(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${n}}`);
        }
        for (const v of Object.keys(values)) {
          if (!used.values.has(v)) throw validation(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${v}}`);
        }
        for (const n of used.names) if (!(n in names)) throw validation(`An expression attribute name used in the document path is not defined; attribute name: ${n}`);
        for (const v of used.values) if (!(v in values)) throw validation(`An expression attribute value used in expression is not defined; attribute value: ${v}`);

        if (cond && !evalCondition(cond, table.row, names, values)) {
          throw Object.assign(new Error("The conditional request failed"), { code: "ConditionalCheckFailedException" });
        }

        const next = clone(table.row);
        const [setPart, removePart] = update.replace(/^SET\s+/, "").split(/\s+REMOVE\s+/);
        if (update.startsWith("REMOVE")) {
          for (const r of update.replace(/^REMOVE\s+/, "").split(",")) removePath(next, parsePath(r.trim(), names));
        } else {
          for (const assignment of setPart.split(/,\s*(?=[#\w.\[\]]+\s*=\s*:)/)) {
            const m = assignment.match(/^(.+?)\s*=\s*(:\w+)$/);
            if (!m) throw validation(`Unsupported SET clause: ${assignment}`);
            writePath(next, parsePath(m[1], names), clone(values[m[2]]));
          }
          if (removePart) {
            for (const r of removePart.split(",")) removePath(next, parsePath(r.trim(), names));
          }
        }
        table.row = next;
        return { Attributes: clone(next) };
      },
    })),
  };
}
