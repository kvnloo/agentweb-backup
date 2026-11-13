/**
 * An executing stand-in for the DocumentClient, scoped to AW-Leads / AW-LeadLists.
 *
 * Why it exists (ENG-2320): a mocked `dynamodb.update` records the expression string and never
 * parses it, so a syntax ValidationException (this module has shipped `SET domain = :x` broken
 * before) and a lost-update race are both invisible to it. This one EXECUTES the expression
 * against an in-memory item, with the failure classes DynamoDB itself rejects:
 *   - a bare attribute name that is a reserved word, or not a legal identifier
 *   - a `#name` / `:value` placeholder that is used but undefined, or defined but unused
 *   - two paths in one expression that overlap (`customFields` and `customFields.k`)
 *   - a document-path write whose parent map does not exist
 * and it applies every right-hand side to the PRE-image, as DynamoDB does.
 *
 * It is deliberately a SUBSET (SET / REMOVE / ADD, `if_not_exists`, `list_append`, and
 * `attribute_exists` / `attribute_not_exists` conditions) and throws on anything else rather
 * than silently accepting it. The reserved-word list is a subset too: dynamodb-local is the
 * authority for the full list, and the PR records that run.
 *
 * Reads return CLONES taken when the call is made and writes apply atomically when the call
 * lands, with an optional random latency before each op, so concurrent requests interleave
 * exactly like a read-then-write race against the real service does.
 */

const RESERVED = new Set([
  'ADD', 'ALL', 'AND', 'ASC', 'BY', 'COMMENT', 'COUNT', 'DATA', 'DATE', 'DELETE', 'DESC', 'DOMAIN', 'KEY', 'KEYS',
  'NAME', 'NUMBER', 'SET', 'SOURCE', 'STATUS', 'SYSTEM', 'TABLE', 'TIME', 'TIMESTAMP', 'TYPE', 'USER', 'VALUE', 'VALUES',
  'ZONE', 'REMOVE', 'OR', 'NOT', 'IN', 'BETWEEN', 'LIST', 'MAP', 'STRING', 'ROLE', 'SESSION', 'STATE', 'URL',
]);

const vex = (message: string) => Object.assign(new Error(`ValidationException: ${message}`), { code: 'ValidationException' });
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
/**
 * What the aws-sdk DocumentClient marshaller does to a VALUE on its way out: it builds each map
 * with `map[key] = ...`, so an own `__proto__` key becomes a prototype assignment and never
 * reaches DynamoDB (verified against dynamodb-local). A `__proto__` in an attribute NAME placeholder
 * is not marshalled at all and is stored, which is why updateLead's per-key mode filters it.
 */
const marshal = (v: any): any => {
  if (Array.isArray(v)) return v.map(marshal);
  if (v && typeof v === 'object') {
    const out: any = {};
    for (const k of Object.keys(v)) if (k !== '__proto__') out[k] = marshal(v[k]);
    return out;
  }
  return v;
};

type Op = { target: string[]; kind: 'set' | 'remove' | 'add'; rhs?: string };

