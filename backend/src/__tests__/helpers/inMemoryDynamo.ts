/**
 * A DynamoDB DocumentClient that executes expressions instead of recording them.
 *
 * Both ENG-1217 defects survived a full unit suite because the tests mocked
 * `scheduleDb`/`llmModelChangeAuditDb` and asserted the ARGUMENTS handed to them.
 * The bugs were in what the real call did with those arguments: one wrote
 * `SET #llmModel = :llmModel` with a value the marshaller silently dropped, and
 * one stored `undoneAt: null` so `attribute_not_exists(undoneAt)` was false from
 * the moment the row was created. Neither is visible from the call site.
 *
 * So this runs the query builders for real and applies the result to a plain Map.
 * The single most valuable thing it does is `assertPlaceholdersResolved`: any
 * `:name` appearing in an expression must actually be supplied. That is exactly
 * the class of failure DynamoDB rejects at runtime and a mock cannot see, and it
 * is mechanical rather than a matter of remembering to check.
 *
 * Deliberately a SUBSET. It implements only the expression forms this codebase
 * uses; anything else throws loudly rather than quietly passing, because a test
 * harness that silently ignores an expression it does not understand is how the
 * original bugs got through.
 */

export interface TableKeySchema {
  hash: string;
  range?: string;
  /** Global secondary indexes, by IndexName. Items lacking the index's hash attribute are not in it. */
  indexes?: Record<string, { hash: string; range?: string }>;
}

/**
 * NUL joins the composite key so no hash/range value can forge another item's key.
 *
 * Written as the ESCAPE `\x00`, never as a literal NUL byte. A raw NUL makes git
 * classify this file as binary, and a binary file gets no diff — which is why this
 * helper landed in #2407 showing `+0 -0`, unreviewed by both bots, despite being
 * the harness that validates the model-change writes. Same string at runtime; the
 * difference is only whether anyone can read the change.
 */
const keyOf = (schema: TableKeySchema, item: Record<string, any>) =>
  schema.range ? `${item[schema.hash]}\x00${item[schema.range]}` : String(item[schema.hash]);

/** Values the marshaller would drop, which is what makes an expression unresolvable. */
function assertPlaceholdersResolved(expression: string | undefined, values: Record<string, any>) {
  if (!expression) return;
  for (const placeholder of expression.match(/:[A-Za-z0-9_]+/g) || []) {
    if (!(placeholder in values)) {
      throw Object.assign(
        new Error(
          `ValidationException: An expression attribute value used in expression is not defined; attribute value: ${placeholder}`,
        ),
        { code: 'ValidationException' },
      );
    }
    if (values[placeholder] === undefined) {
      throw Object.assign(
        new Error(
          `ValidationException: ExpressionAttributeValues contains an undefined value for ${placeholder}; the marshaller drops it before the request is sent`,
        ),
        { code: 'ValidationException' },
      );
    }
  }
}

function resolveName(token: string, names: Record<string, string>): string {
  return token.startsWith('#') ? names[token] ?? token.slice(1) : token;
}

/**
 * `attribute_exists(x) AND attribute_not_exists(y) AND #a = :b AND size(#l) = :n`,
 * plus one parenthesised disjunction: `(attribute_not_exists(#a) OR #a = :a)`.
 *
 * ENG-1363 added the OR — "still unset" has to match both an absent attribute and
 * an empty string. Splitting only on AND silently treated the whole disjunction as
 * one unrecognised clause, so the harness has to learn it or it throws.
 */
function evaluateCondition(
  expression: string | undefined,
  item: Record<string, any> | undefined,
  names: Record<string, string>,
  values: Record<string, any>,
): boolean {
  if (!expression) return true;
  return expression.split(/\s+AND\s+/i).every((rawClause) =>
    evaluateClause(rawClause.trim(), item, names, values),
  );
}

