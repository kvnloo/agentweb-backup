import { SentMessageLedger } from '../services/sentMessageLedger';

const input = { orgId: 'org-1', channel: 'email' as const, recipient: 'Person@Example.com', campaignId: 'campaign-1', step: '1' };

describe('permanent sent-message ledger', () => {
  const deps = () => ({
    put: jest.fn((_params: any) => ({ promise: async () => undefined })),
    update: jest.fn((_params: any) => ({ promise: async () => undefined })),
    transactWrite: jest.fn((_params: any) => ({ promise: async () => undefined })),
  });

  it('marks unknown provider outcomes ambiguous and never retries the provider', async () => {
    const client = deps();
    const provider = jest.fn(async () => { throw new Error('timeout'); });
    await expect(new SentMessageLedger(client as any, 'test').send(input, provider)).rejects.toThrow('timeout');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(client.update.mock.calls[0][0].ExpressionAttributeValues[':ambiguous']).toBe('ambiguous');
    expect(client.transactWrite).not.toHaveBeenCalled();
  });

  it('fails closed on storage failure before sending', async () => {
    const client = deps();
    client.put.mockImplementation(() => ({ promise: async () => { throw new Error('Dynamo unavailable'); } }));
    const provider = jest.fn();
    await expect(new SentMessageLedger(client as any, 'test').send(input, provider)).rejects.toThrow('Dynamo unavailable');
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not retry a successful provider when finalization fails', async () => {
    const client = deps();
    client.transactWrite.mockImplementation(() => ({ promise: async () => { throw new Error('write failed'); } }));
    const provider = jest.fn(async () => ({ id: 'accepted' }));
    await expect(new SentMessageLedger(client as any, 'test').send(input, provider)).rejects.toThrow('write failed');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('scopes keys by org and campaign and normalizes email but not opaque LinkedIn IDs', async () => {
    const client = deps();
    const ledger = new SentMessageLedger(client as any, 'test');
    const keys: string[] = [];
    const provider = async (key: string) => { keys.push(key); return { id: 'ok' }; };
    await ledger.send(input, provider);
    await ledger.send({ ...input, recipient: 'person@example.com' }, provider);
    await ledger.send({ ...input, orgId: 'org-2' }, provider);
    await ledger.send({ ...input, campaignId: 'campaign-2' }, provider);
    await ledger.send({ ...input, channel: 'linkedin', recipient: 'AbC' }, provider);
    await ledger.send({ ...input, channel: 'linkedin', recipient: 'abc' }, provider);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(5);
  });

  it('rejects incomplete identities before any persistence or send', async () => {
    const client = deps();
    const provider = jest.fn();
    await expect(new SentMessageLedger(client as any, 'test').send({ ...input, campaignId: '' }, provider)).rejects.toThrow('nonempty');
    expect(client.put).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it('allows only one concurrent provider call and persists its provider id', async () => {
    const rows = new Map<string, any>();
    const client: any = {
      put: jest.fn((p: any) => ({ promise: async () => {
        const key = `${p.Item.orgId}/${p.Item.sk}`;
        if (rows.has(key)) throw Object.assign(new Error('duplicate'), { code: 'ConditionalCheckFailedException' });
        rows.set(key, p.Item);
      } })),
      transactWrite: jest.fn((p: any) => ({ promise: async () => {
        for (const item of p.TransactItems) {
          if (item.Put) rows.set(`${item.Put.Item.orgId}/${item.Put.Item.sk}`, item.Put.Item);
        }
      } })),
      update: jest.fn((_params: any) => ({ promise: async () => undefined })),
    };
    const ledger = new SentMessageLedger(client, 'test-ledger');
    const provider = jest.fn(async () => ({ id: 'provider-1' }));
    const results = await Promise.all([ledger.send(input, provider), ledger.send(input, provider)]);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(results.map(r => r.status).sort()).toEqual(['blocked', 'sent']);
    const sent = [...rows.values()].find(r => r.sk.startsWith('SENT#'));
    expect(sent.providerId).toBe('provider-1');
    expect(sent).not.toHaveProperty('ttl');
    expect(client.transactWrite.mock.calls[0][0].TransactItems[0].Update.ConditionExpression).toContain(':token');
  });
});
