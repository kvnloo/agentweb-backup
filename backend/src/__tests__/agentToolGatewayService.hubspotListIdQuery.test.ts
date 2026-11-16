import { validateAndRepairToolArgs } from '../services/agentToolGatewayService';

// ENG-2570: repro shapes from prod session 6935593b-1c8b-4754-8921-5ba039060cb9.
const schema = {
  type: 'object',
  properties: {
    entity_type: { type: 'string' },
    action: { type: 'string' },
    list_id: { type: 'string' },
    query: { type: 'string' },
  },
  required: ['entity_type', 'action'],
};

function run(args: Record<string, unknown>, toolName = 'call_hubspot_api') {
  return validateAndRepairToolArgs({ toolName, args, inputSchema: schema, effect: 'read' });
}

describe('call_hubspot_api CONTACT_LIST GET list id in query (ENG-2570)', () => {
  it.each([
    [{ listId: '17' }],
    [{ list_id: 17 }],
    ['listId=17'],
    ['list_id=17'],
    ['list_id: 17'],
    [17],
    ['17'],
  ])('moves %p into list_id', (query) => {
    const result = run({ entity_type: 'CONTACT_LIST', action: 'GET', query });
    expect(result.status).toBe('repaired');
    expect(result.args).toEqual({ entity_type: 'CONTACT_LIST', action: 'GET', list_id: '17' });
    expect(result.repairs).toContain('query->list_id');
  });

  it('never overwrites an existing list_id', () => {
    const result = run({ entity_type: 'CONTACT_LIST', action: 'GET', list_id: '5', query: 'listId=17' });
    expect(result.args).toMatchObject({ list_id: '5', query: 'listId=17' });
    expect(result.repairs).not.toContain('query->list_id');
  });

  it('leaves free-text queries and other actions alone', () => {
    expect(run({ entity_type: 'CONTACT_LIST', action: 'GET', query: 'newsletter 17' }).args)
      .toMatchObject({ query: 'newsletter 17' });
    expect(run({ entity_type: 'CONTACT_LIST', action: 'LIST', query: '17' }).args)
      .toEqual({ entity_type: 'CONTACT_LIST', action: 'LIST', query: '17' });
    expect(run({ entity_type: 'CONTACT_LIST', action: 'DELETE', query: 17 }).repairs)
      .not.toContain('query->list_id');
    expect(run({ entity_type: 'CONTACT', action: 'GET', query: '17' }).args)
      .toEqual({ entity_type: 'CONTACT', action: 'GET', query: '17' });
  });

  it('does not touch other tools', () => {
    const result = run({ entity_type: 'CONTACT_LIST', action: 'GET', query: 'listId=17' }, 'other_tool');
    expect(result.args).toEqual({ entity_type: 'CONTACT_LIST', action: 'GET', query: 'listId=17' });
  });

  it('ignores multi-key query objects', () => {
    const result = run({ entity_type: 'CONTACT_LIST', action: 'GET', query: { listId: '17', name: 'x' } });
    expect(result.repairs).not.toContain('query->list_id');
  });
});