function evaluateClause(
  clause: string,
  item: Record<string, any> | undefined,
  names: Record<string, string>,
  values: Record<string, any>,
): boolean {
  {
    // A parenthesised disjunction. Only unwrapped when it actually contains OR, so
    // any other parenthesised form still reaches the matchers below and throws
    // rather than being silently accepted.
    if (clause.startsWith('(') && clause.endsWith(')')) {
      const inner = clause.slice(1, -1).trim();
      if (/\s+OR\s+/i.test(inner)) {
        return inner
          .split(/\s+OR\s+/i)
          .some((part) => evaluateClause(part.trim(), item, names, values));
      }
    }

    // A bare top-level OR (not already inside its own parens, which the branch above
    // handles) -- DynamoDB's real precedence is more general than this, but every
    // condition in this codebase is either a single clause, an AND of clauses, or
    // (as of the per-owner slot counter) one unparenthesized OR of two clauses.
    if (/\s+OR\s+/i.test(clause)) {
      return clause.split(/\s+OR\s+/i).some((part) => evaluateClause(part.trim(), item, names, values));
    }

    let match = clause.match(/^attribute_not_exists\(\s*([^)]+?)\s*\)$/i);
    if (match) {
      const attr = resolveName(match[1], names);
      return item === undefined || item[attr] === undefined;
    }

    match = clause.match(/^attribute_exists\(\s*([^)]+?)\s*\)$/i);
    if (match) {
      const attr = resolveName(match[1], names);
      return item !== undefined && item[attr] !== undefined;
    }

    match = clause.match(/^size\(\s*([^)]+?)\s*\)\s*=\s*(:[A-Za-z0-9_]+)$/i);
    if (match) {
      const attr = resolveName(match[1], names);
      return Array.isArray(item?.[attr]) && item[attr].length === values[match[2]];
    }

    match = clause.match(/^([#A-Za-z0-9_.[\]]+)\s*=\s*(:[A-Za-z0-9_]+)$/);
    if (match) {
      const attr = resolveName(match[1], names);
      return item?.[attr] === values[match[2]];
    }

    match = clause.match(/^([#A-Za-z0-9_.[\]]+)\s*([<>])\s*(:[A-Za-z0-9_]+)$/);
    if (match) {
      const attr = resolveName(match[1], names);
      const left = item?.[attr];
      if (typeof left !== 'number') return false;
      return match[2] === '<' ? left < values[match[3]] : left > values[match[3]];
    }

    throw new Error(`inMemoryDynamo: unsupported ConditionExpression clause: ${clause}`);
  }
}

/** `SET a = :x, b = :y REMOVE #c, #d` — the only forms this codebase emits. */
/**
 * Splits a SET clause's assignments on top-level commas only. A plain `.split(',')`
 * would also split inside a function call's own argument list -- exactly what
 * `if_not_exists(activeCount, :zero)` has -- cutting one assignment into two
 * unparseable halves instead of separating two assignments.
 */
function splitTopLevelCommas(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expression.length; i++) {
    const ch = expression[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(expression.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(expression.slice(start));
  return parts;
}

/**
 * The right-hand side of one SET assignment. Supports exactly the forms this
 * codebase writes: a bare placeholder, `attr +/- :delta`, and the counter pattern
 * `if_not_exists(attr, :default) +/- :delta`. Anything else throws loudly rather
 * than silently computing the wrong number.
 */
function evaluateSetValue(
  rawValue: string,
  item: Record<string, any>,
  names: Record<string, string>,
  values: Record<string, any>,
): any {
  let match = rawValue.match(
    /^if_not_exists\(\s*([^,]+?)\s*,\s*(:[A-Za-z0-9_]+)\s*\)\s*([+-])\s*(:[A-Za-z0-9_]+)$/i,
  );
  if (match) {
    const attr = resolveName(match[1], names);
    const base = item[attr] !== undefined ? item[attr] : values[match[2]];
    const delta = values[match[4]];
    return match[3] === '+' ? base + delta : base - delta;
  }

  match = rawValue.match(/^(#?[A-Za-z0-9_]+)\s*([+-])\s*(:[A-Za-z0-9_]+)$/);
  if (match) {
    const attr = resolveName(match[1], names);
    if (item[attr] === undefined) {
      throw new Error(`inMemoryDynamo: SET arithmetic on a missing attribute: ${rawValue}`);
    }
    const delta = values[match[3]];
    return match[2] === '+' ? item[attr] + delta : item[attr] - delta;
  }

  if (/^:[A-Za-z0-9_]+$/.test(rawValue)) return values[rawValue];
  throw new Error(`inMemoryDynamo: unsupported SET value: ${rawValue}`);
}

/**
 * The members of a String Set value, whichever way the test holds it: a DocumentClient `DynamoDBSet` (what `createSet` hands the
 * code under test, and what a read hands it back), or a bare array. Anything else is a malformed ADD / DELETE operand, which real
 * DynamoDB rejects with a ValidationException, so this throws rather than guessing.
 */
function setMembers(value: any, clause: string): string[] {
  const members = value && typeof value === 'object' && Array.isArray(value.values) ? value.values : Array.isArray(value) ? value : null;
  if (!members) {
    throw Object.assign(new Error(`ValidationException: operand of ${clause} is not a set`), { code: 'ValidationException' });
  }
  return members;
}

let realDocumentClient: { createSet(list: string[]): unknown } | undefined;

/**
 * A new String Set, so a stored set is never mutated in place by a later write. Built by the REAL SDK's `createSet` (the tests that
 * use this helper mock 'aws-sdk' with the fake client), so it is the same `DynamoDBSet` object the code under test builds and a
 * real read returns, not a look-alike.
 */
function newStringSet(members: string[]) {
  if (!realDocumentClient) {
    const actual = jest.requireActual('aws-sdk');
    realDocumentClient = new actual.DynamoDB.DocumentClient({ region: 'us-west-2' });
  }
  return realDocumentClient!.createSet(members) as { values: string[] };
}

function applyUpdateExpression(
  item: Record<string, any>,
  expression: string,
  names: Record<string, string>,
  values: Record<string, any>,
) {
  // Each verb's body runs to the next verb (or the end). ADD and DELETE are the String Set / number operations real DynamoDB
  // has; they may follow SET and REMOVE in one expression, and ADD and DELETE on the SAME path may not share one.
  const setMatch = expression.match(/SET\s+(.*?)(?=\s+(?:REMOVE|ADD|DELETE)\s+|$)/is);
  const removeMatch = expression.match(/REMOVE\s+(.*?)(?=\s+(?:ADD|DELETE)\s+|$)/is);
  const addMatch = expression.match(/(?:^|\s)ADD\s+(.*?)(?=\s+DELETE\s+|$)/is);
  const deleteMatch = expression.match(/(?:^|\s)DELETE\s+(.*)$/is);

  if (!setMatch && !removeMatch && !addMatch && !deleteMatch) {
    throw new Error(`inMemoryDynamo: unsupported UpdateExpression: ${expression}`);
  }
  if (addMatch && deleteMatch) {
    const touched = (body: string) => body.split(',').map((part) => resolveName(part.trim().split(/\s+/)[0], names));
    const overlap = touched(addMatch[1]).filter((attr) => touched(deleteMatch[1]).includes(attr));
    if (overlap.length > 0) {
      throw Object.assign(new Error(`ValidationException: Two document paths overlap with each other: ${overlap[0]}`), {
        code: 'ValidationException',
      });
    }
  }
  // A bare `SET ` with no assignments is a syntax error in real DynamoDB.
  if (/SET\s*(REMOVE|$)/i.test(expression.trim()) && !setMatch?.[1]?.trim()) {
    throw Object.assign(new Error('ValidationException: Invalid UpdateExpression: empty SET'), {
      code: 'ValidationException',
    });
  }

  if (setMatch?.[1]) {
    for (const assignment of splitTopLevelCommas(setMatch[1])) {
      const [rawTarget, rawValue] = assignment.split('=').map((part) => part.trim());
      if (!rawTarget || !rawValue) continue;
      if (/list_append/i.test(rawValue)) {
        throw new Error(`inMemoryDynamo: unsupported SET function: ${rawValue}`);
      }
      item[resolveName(rawTarget, names)] = evaluateSetValue(rawValue, item, names, values);
    }
  }

  if (removeMatch?.[1]) {
    for (const rawTarget of removeMatch[1].split(',')) {
      const target = rawTarget.trim();
      const indexed = target.match(/^(#?[A-Za-z0-9_]+)\[(\d+)\]$/);
      if (indexed) {
        const attr = resolveName(indexed[1], names);
        if (Array.isArray(item[attr])) item[attr].splice(Number(indexed[2]), 1);
        continue;
      }
      delete item[resolveName(target, names)];
    }
  }

  // ADD: a number adds to the attribute (absent counts as 0); a String Set unions into it (absent is an empty set). Adding a
  // set to an attribute that holds something else (a List, say) is a type mismatch, as it is in DynamoDB.
  for (const clause of addMatch?.[1] ? splitTopLevelCommas(addMatch[1]) : []) {
    const [rawTarget, rawValue] = clause.trim().split(/\s+/);
    const attr = resolveName(rawTarget, names);
    const operand = values[rawValue];
    if (typeof operand === 'number') {
      item[attr] = (item[attr] ?? 0) + operand;
      continue;
    }
    const incoming = setMembers(operand, `ADD ${rawTarget}`);
    if (item[attr] !== undefined && !(typeof item[attr] === 'object' && Array.isArray(item[attr].values))) {
      throw Object.assign(new Error(`ValidationException: An operand in the update expression has an incorrect data type (ADD ${attr})`), {
        code: 'ValidationException',
      });
    }
    item[attr] = newStringSet([...new Set([...(item[attr]?.values ?? []), ...incoming])]);
  }

  // DELETE: removes the operand's members from a String Set; a set left empty is removed from the item, as DynamoDB does.
  for (const clause of deleteMatch?.[1] ? splitTopLevelCommas(deleteMatch[1]) : []) {
    const [rawTarget, rawValue] = clause.trim().split(/\s+/);
    const attr = resolveName(rawTarget, names);
    const outgoing = new Set(setMembers(values[rawValue], `DELETE ${rawTarget}`));
    if (item[attr] === undefined) continue;
    if (!(typeof item[attr] === 'object' && Array.isArray(item[attr].values))) {
      throw Object.assign(new Error(`ValidationException: An operand in the update expression has an incorrect data type (DELETE ${attr})`), {
        code: 'ValidationException',
      });
    }
    const left = item[attr].values.filter((member: string) => !outgoing.has(member));
    if (left.length === 0) delete item[attr];
    else item[attr] = newStringSet(left);
  }
}

export class InMemoryDynamo {
  readonly tables = new Map<string, Map<string, Record<string, any>>>();
  private readonly schemas = new Map<string, TableKeySchema>();

  constructor(schemas: Record<string, TableKeySchema>) {
    for (const [table, schema] of Object.entries(schemas)) {
      this.schemas.set(table, schema);
      this.tables.set(table, new Map());
    }
  }

  private schema(tableName: string): TableKeySchema {
    const schema = this.schemas.get(tableName);
    if (!schema) throw new Error(`inMemoryDynamo: no schema registered for ${tableName}`);
    return schema;
  }

  private store(tableName: string) {
    const store = this.tables.get(tableName);
    if (!store) throw new Error(`inMemoryDynamo: unknown table ${tableName}`);
    return store;
  }

  /** Every item currently in a table, for assertions. */
  items(tableName: string): Record<string, any>[] {
    return [...this.store(tableName).values()];
  }

  seed(tableName: string, item: Record<string, any>) {
    this.store(tableName).set(keyOf(this.schema(tableName), item), { ...item });
  }

  get documentClient() {
    const self = this;
    return class DocumentClient {
      /** The real DocumentClient's `createSet`: code under test builds its ADD / DELETE operands with it. */
      createSet(list: any[]) {
        return newStringSet(list);
      }

      put(params: any) {
        return {
          promise: async () => {
            const schema = self.schema(params.TableName);
            const store = self.store(params.TableName);
            const key = keyOf(schema, params.Item);
            const names = params.ExpressionAttributeNames || {};
            const values = params.ExpressionAttributeValues || {};
            assertPlaceholdersResolved(params.ConditionExpression, values);
            if (!evaluateCondition(params.ConditionExpression, store.get(key), names, values)) {
              throw Object.assign(new Error('The conditional request failed'), {
                code: 'ConditionalCheckFailedException',
              });
            }
            // Mirror the marshaller: undefined-valued attributes never land.
            const stored: Record<string, any> = {};
            for (const [k, v] of Object.entries(params.Item)) {
              if (v !== undefined) stored[k] = v;
            }
            store.set(key, stored);
            return {};
          },
        };
      }

      get(params: any) {
        return {
          promise: async () => ({
            Item: self.store(params.TableName).get(keyOf(self.schema(params.TableName), params.Key)),
          }),
        };
      }

      update(params: any) {
        return {
          promise: async () => {
            const schema = self.schema(params.TableName);
            const store = self.store(params.TableName);
            const key = keyOf(schema, params.Key);
            const names = params.ExpressionAttributeNames || {};
            const values = params.ExpressionAttributeValues || {};

            assertPlaceholdersResolved(params.UpdateExpression, values);
            assertPlaceholdersResolved(params.ConditionExpression, values);

            const existing = store.get(key);
            if (!evaluateCondition(params.ConditionExpression, existing, names, values)) {
              throw Object.assign(new Error('The conditional request failed'), {
                code: 'ConditionalCheckFailedException',
              });
            }
            const item = { ...(existing || params.Key) };
            applyUpdateExpression(item, params.UpdateExpression, names, values);
            store.set(key, item);
            return { Attributes: item };
          },
        };
      }

      query(params: any) {
        return {
          promise: async () => {
            const tableSchema = self.schema(params.TableName);
            const schema = params.IndexName ? tableSchema.indexes?.[params.IndexName] : tableSchema;
            if (!schema) {
              throw new Error(`inMemoryDynamo: no index ${params.IndexName} registered for ${params.TableName}`);
            }
            const values = params.ExpressionAttributeValues || {};
            const names = params.ExpressionAttributeNames || {};
            assertPlaceholdersResolved(params.KeyConditionExpression, values);

            const expression: string = params.KeyConditionExpression || '';
            const hashMatch = expression.match(
              new RegExp(`(#?${schema.hash})\\s*=\\s*(:[A-Za-z0-9_]+)`),
            );
            if (!hashMatch) {
              throw new Error(`inMemoryDynamo: unsupported KeyConditionExpression: ${expression}`);
            }
            const hashValue = values[hashMatch[2]];

            const between = expression.match(
              /(#?[A-Za-z0-9_]+)\s+BETWEEN\s+(:[A-Za-z0-9_]+)\s+AND\s+(:[A-Za-z0-9_]+)/i,
            );
            const beginsWith = expression.match(
              /begins_with\(\s*(#?[A-Za-z0-9_]+)\s*,\s*(:[A-Za-z0-9_]+)\s*\)/i,
            );

            let items = [...self.store(params.TableName).values()].filter(
              (item) => item[schema.hash] === hashValue,
            );

            if (between) {
              const attr = resolveName(between[1], names);
              const low = values[between[2]];
              const high = values[between[3]];
              items = items.filter((item) => item[attr] >= low && item[attr] <= high);
            } else if (beginsWith) {
              const attr = resolveName(beginsWith[1], names);
              items = items.filter((item) => String(item[attr]).startsWith(values[beginsWith[2]]));
            }

            if (schema.range) {
              items.sort((a, b) =>
                String(a[schema.range!]).localeCompare(String(b[schema.range!])),
              );
              if (params.ScanIndexForward === false) items.reverse();
            }
            return { Items: items, LastEvaluatedKey: undefined };
          },
        };
      }

      scan(params: any) {
        return {
          promise: async () => ({
            Items: [...self.store(params.TableName).values()],
            LastEvaluatedKey: undefined,
          }),
        };
      }

      delete(params: any) {
        return {
          promise: async () => {
            self.store(params.TableName).delete(keyOf(self.schema(params.TableName), params.Key));
            return {};
          },
        };
      }

      /**
       * Evaluates every item's condition against the CURRENT state before applying any
       * write, matching DynamoDB's all-or-nothing semantics. Nothing here `await`s
       * mid-check, so two calls racing through the real event loop still serialize at
       * this boundary exactly as the real service does -- any race survives only in the
       * caller's own `await`s around the transaction, which is the thing a concurrency
       * test here is checking is actually closed.
       */
      transactWrite(params: { TransactItems: any[] }) {
        return {
          promise: async () => {
            const reasons: Array<{ Code?: string }> = [];
            const apply: Array<() => void> = [];
            let failed = false;
            for (const entry of params.TransactItems) {
              const [kind, op] = Object.entries(entry)[0] as [string, any];
              const schema = self.schema(op.TableName);
              const store = self.store(op.TableName);
              const key = keyOf(schema, kind === 'Put' ? op.Item : op.Key);
              const names = op.ExpressionAttributeNames || {};
              const values = op.ExpressionAttributeValues || {};
              const existing = store.get(key);
              if (kind === 'Update') assertPlaceholdersResolved(op.UpdateExpression, values);
              assertPlaceholdersResolved(op.ConditionExpression, values);
              const ok = evaluateCondition(op.ConditionExpression, existing, names, values);
              reasons.push(ok ? {} : { Code: 'ConditionalCheckFailed' });
              if (!ok) {
                failed = true;
                continue;
              }
              if (kind === 'Put') {
                apply.push(() => {
                  const stored: Record<string, any> = {};
                  for (const [k, v] of Object.entries(op.Item)) if (v !== undefined) stored[k] = v;
                  store.set(key, stored);
                });
              } else if (kind === 'Update') {
                apply.push(() => {
                  const item = { ...(existing || op.Key) };
                  applyUpdateExpression(item, op.UpdateExpression, names, values);
                  store.set(key, item);
                });
              } else if (kind === 'Delete') {
                apply.push(() => store.delete(key));
              } else if (kind === 'ConditionCheck') {
                // nothing to apply; the condition above is the whole point
              } else {
                throw new Error(`inMemoryDynamo: unsupported TransactItem: ${kind}`);
              }
            }
            if (failed) {
              throw Object.assign(new Error('Transaction cancelled'), {
                code: 'TransactionCanceledException',
                CancellationReasons: reasons,
              });
            }
            for (const run of apply) run();
            return {};
          },
        };
      }
    };
  }
}