/** Split on `sep` at parenthesis depth 0. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export class LeadTableFake {
  leads = new Map<string, any>();
  lists = new Map<string, any>();
  /** Every UpdateItem that reached the table, for expression-shape assertions. */
  updates: any[] = [];
  /** Max random latency (ms) before each operation; 0 = none. */
  jitterMs = 0;

  private leadKey = (listId: string, leadId: string) => `${listId}\u0000${leadId}`;
  seedLead(row: any) { this.leads.set(this.leadKey(row.listId, row.leadId), clone(row)); }
  seedList(row: any) { this.lists.set(row.listId, clone(row)); }
  lead(listId: string, leadId: string) { return clone(this.leads.get(this.leadKey(listId, leadId))); }
  list(listId: string) { return clone(this.lists.get(listId)); }
  leadsIn(listId: string) { return [...this.leads.values()].filter((l) => l.listId === listId).map(clone); }
  reset() { this.leads.clear(); this.lists.clear(); this.updates = []; this.jitterMs = 0; }

  private async latency() {
    await new Promise((r) => setTimeout(r, this.jitterMs ? Math.random() * this.jitterMs : 0));
  }

  private table(name: string): 'leads' | 'lists' {
    if (name === 'AW-Leads') return 'leads';
    if (name === 'AW-LeadLists') return 'lists';
    throw new Error(`leadTableFake: unsupported table ${name}`);
  }

  private pathOf(raw: string, names: Record<string, string>, used: Set<string>): string[] {
    return raw.split('.').map((seg) => {
      seg = seg.trim();
      if (seg.startsWith('#')) {
        if (!(seg in names)) throw vex(`An expression attribute name used in the document path is not defined; attribute name: ${seg}`);
        used.add(seg);
        return names[seg];
      }
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(seg)) throw vex(`Invalid UpdateExpression: Syntax error; token: "${seg}"`);
      if (RESERVED.has(seg.toUpperCase())) throw vex(`Invalid UpdateExpression: Attribute name is a reserved keyword; reserved keyword: ${seg}`);
      return seg;
    });
  }

  private getPath(item: any, path: string[]): any {
    let cur = item;
    for (const seg of path) {
      if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  /** Evaluate one right-hand side against the pre-image. */
  private evalOperand(raw: string, before: any, names: Record<string, string>, values: Record<string, any>, usedN: Set<string>, usedV: Set<string>): any {
    raw = raw.trim();
    if (raw.startsWith(':')) {
      if (!(raw in values)) throw vex(`An expression attribute value used in expression is not defined; attribute value: ${raw}`);
      if (values[raw] === undefined) throw vex(`ExpressionAttributeValues contains an undefined value for ${raw}`);
      usedV.add(raw);
      return clone(marshal(values[raw]));
    }
    const fn = raw.match(/^(if_not_exists|list_append)\((.*)\)$/s);
    if (fn) {
      const args = splitTop(fn[2], ',');
      if (args.length !== 2) throw vex(`Invalid UpdateExpression: wrong number of operands for ${fn[1]}`);
      if (fn[1] === 'if_not_exists') {
        const cur = this.getPath(before, this.pathOf(args[0], names, usedN));
        return cur !== undefined ? clone(cur) : this.evalOperand(args[1], before, names, values, usedN, usedV);
      }
      const a = this.evalOperand(args[0], before, names, values, usedN, usedV);
      const b = this.evalOperand(args[1], before, names, values, usedN, usedV);
      if (!Array.isArray(a) || !Array.isArray(b)) throw vex('Invalid UpdateExpression: list_append operands must be lists');
      return [...a, ...b];
    }
    throw new Error(`leadTableFake: unsupported SET operand: ${raw}`);
  }

  private applyUpdate(item: any, expr: string, names: Record<string, string>, values: Record<string, any>, usedN: Set<string>, usedV: Set<string>) {
    const ops: Op[] = [];
    // Section split on the clause keywords at depth 0.
    const sections = expr.trim().split(/\b(SET|REMOVE|ADD|DELETE)\b/).map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < sections.length; i += 2) {
      const kw = sections[i];
      const body = sections[i + 1];
      if (!['SET', 'REMOVE', 'ADD'].includes(kw) || body === undefined) throw vex(`Invalid UpdateExpression: ${expr}`);
      for (const part of splitTop(body, ',')) {
        if (kw === 'SET') {
          const eq = part.indexOf('=');
          if (eq < 0) throw vex(`Invalid UpdateExpression: ${part}`);
          ops.push({ kind: 'set', target: this.pathOf(part.slice(0, eq), names, usedN), rhs: part.slice(eq + 1) });
        } else if (kw === 'REMOVE') {
          ops.push({ kind: 'remove', target: this.pathOf(part, names, usedN) });
        } else {
          const [p, v] = part.split(/\s+/);
          ops.push({ kind: 'add', target: this.pathOf(p, names, usedN), rhs: v });
        }
      }
    }
    if (ops.length === 0) throw vex('Invalid UpdateExpression: empty');
    // DynamoDB: "Two document paths overlap with each other" (also identical paths).
    for (let i = 0; i < ops.length; i++) {
      for (let j = i + 1; j < ops.length; j++) {
        const a = ops[i].target; const b = ops[j].target;
        const n = Math.min(a.length, b.length);
        if (a.slice(0, n).every((s, k) => s === b[k])) throw vex(`Invalid UpdateExpression: Two document paths overlap with each other; path one: [${a.join(', ')}], path two: [${b.join(', ')}]`);
      }
    }
    const before = clone(item);
    for (const op of ops) {
      const parentPath = op.target.slice(0, -1);
      const leaf = op.target[op.target.length - 1];
      let parent: any = item;
      for (const seg of parentPath) {
        parent = parent && Object.prototype.hasOwnProperty.call(parent, seg) ? parent[seg] : undefined;
      }
      if (parentPath.length > 0 && (parent === undefined || parent === null || typeof parent !== 'object' || Array.isArray(parent))) {
        throw vex('The document path provided in the update expression is invalid for update');
      }
      if (op.kind === 'remove') { delete parent[leaf]; continue; }
      // defineProperty, not assignment: a map key named `__proto__` is DATA in DynamoDB.
      const put = (v: any) => Object.defineProperty(parent, leaf, { value: v, enumerable: true, writable: true, configurable: true });
      if (op.kind === 'add') {
        put((typeof parent[leaf] === 'number' ? parent[leaf] : 0) + this.evalOperand(op.rhs!, before, names, values, usedN, usedV));
        continue;
      }
      put(this.evalOperand(op.rhs!, before, names, values, usedN, usedV));
    }
  }

  private checkCondition(expr: string | undefined, item: any, names: Record<string, string>, usedN: Set<string>, values: Record<string, any> = {}): boolean {
    if (!expr) return true;
    return expr.split(/\s+OR\s+/i).map((alternative) => alternative.split(/\s+AND\s+/i).map((clauseRaw) => {
      const equality = clauseRaw.trim().match(/^(#[A-Za-z0-9_]+)\s*=\s*(:[A-Za-z0-9_]+)$/);
      if (equality) {
        return item !== undefined && this.getPath(item, this.pathOf(equality[1], names, usedN)) === values[equality[2]];
      }
      const m = clauseRaw.trim().match(/^(attribute_exists|attribute_not_exists)\((.*)\)$/s);
      if (!m) throw new Error(`leadTableFake: unsupported ConditionExpression clause: ${clauseRaw}`);
      const present = item !== undefined && this.getPath(item, this.pathOf(m[2], names, usedN)) !== undefined;
      return m[1] === 'attribute_exists' ? present : !present;
    }).every(Boolean)).some(Boolean);
  }

  client() {
    const self = this;
    const wrap = (fn: (p: any) => Promise<any>) => (params: any) => ({
      promise: async () => { await self.latency(); return fn(params); },
    });
    return {
      get: wrap(async (p) => {
        const t = self.table(p.TableName);
        const item = t === 'leads' ? self.leads.get(self.leadKey(p.Key.listId, p.Key.leadId)) : self.lists.get(p.Key.listId);
        return { Item: clone(item) };
      }),
      query: wrap(async (p) => {
        if (self.table(p.TableName) !== 'leads' || p.IndexName !== 'email-index') {
          throw new Error(`leadTableFake: unsupported query on ${p.TableName}/${p.IndexName}`);
        }
        const v = p.ExpressionAttributeValues;
        // The GSI only ever sees rows that carry the key attribute, like the real one.
        const items = [...self.leads.values()].filter((l) => l.listId === v[':listId'] && typeof l.email === 'string' && l.email === v[':email']);
        return { Items: clone(items) };
      }),
      put: wrap(async (p) => {
        const t = self.table(p.TableName);
        const store = t === 'leads' ? self.leads : self.lists;
        const key = t === 'leads' ? self.leadKey(p.Item.listId, p.Item.leadId) : p.Item.listId;
        const usedN = new Set<string>();
        if (!self.checkCondition(p.ConditionExpression, store.get(key), p.ExpressionAttributeNames ?? {}, usedN)) {
          throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
        }
        store.set(key, clone(marshal(p.Item)));
        return {};
      }),
      update: wrap(async (p) => {
        const t = self.table(p.TableName);
        const names = p.ExpressionAttributeNames ?? {};
        const values = p.ExpressionAttributeValues ?? {};
        // Placeholders are "used" syntactically, like DynamoDB counts them: the default operand
        // of an if_not_exists that does not fire is still used.
        const text = `${p.UpdateExpression ?? ''} ${p.ConditionExpression ?? ''}`;
        const usedN = new Set<string>(text.match(/#[A-Za-z0-9_]+/g) ?? []);
        const usedV = new Set<string>(text.match(/:[A-Za-z0-9_]+/g) ?? []);
        for (const n of usedN) if (!(n in names)) throw vex(`An expression attribute name used in the document path is not defined; attribute name: ${n}`);
        for (const v of usedV) {
          if (!(v in values)) throw vex(`An expression attribute value used in expression is not defined; attribute value: ${v}`);
          if (values[v] === undefined) throw vex(`ExpressionAttributeValues contains an undefined value for ${v}`);
        }
        self.updates.push(clone(p));
        const key = t === 'leads' ? self.leadKey(p.Key.listId, p.Key.leadId) : p.Key.listId;
        const store = t === 'leads' ? self.leads : self.lists;
        const existing = store.get(key);
        if (!self.checkCondition(p.ConditionExpression, existing, names, usedN, values)) {
          throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
        }
        const item = existing ?? clone(p.Key);
        self.applyUpdate(item, p.UpdateExpression, names, values, usedN, usedV);
        for (const n of Object.keys(names)) if (!usedN.has(n)) throw vex(`Value provided in ExpressionAttributeNames unused in expressions: keys: {${n}}`);
        for (const v of Object.keys(values)) if (!usedV.has(v)) throw vex(`Value provided in ExpressionAttributeValues unused in expressions: keys: {${v}}`);
        const old = existing ? clone(existing) : undefined;
        store.set(key, item);
        if (p.ReturnValues === 'ALL_OLD') return { Attributes: old };
        if (p.ReturnValues === 'ALL_NEW') return { Attributes: clone(item) };
        return {};
      }),
    };
  }
}
