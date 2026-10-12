/**
 * ENG-112: a small in-memory DynamoDB DocumentClient for the chat-branching tests.
 *
 * Unlike a recording mock it APPLIES writes, so the tests can inspect the session item and
 * message rows the real ChatbotDB code (createChatSession / addMessagesToSession /
 * updateSession*) actually produced. It implements only the expression forms those methods use
 * (SET / ADD / REMOVE with simple and dotted paths, key-condition queries, batchWrite) and
 * throws on anything else, so an unsupported expression fails the test instead of passing.
 */
const MESSAGES_SUFFIX = 'AW-ChatMessages';

type Item = Record<string, any>;

const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export class BranchFakeDynamo {
  readonly tables = new Map<string, Map<string, Item>>();
  /** When set, batchWrite reports these message indexes as UnprocessedItems forever (silent partial write). */
  dropMessageIndexes = new Set<number>();
  /** UserIdIndex queries: items per page (undefined = one page) and a switch that ignores the key condition. */
  indexPageSize: number | undefined = undefined;
  indexLeaksOtherUsers = false;
  readonly indexQueries: any[] = [];
  /** Every write call, in order: [op, table, key-ish]. */
  readonly writeLog: Array<{ op: string; table: string; key: string }> = [];

  private table(name: string): Map<string, Item> {
    let t = this.tables.get(name);
    if (!t) {
      t = new Map();
      this.tables.set(name, t);
    }
    return t;
  }

  private keyOf(tableName: string, item: Item): string {
    return tableName.endsWith(MESSAGES_SUFFIX) ? `${item.sessionId}\x00${item.messageIndex}` : String(item.sessionId);
  }

  sessions(): Map<string, Item> {
    return this.table([...this.tables.keys()].find((n) => n.endsWith('AW-ChatSessions')) ?? 'AW-ChatSessions');
  }

  seedSession(item: Item): void {
    this.table('AW-ChatSessions').set(String(item.sessionId), clone(item));
  }

  seedMessages(sessionId: string, messages: Item[]): void {
    const t = this.table(MESSAGES_SUFFIX);
    messages.forEach((message, messageIndex) => {
      t.set(`${sessionId}\x00${messageIndex}`, clone({ sessionId, messageIndex, message }));
    });
  }

  /** Seed rows at EXPLICIT raw indices (a store whose messageIndex values are not the array positions). */
  seedMessagesAt(sessionId: string, messages: Item[], rawIndexes: number[]): void {
    const t = this.table(MESSAGES_SUFFIX);
    messages.forEach((message, i) => {
      t.set(`${sessionId}\x00${rawIndexes[i]}`, clone({ sessionId, messageIndex: rawIndexes[i], message }));
    });
  }

  rows(sessionId: string): Array<{ messageIndex: number; message: Item }> {
    const t = this.table(MESSAGES_SUFFIX);
    return [...t.values()]
      .filter((i) => i.sessionId === sessionId)
      .sort((a, b) => a.messageIndex - b.messageIndex)
      .map((i) => clone(i) as { messageIndex: number; message: Item });
  }

  session(sessionId: string): Item | undefined {
    const t = this.table('AW-ChatSessions');
    const found = t.get(sessionId);
    return found ? clone(found) : undefined;
  }

  sessionIds(): string[] {
    return [...this.table('AW-ChatSessions').keys()];
  }

  private static wrap<T>(fn: () => T) {
    return { promise: async () => fn() };
  }

  client() {
    return {
      get: (p: any) =>
        BranchFakeDynamo.wrap(() => {
          const item = this.table(p.TableName).get(this.keyOf(p.TableName, p.Key));
          return item ? { Item: clone(item) } : {};
        }),
      put: (p: any) =>
        BranchFakeDynamo.wrap(() => {
          this.writeLog.push({ op: 'put', table: p.TableName, key: this.keyOf(p.TableName, p.Item) });
          this.table(p.TableName).set(this.keyOf(p.TableName, p.Item), clone(p.Item));
          return {};
        }),
      update: (p: any) =>
        BranchFakeDynamo.wrap(() => {
          const key = this.keyOf(p.TableName, p.Key);
          this.writeLog.push({ op: 'update', table: p.TableName, key });
          const t = this.table(p.TableName);
          if (p.ConditionExpression !== undefined) {
            if (p.ConditionExpression !== 'attribute_exists(sessionId)') {
              throw new Error(`BranchFakeDynamo: unsupported ConditionExpression: ${p.ConditionExpression}`);
            }
            if (!t.has(key)) {
              throw Object.assign(new Error('The conditional request failed'), { code: 'ConditionalCheckFailedException' });
            }
          }
          const item = t.get(key) ?? { ...clone(p.Key) };
          this.applyUpdate(item, p);
          t.set(key, item);
          return p.ReturnValues === 'ALL_NEW' ? { Attributes: clone(item) } : {};
        }),
      query: (p: any) =>
        BranchFakeDynamo.wrap(() => {
          if (p.IndexName === 'UserIdIndex') return this.queryUserIdIndex(p);
          const sessionId = p.ExpressionAttributeValues[':sessionId'];
          const items = [...this.table(p.TableName).values()]
            .filter((i) => i.sessionId === sessionId)
            .sort((a, b) => (a.messageIndex ?? 0) - (b.messageIndex ?? 0));
          if (p.ScanIndexForward === false) items.reverse();
          return p.Select === 'COUNT' ? { Count: items.length } : { Items: clone(items) };
        }),
      batchWrite: (p: any) =>
        BranchFakeDynamo.wrap(() => {
          const unprocessed: Record<string, any[]> = {};
          for (const [tableName, reqs] of Object.entries<any[]>(p.RequestItems)) {
            for (const r of reqs) {
              if (this.dropMessageIndexes.has(r.PutRequest.Item.messageIndex)) {
                (unprocessed[tableName] ??= []).push(r);
                continue;
              }
              this.writeLog.push({ op: 'batchPut', table: tableName, key: this.keyOf(tableName, r.PutRequest.Item) });
              this.table(tableName).set(this.keyOf(tableName, r.PutRequest.Item), clone(r.PutRequest.Item));
            }
          }
          return { UnprocessedItems: unprocessed };
        }),
    };
  }

  /** UserIdIndex (userId, updatedAt): only the plain `userId = :userId` key condition, paged by `indexPageSize`. */
  private queryUserIdIndex(p: any) {
    if (p.KeyConditionExpression !== 'userId = :userId' || p.FilterExpression !== undefined) {
      throw new Error(`BranchFakeDynamo: unsupported UserIdIndex query: ${p.KeyConditionExpression} / ${p.FilterExpression}`);
    }
    this.indexQueries.push(clone(p));
    const userId = p.ExpressionAttributeValues[':userId'];
    const all = [...this.table('AW-ChatSessions').values()]
      .filter((i) => this.indexLeaksOtherUsers || i.userId === userId)
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)) || String(a.sessionId).localeCompare(String(b.sessionId)));
    const start = p.ExclusiveStartKey ? all.findIndex((i) => i.sessionId === p.ExclusiveStartKey.sessionId) + 1 : 0;
    const size = this.indexPageSize ?? all.length;
    const page = all.slice(start, start + size);
    const more = start + size < all.length;
    const names: Record<string, string> = p.ExpressionAttributeNames ?? {};
    const attrs = p.ProjectionExpression
      ? String(p.ProjectionExpression).split(',').map((a) => a.trim()).map((a) => (a.startsWith('#') ? names[a] : a))
      : undefined;
    const project = (i: Item) => (attrs ? Object.fromEntries(attrs.filter((a) => a in i).map((a) => [a, i[a]])) : i);
    return {
      Items: clone(page.map(project)),
      ...(more ? { LastEvaluatedKey: { sessionId: page[page.length - 1].sessionId } } : {}),
    };
  }

  private applyUpdate(item: Item, p: any): void {
    const names: Record<string, string> = p.ExpressionAttributeNames ?? {};
    const values: Record<string, any> = p.ExpressionAttributeValues ?? {};
    const expr: string = p.UpdateExpression.replace(/\s+/g, ' ').trim();
    const parts = expr.split(/\b(SET|ADD|REMOVE)\b/).map((s) => s.trim()).filter(Boolean);
    const resolvePath = (raw: string) => raw.split('.').map((seg) => (seg.startsWith('#') ? names[seg] ?? seg.slice(1) : seg));
    const assign = (path: string[], value: any, mode: 'set' | 'add' | 'remove') => {
      let cur = item;
      for (const seg of path.slice(0, -1)) {
        cur[seg] ??= {};
        cur = cur[seg];
      }
      const last = path[path.length - 1];
      if (mode === 'remove') delete cur[last];
      else if (mode === 'add') cur[last] = (cur[last] ?? 0) + value;
      else cur[last] = clone(value);
    };
    for (let i = 0; i < parts.length; i += 2) {
      const verb = parts[i];
      const body = parts[i + 1] ?? '';
      for (const clause of body.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (verb === 'SET') {
          const m = clause.match(/^(\S+) = (:\w+)$/);
          if (!m) throw new Error(`BranchFakeDynamo: unsupported SET clause: ${clause}`);
          assign(resolvePath(m[1]), values[m[2]], 'set');
        } else if (verb === 'ADD') {
          const m = clause.match(/^(\S+) (:\w+)$/);
          if (!m) throw new Error(`BranchFakeDynamo: unsupported ADD clause: ${clause}`);
          assign(resolvePath(m[1]), values[m[2]], 'add');
        } else {
          assign(resolvePath(clause), undefined, 'remove');
        }
      }
    }
  }
}
