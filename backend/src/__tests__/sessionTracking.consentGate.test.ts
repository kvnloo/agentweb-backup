/**
 * ENG-2327 — enable_session_tracking commits to a customer's live repo (=> redeploy), so it is classified
 * exactly like its sibling publish_landing_page_changes for unattended (scheduled) runs: it needs the same
 * standing consent, and a schedule withholding publish approval is refused.
 */
import { isPublishName, isPowerTool } from '../utils/hardeningGaps';
import {
  isPublishCall,
  isPublishCapableTool,
  isPublishCallWithinAuthorizedScope,
  resolveSchedulePublishAuthorization,
} from '../utils/schedulePublishAuthorization';
import { isExternalContentPublish } from '../utils/schedulePublishApproval';
import { EXTERNAL_PUBLISH_TOOLS } from '../services/agentToolGatewayService';
import { refuseUnauthorizedScheduledPublish, attachPublishRevalidation } from '../utils/scheduledPublishConsentGuard';

jest.mock('../services/chatbotService', () => ({ chatbotDb: { getChatSession: jest.fn() } }));
jest.mock('../services/db', () => ({ scheduleDb: { getScheduleById: jest.fn() } }));
jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  SOCIAL_POSTING_PLATFORMS: ['twitter', 'linkedin', 'instagram', 'youtube'],
}));

const T = 'enable_session_tracking';

describe('enable_session_tracking is a consent-gated publish tool', () => {
  it('is classified as publish everywhere its sibling is', () => {
    expect(isPublishName(T)).toBe(true);
    expect(isPowerTool(T)).toBe(true);
    expect(isPublishCapableTool(T)).toBe(true);
    expect(isPublishCall(T, { page_id: 'p1' })).toBe(true);
    expect(isExternalContentPublish(T, {})).toBe(isExternalContentPublish('publish_landing_page_changes', {}));
    expect(EXTERNAL_PUBLISH_TOOLS.has(T)).toBe(true);
  });

  it('an unattended schedule is authorized only when its consent names THIS tool', () => {
    const base = { autopublishAuthorized: true } as any;
    const granted = resolveSchedulePublishAuthorization({ ...base, autopublishAuthorizedTools: [T], requiredFunctionCalls: [T] });
    expect(granted.authorized).toBe(true);
    expect(isPublishCallWithinAuthorizedScope(T, {}, granted.tools)).toBe(true);

    // consent given for a different publish tool does not extend to it (and vice versa)
    const other = resolveSchedulePublishAuthorization({ ...base, autopublishAuthorizedTools: ['publish_landing_page_changes'], requiredFunctionCalls: [T] });
    expect(isPublishCallWithinAuthorizedScope(T, {}, other.tools)).toBe(false);
    expect(isPublishCallWithinAuthorizedScope('publish_landing_page_changes', undefined, granted.tools)).toBe(false);
  });

  it('an explicit hold (requirePublishApproval) or revoked consent refuses it', () => {
    expect(resolveSchedulePublishAuthorization({ requirePublishApproval: true, requiredFunctionCalls: [T] } as any).authorized).toBe(false);
    expect(resolveSchedulePublishAuthorization({ autopublishAuthorized: false, autopublishAuthorizedTools: [T], requiredFunctionCalls: [T] } as any).authorized).toBe(false);
    expect(resolveSchedulePublishAuthorization({ autopublishAuthorized: true, autopublishAuthorizedTools: [], requiredFunctionCalls: [T] } as any).authorized).toBe(false);
  });
});

describe('the unattended path is refused like its sibling; interactive use is unchanged', () => {
  const SCHEDULE_ID = '1c20ada1-0000-4000-8000-000000000001';
  const session = (tools: string[]) => ({
    sessionId: 'sess-1',
    sessionType: 'scheduled',
    pageIdentifier: `Scheduled: Site audit|scheduleId:${SCHEDULE_ID}`,
    publishAdmission: { authorized: true, tools, recordedAt: '2026-08-10T01:00:00.000Z' },
  });
  const schedule = (over: any = {}) => ({
    scheduleId: SCHEDULE_ID, requiredFunctionCalls: [T], autopublishAuthorized: true, autopublishAuthorizedTools: [T], ...over,
  });
  const deps = (sess: any, sched: any) => ({ getChatSession: jest.fn(async () => sess), getScheduleById: jest.fn(async () => sched) });

  it('allows a scheduled run whose live consent covers the tool', async () => {
    expect(await refuseUnauthorizedScheduledPublish(T, { sessionId: 'sess-1' }, deps(session([T]), schedule()), { page_id: 'p1' })).toBeNull();
  });

  it('REFUSES a scheduled run with no consent / withdrawn consent / consent for another tool', async () => {
    for (const sched of [
      schedule({ autopublishAuthorized: false, autopublishAuthorizedTools: [] }),
      schedule({ requirePublishApproval: true }),
      schedule({ autopublishAuthorizedTools: ['publish_landing_page_changes'], requiredFunctionCalls: ['publish_landing_page_changes'] }),
    ]) {
      const refusal = await refuseUnauthorizedScheduledPublish(T, { sessionId: 'sess-1' }, deps(session([T]), sched), { page_id: 'p1' });
      expect(refusal).not.toBeNull();
    }
  });

  it('a non-scheduled (interactive) session is not gated', async () => {
    const interactive = { sessionId: 'sess-2', sessionType: 'chat', pageIdentifier: 'chat' };
    expect(await refuseUnauthorizedScheduledPublish(T, { sessionId: 'sess-2' }, deps(interactive, null), { page_id: 'p1' })).toBeNull();
  });

  it('the registry-attached revalidation hook exists for this tool (so the handler can re-check at its last moment)', () => {
    const ctx = attachPublishRevalidation(T, { sessionId: 'sess-1' }, { page_id: 'p1' });
    expect(typeof ctx.assertPublishStillAuthorized).toBe('function');
  });
});
