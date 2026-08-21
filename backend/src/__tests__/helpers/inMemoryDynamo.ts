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

    throw new Error(`inMemoryDynamo: unsupported ConditionExpression clause: ${clause}`);
  }
}

/** `SET a = :x, b = :y REMOVE #c, #d` — the only forms this codebase emits. */
function applyUpdateExpression(
  item: Record<string, any>,
  expression: string,
  names: Record<string, string>,
  values: Record<string, any>,
) {
  const setMatch = expression.match(/SET\s+(.*?)(?=\s+REMOVE\s+|$)/is);
  const removeMatch = expression.match(/REMOVE\s+(.*)$/is);

  if (!setMatch && !removeMatch) {
    throw new Error(`inMemoryDynamo: unsupported UpdateExpression: ${expression}`);
  }
  // A bare `SET ` with no assignments is a syntax error in real DynamoDB.
  if (/SET\s*(REMOVE|$)/i.test(expression.trim()) && !setMatch?.[1]?.trim()) {
    throw Object.assign(new Error('ValidationException: Invalid UpdateExpression: empty SET'), {
      code: 'ValidationException',
    });
  }

  if (setMatch?.[1]) {
    for (const assignment of setMatch[1].split(',')) {
      const [rawTarget, rawValue] = assignment.split('=').map((part) => part.trim());
      if (!rawTarget || !rawValue) continue;
      if (/list_append|if_not_exists/i.test(rawValue)) {
        throw new Error(`inMemoryDynamo: unsupported SET function: ${rawValue}`);
      }
      item[resolveName(rawTarget, names)] = values[rawValue];
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
            const schema = self.schema(params.TableName);
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
    };
  }
}
