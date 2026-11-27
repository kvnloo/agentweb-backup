/**
 * ENG-2840: Emma's gateway classifies call_hubspot_api actions by effect. SUBMIT, ENABLE, UNPUBLISH, DISABLE and asset changes were
 * labelled reads (safe to repeat, no confirmation flag); only the known reads are reads now, and an unknown action is a write.
 */
import { evaluateAgentToolPolicy } from '../services/agentToolGatewayService';

const effect = (action: string) => evaluateAgentToolPolicy({ toolName: 'call_hubspot_api', args: { action, entity_type: 'WORKFLOW' } } as any).effect;

it.each([
  ['ENABLE', 'external_publish'],
  ['SUBMIT', 'external_send'],
  ['UNPUBLISH', 'destructive'],
  ['DISABLE', 'internal_write'],
  ['ADD_ASSET', 'internal_write'],
  ['REMOVE_ASSET', 'internal_write'],
  ['SOMETHING_NEW', 'internal_write'],
  ['', 'internal_write'],
])('%s is %s', (action, expected) => {
  expect(effect(action)).toBe(expected);
});

it.each(['GET', 'LIST', 'SEARCH', 'GET_CONTACTS', 'GET_FORM_FIELDS', 'GET_METRICS', 'GET_PERFORMANCE', 'GET_STATS', 'GET_SUBMISSIONS', 'LIST_ASSETS', 'LIST_BROADCASTS', 'LIST_CHANNELS', 'LIST_PIPELINES', 'LIST_SUBSCRIPTION_TYPES', 'get'])('%s is a read', (action) => {
  expect(effect(action)).toBe('read');
});

it('the existing write classes are unchanged', () => {
  expect(effect('CREATE_BROADCAST')).toBe('external_publish');
  expect(effect('DELETE')).toBe('destructive');
  expect(effect('PUBLISH')).toBe('destructive');
  expect(effect('UPDATE')).toBe('internal_write');
});

it('a write gets the confirmation flag', () => {
  const d = evaluateAgentToolPolicy({ toolName: 'call_hubspot_api', args: { action: 'ENABLE' } } as any);
  expect(d.flags.map((f) => f.code)).toContain('confirmation_recommended');
});
