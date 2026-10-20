/**
 * One AW-Users row behind a fake `userDb.updateUser` that EVALUATES the write's condition the way
 * DynamoDB would, instead of recording it.
 *
 * ENG-668 PR-2's settlement is a chain of conditional writes (record `pending` only once, move it only
 * from the states it may leave, suspend only once). Asserting the arguments handed to a mock proves
 * nothing about which of two racing writers wins, or whether a rerun is a no-op; running the
 * condition against a real row does. Deliberately a SUBSET of the expression grammar — exactly the
 * forms `updateUser` callers in the PAYG code emit — and anything else throws rather than passes.
 */

type Row = Record<string, any>;

export interface UpdateUserOptions {
  condition?: { expression: string; names?: Record<string, string>; values?: Record<string, any> };
  pathSets?: Array<{ path: Array<string | number>; value: any }>;
  pathRemoves?: Array<{ path: Array<string | number> }>;
}

const clone = <T>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function getPath(row: Row | undefined, path: Array<string | number>): any {
  let node: any = row;
  for (const segment of path) {
    if (node === undefined || node === null) return undefined;
    node = node[segment as any];
  }
  return node;
}

function setPath(row: Row, path: Array<string | number>, value: any): void {
  let node: any = row;
  for (let i = 0; i < path.length - 1; i++) {
    if (node[path[i] as any] === undefined || node[path[i] as any] === null) {
      // DynamoDB refuses to SET below a missing parent ("document path is invalid").
      throw Object.assign(new Error('ValidationException: The document path provided in the update expression is invalid for update'), {
        code: 'ValidationException',
      });
    }
    node = node[path[i] as any];
  }
  node[path[path.length - 1] as any] = clone(value);
}

function removePath(row: Row, path: Array<string | number>): void {
  const parent = getPath(row, path.slice(0, -1));
  if (parent && typeof parent === 'object') delete parent[path[path.length - 1] as any];
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Evaluates `expression` against `row`. Supports AND / OR / parentheses and the clauses below. */
export function evaluateCondition(
  expression: string,
  row: Row | undefined,
  names: Record<string, string> = {},
  values: Record<string, any> = {},
): boolean {
  const tokens = expression.match(/\(|\)|,|<>|<=|>=|=|<|>|[^\s(),<>=]+/g) || [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t: string) => {
    if (next() !== t) throw new Error(`userRowFake: expected ${t} in ${expression}`);
  };
  const path = (raw: string): Array<string> =>
    raw.split('.').map((part) => {
      if (!part.startsWith('#')) return part;
      if (!(part in names)) throw new Error(`userRowFake: unresolved name ${part} in ${expression}`);
      return names[part];
    });
  const value = (raw: string) => {
    if (!(raw in values)) throw new Error(`userRowFake: unresolved value ${raw} in ${expression}`);
    return values[raw];
  };

  function primary(): boolean {
    const t = next();
    if (t === '(') {
      const result = or();
      expect(')');
      return result;
    }
    if (t === 'NOT') return !primary();
    if (t === 'attribute_exists' || t === 'attribute_not_exists' || t === 'contains') {
      expect('(');
      const target = getPath(row, path(next()));
      if (t === 'contains') {
        expect(',');
        const needle = value(next());
        expect(')');
        return Array.isArray(target) ? target.some((v) => equal(v, needle)) : typeof target === 'string' && target.includes(needle);
      }
      expect(')');
      return t === 'attribute_exists' ? target !== undefined : target === undefined;
    }
    const left = getPath(row, path(t));
    const op = next();
    if (op === 'IN') {
      expect('(');
      const options: any[] = [value(next())];
      while (peek() === ',') {
        next();
        options.push(value(next()));
      }
      expect(')');
      return options.some((option) => equal(left, option));
    }
    const right = value(next());
    switch (op) {
      case '=': return left !== undefined && equal(left, right);
      case '<>': return left !== undefined && !equal(left, right);
      case '<': return typeof left === 'number' && left < right;
      case '<=': return typeof left === 'number' && left <= right;
      case '>': return typeof left === 'number' && left > right;
      case '>=': return typeof left === 'number' && left >= right;
      default: throw new Error(`userRowFake: unsupported operator ${op} in ${expression}`);
    }
  }
  function and(): boolean {
    let result = primary();
    while (peek() === 'AND') {
      next();
      const rhs = primary();
      result = result && rhs;
    }
    return result;
  }
  function or(): boolean {
    let result = and();
    while (peek() === 'OR') {
      next();
      const rhs = and();
      result = result || rhs;
    }
    return result;
  }
  const result = or();
  if (i !== tokens.length) throw new Error(`userRowFake: trailing tokens in ${expression}`);
  return result;
}

/**
 * A stored row and an `updateUser` implementation over it. `updateUser` applies top-level fields, then
 * `pathSets` / `pathRemoves`, all-or-nothing, only when the condition holds — otherwise it throws
 * `ConditionalCheckFailedException` like the real call.
 */
export function createUserRowFake(initial: Row) {
  const state = { row: clone(initial) as Row };
  const updateUser = async (_userId: string, fields: Row = {}, options: UpdateUserOptions = {}) => {
    if (options.condition && !evaluateCondition(
      options.condition.expression, state.row, options.condition.names, options.condition.values,
    )) {
      throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
    }
    const next = clone(state.row);
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      if (value === null) delete next[key];
      else next[key] = clone(value);
    }
    for (const { path, value } of options.pathSets ?? []) setPath(next, path, value);
    for (const { path } of options.pathRemoves ?? []) removePath(next, path);
    state.row = next;
    return clone(state.row);
  };
  return {
    get row() { return state.row; },
    set row(row: Row) { state.row = clone(row); },
    read: async () => clone(state.row),
    updateUser,
  };
}
