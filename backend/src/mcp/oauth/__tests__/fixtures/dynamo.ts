/** Small stateful DynamoDB double: evaluates expressions, rejects unknown syntax,
 * and commits transactions all-or-nothing. No production AWS/network calls. */
export class OAuthDynamoFixture {
  rows = new Map<string, any>();
  beforeWrite?: (params: any) => void;
  queryItems?: any[];
  key(p: any) { return `${p.TableName}:${p.Key?.code || p.Key?.tokenHash || p.Key?.clientId || p.Item?.code || p.Item?.tokenHash || p.Item?.clientId}`; }
  condition(p: any, row: any): boolean {
    if (!p.ConditionExpression) return true;
    const v = p.ExpressionAttributeValues || {};
    return p.ConditionExpression.split(' AND ').map((clause: string) => {
      const exists = /^(attribute_exists|attribute_not_exists)\((\w+)\)$/.exec(clause);
      if (exists) return exists[1] === 'attribute_exists' ? row?.[exists[2]] !== undefined : row?.[exists[2]] === undefined;
      const match = /^(\w+) (=|>) (:\w+)$/.exec(clause);
      if (!match || !(match[3] in v)) throw new Error(`Unsupported condition: ${clause}`);
      return match[2] === '=' ? row?.[match[1]] === v[match[3]] : row?.[match[1]] > v[match[3]];
    }).every(Boolean);
  }
  apply(p: any) {
    if (p.Item) { this.rows.set(this.key(p), { ...p.Item }); return; }
    if (!p.UpdateExpression) return;
    if (!p.UpdateExpression.startsWith('SET ')) throw new Error('Unsupported update');
    const row = { ...p.Key, ...this.rows.get(this.key(p)) };
    for (const assignment of p.UpdateExpression.slice(4).split(', ')) {
      const match = /^(\w+) = (:\w+)$/.exec(assignment);
      if (!match || !(match[2] in p.ExpressionAttributeValues)) throw new Error(`Unsupported update: ${assignment}`);
      row[match[1]] = p.ExpressionAttributeValues[match[2]];
    }
    this.rows.set(this.key(p), row);
  }
  get = jest.fn((p: any) => ({ promise: async () => ({ Item: this.rows.has(this.key(p)) ? { ...this.rows.get(this.key(p)) } : undefined }) }));
  put = jest.fn((p: any) => ({ promise: async () => { this.apply(p); return {}; } }));
  query = jest.fn((p: any) => ({ promise: async () => ({ Items: this.queryItems ?? [...this.rows.values()].filter(r => r.refreshTokenHash === p.ExpressionAttributeValues[':hash']).map(r => ({ ...r })) }) }));
  update = jest.fn((p: any) => ({ promise: async () => {
    this.beforeWrite?.(p);
    if (!this.condition(p, this.rows.get(this.key(p)))) throw Object.assign(new Error('Condition failed'), { code: 'ConditionalCheckFailedException' });
    this.apply(p); return {};
  } }));
  transactWrite = jest.fn((p: any) => ({ promise: async () => {
    this.beforeWrite?.(p);
    const actions = p.TransactItems.map((a: any) => a.Update || a.Put || a.ConditionCheck);
    if (new Set(actions.map((a: any) => this.key(a))).size !== actions.length) throw new Error('Duplicate transaction target');
    const reasons = actions.map((a: any) => ({ Code: this.condition(a, this.rows.get(this.key(a))) ? 'None' : 'ConditionalCheckFailed' }));
    if (reasons.some((r: any) => r.Code !== 'None')) throw Object.assign(new Error('Transaction cancelled'), { code: 'TransactionCanceledException', CancellationReasons: reasons });
    actions.forEach((a: any) => this.apply(a)); return {};
  } }));
}
