jest.mock('../services/agentModeService', () => ({ agentModeService: { callLLM: jest.fn() } }));
import { agentModeService } from '../services/agentModeService';
import { FIT_TIMEOUT_MS, fitSubmission, judgeLeadFit } from '../services/leadNotificationFitJudge';
const call = agentModeService.callLLM as jest.Mock;
beforeEach(() => jest.resetAllMocks());
it('returns bad verdict from full submission judgement', async () => {
  call.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ verdict: 'bad', reasons: ['No leasing intent'] }) } }] });
  expect(await judgeLeadFit({ company: 'UsuarioK', customFields: { units: 'under_50', message: 'Les agradezco todo gracias' } }, { enabled: true }, 'owner')).toEqual({ verdict: 'bad', reasons: ['No leasing intent'] });
});
it('allows good under-50 leads when other evidence outweighs units', async () => {
  call.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ verdict: 'good', reasons: ['Property manager seeking leasing automation'] }) } }] });
  expect((await judgeLeadFit({ company: 'Sunrise Property Management', customFields: { units: 'under_50' } }, { enabled: true }, 'owner'))?.verdict).toBe('good');
});
it('fails open on error', async () => {
  call.mockRejectedValue(new Error('provider unavailable'));
  expect(await judgeLeadFit({}, { enabled: true }, 'owner')).toEqual({ verdict: 'unscored', reasons: [] });
});
it('fails open on timeout without waiting for provider completion', async () => {
  jest.useFakeTimers();
  try {
    call.mockReturnValue(new Promise(() => {}));
    const result = judgeLeadFit({}, { enabled: true }, 'owner');
    await jest.advanceTimersByTimeAsync(FIT_TIMEOUT_MS);
    expect(await result).toEqual({ verdict: 'unscored', reasons: [] });
  } finally { jest.useRealTimers(); }
});
it.each(['not json', '{"verdict":"bad","reasons":[]}', '{"verdict":"unknown","reasons":["why"]}',
  '{"verdict":"good","reasons":["Call back at (555) 123-4567"]}', '{"verdict":"good","reasons":["Contact jane@acme.com"]}'])('fails open on malformed response %s', async content => {
  call.mockResolvedValue({ choices: [{ message: { content } }] });
  expect(await judgeLeadFit({}, { enabled: true }, 'owner')).toEqual({ verdict: 'unscored', reasons: [] });
});
it('provides bounded full criteria and excludes internals', () => {
  const data = fitSubmission({ firstName: 'Jane', phone: '+1 555', company: 'Example', customFields: { message: 'Need leasing automation', units: '50_200', token: 'secret', landingUrl: 'private', notes: 'x'.repeat(2000) } });
  expect(data).toMatchObject({ firstName: 'Jane', phone: '+1 555', 'form.message': 'Need leasing automation', 'form.units': '50_200' });
  expect(data['form.notes']).toHaveLength(1000);
  expect(JSON.stringify(data)).not.toContain('secret');
  expect(JSON.stringify(data)).not.toContain('private');
});
it('does not call LLM for other orgs', async () => {
  expect(await judgeLeadFit({}, undefined, 'owner')).toBeUndefined();
  expect(call).not.toHaveBeenCalled();
});
