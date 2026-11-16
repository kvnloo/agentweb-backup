import { AGENTWEB_MODEL_ID, withoutAgentWebModel } from '../agentWebModel';

describe('withoutAgentWebModel (ENG-669 PR-C)', () => {
  it('drops the AgentWeb Model from an id list and from a catalog list, keeping order', () => {
    expect(withoutAgentWebModel(['gemini-3.8-flash', AGENTWEB_MODEL_ID, 'gpt-5.5'])).toEqual(['gemini-3.8-flash', 'gpt-5.5']);
    expect(withoutAgentWebModel([{ id: 'gemini-3.8-flash' }, { id: AGENTWEB_MODEL_ID }])).toEqual([{ id: 'gemini-3.8-flash' }]);
  });

  it('leaves lists without it unchanged', () => {
    expect(withoutAgentWebModel(['gpt-5.5'])).toEqual(['gpt-5.5']);
    expect(withoutAgentWebModel([])).toEqual([]);
  });
});
