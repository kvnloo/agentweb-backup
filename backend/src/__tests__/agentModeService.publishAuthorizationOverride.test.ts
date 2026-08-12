import * as fs from 'fs';
import * as path from 'path';

/**
 * ENG-827 — the prompt and the checker must be built from ONE authorization value.
 *
 * runVerifiedChat resolves publish authorization, hands it to generateSessionResponse,
 * and keeps it as the value the required-function checker enforces. The prompt builder
 * ignored it and read the schedule again on its own. Two reads can land either side of
 * a revocation, and the disagreement that bites is:
 *
 *   prompt says "draft only"  +  checker still requires a publishing tool
 *
 * which tells the agent not to publish and then marks the run incomplete for not
 * publishing — the retry loop this ticket exists to fix. Forwarding one value makes
 * that state unrepresentable rather than unlikely.
 *
 * The defect was pure WIRING: the parameter existed on generateSessionResponse and was
 * even passed by its caller, but nothing read it and nothing forwarded it past the
 * worker boundary. So the wiring is what these tests pin — a behavioural test through
 * generateMarketingResponse would need the whole LLM stack stood up, and would not
 * actually catch a dropped IPC field.
 */

const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');

describe('ENG-827 — the resolved authorization survives the worker boundary', () => {
  it('is plain data, so IPC serialization cannot quietly drop it', () => {
    // The worker receives JSON over IPC. A class instance, a closure or a Map would
    // arrive unrecognizable — which is how a hook cannot cross this boundary and why
    // the value has to be a flat record.
    const override = { authorized: true, tools: ['post_on_connected_account'] };
    expect(JSON.parse(JSON.stringify(override))).toEqual(override);
  });

  it('is declared on the worker params contract', () => {
    const src = read('../services/generateMarketingResponseWorkerService.ts');
    expect(src).toMatch(/publishAuthorizationOverride\?:\s*\{\s*authorized:\s*boolean;\s*tools:\s*string\[\]\s*\}/);
  });

  it('is placed on the payload generateSessionResponse sends, not just its signature', () => {
    // The original defect: accepted as a parameter, never put on the wire.
    const src = read('../controllers/agentModeController.ts');
    const start = src.indexOf('runInWorker(');
    const payload = src.slice(start, start + 1500);
    expect(payload).toContain('publishAuthorizationOverride');
  });

  it('is destructured AND forwarded by the worker entry point', () => {
    const src = read('../workers/generateMarketingResponseWorker.ts');
    // Anchored on the destructuring itself rather than on being its LAST key: ENG-907
    // added `turnStartMs` after it, which broke the old end-anchored pattern without
    // anything being wrong. What matters is that it is unpacked from message.params.
    expect(src).toMatch(/const\s*\{[^}]*\bpublishAuthorizationOverride\b[^}]*\}\s*=\s*message\.params/);

    // Forwarded into the service call, not just unpacked and discarded.
    const call = src.slice(src.indexOf('generateMarketingResponse('));
    expect(call.slice(0, call.indexOf(');'))).toContain('publishAuthorizationOverride');
  });

  it('is preferred over the prompt builder’s own read', () => {
    const src = read('../services/agentModeService.ts');
    expect(src).toMatch(
      /publishAuthorization\s*=\s*\n?\s*publishAuthorizationOverride\s*\?\?\s*\(await this\.resolveScheduledPublishAuthorization/
    );
  });
});

describe('ENG-827 — the fallback read still fails closed when no override is supplied', () => {
  // The interactive path passes nothing, so the independent resolve remains live and
  // must keep its withholding behaviour.
  const loadResolver = (schedule: any) => {
    jest.resetModules();
    jest.doMock('../services/db', () => ({
      scheduleDb: { getScheduleById: jest.fn().mockResolvedValue(schedule) },
      userDb: { getUserById: jest.fn() },
      chatDb: { getChatSession: jest.fn() },
    }));
    const { agentModeService } = require('../services/agentModeService');
    return (session: any) =>
      (agentModeService as any).resolveScheduledPublishAuthorization(session);
  };

  it('treats a non-scheduled session as unconstrained', async () => {
    const resolve = loadResolver(null);
    await expect(resolve({ sessionType: 'regular' })).resolves.toEqual({ authorized: true, tools: [] });
  });

  it('withholds when a scheduled session has no parseable scheduleId', async () => {
    const resolve = loadResolver(null);
    await expect(
      resolve({ sessionType: 'scheduled', sessionId: 's1', pageIdentifier: 'nonsense' })
    ).resolves.toEqual({ authorized: false, tools: [] });
  });

  it('withholds when the schedule has vanished', async () => {
    const resolve = loadResolver(null);
    const result = await resolve({
      sessionType: 'scheduled',
      sessionId: 's1',
      pageIdentifier: 'scheduled-chat-sc-1',
    });
    expect(result.authorized).toBe(false);
  });
});
