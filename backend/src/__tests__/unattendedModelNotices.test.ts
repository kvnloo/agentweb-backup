/**
 * ENG-669 PR-D: the decisions and the copy behind the owner notices for unattended runs whose model was refused.
 * The wiring (runScheduledChat, the work plan step pause) is covered in agentModeController.unattendedModelNotices.test.ts.
 */
jest.mock('../services/chatbotService', () => ({ chatbotDb: {} }));
jest.mock('../services/db', () => ({ userDb: { getUserByEmail: jest.fn(), getUserById: jest.fn() } }));

import { emailService } from '../services/emailService';
import { ModelUnavailableError } from '../services/agentMode/modelUnavailable';
import { buildScheduleModelNotice, buildWorkPlanStepModelNotice, PRICING_PATH, SCHEDULES_PATH } from '../utils/unattendedModelNoticeCopy';
import {
  ENDED_BEFORE_MODEL_CHECK_FLAG,
  isNewScheduleModelBlock,
  isUnattendedPause,
  SCHEDULE_TEST_RUN_FLAG,
  scheduleModelBlockFields,
  wasStepModelNoticeSent,
} from '../utils/unattendedModelNotices';
import { MODEL_UNAVAILABLE_BLOCK_REASON } from '../utils/scheduleRunBlockedReason';

const block = (model: string, reason: 'not_in_plan' | 'not_served' | 'not_selectable' = 'not_in_plan') =>
  scheduleModelBlockFields(new ModelUnavailableError(model, reason));
const blockedRun = (model: string, reason: 'not_in_plan' | 'not_served' | 'not_selectable' = 'not_in_plan') =>
  ({ status: 'failure', ...block(model, reason) });

describe('scheduleModelBlockFields', () => {
  it('records the block reason, the refusal reason and the refused id', () => {
    expect(block('gpt-5.5')).toEqual({ blockedBy: MODEL_UNAVAILABLE_BLOCK_REASON, blockedReason: 'not_in_plan', blockedModel: 'gpt-5.5' });
  });
});

describe('isNewScheduleModelBlock: email once per change into the state', () => {
  it('no history, or a last run that was not blocked: a new block', () => {
    expect(isNewScheduleModelBlock(undefined, block('a'))).toBe(true);
    expect(isNewScheduleModelBlock([], block('a'))).toBe(true);
    expect(isNewScheduleModelBlock([{ status: 'success' }], block('a'))).toBe(true);
    expect(isNewScheduleModelBlock([{ status: 'failure' }], block('a'))).toBe(true);
  });

  it('the same model refused for the same reason as the last run: not new (no email)', () => {
    expect(isNewScheduleModelBlock([blockedRun('a')], block('a'))).toBe(false);
    expect(isNewScheduleModelBlock([blockedRun('a'), blockedRun('a'), blockedRun('a')], block('a'))).toBe(false);
  });

  it('a run that got past the model in between ends the state: blocked again is new', () => {
    expect(isNewScheduleModelBlock([blockedRun('a'), { status: 'success' }], block('a'))).toBe(true);
  });

  it('the pin changed to another refused model, or the reason changed: new', () => {
    expect(isNewScheduleModelBlock([blockedRun('a')], block('b'))).toBe(true);
    expect(isNewScheduleModelBlock([blockedRun('a', 'not_in_plan')], block('a', 'not_served'))).toBe(true);
  });

  it('skips from gates that run before the model is resolved neither continue nor end the state', () => {
    const history = [blockedRun('a'), { status: 'skipped_account_disconnected' }, { status: 'skipped_send_capacity_exhausted' }];
    expect(isNewScheduleModelBlock(history, block('a'))).toBe(false);
    expect(isNewScheduleModelBlock([{ status: 'skipped_account_disconnected' }], block('a'))).toBe(true);
  });

  it('#3676 follow-up 1: a failure written BEFORE the model check (usage limit, disallowed function, ...) neither continues nor ends the state', () => {
    const limit = { status: 'failure', actualResponse: 'Monthly usage limit reached', [ENDED_BEFORE_MODEL_CHECK_FLAG]: true };
    // blocked -> limit -> blocked is ONE episode: no second email.
    expect(isNewScheduleModelBlock([blockedRun('a'), limit], block('a'))).toBe(false);
    expect(isNewScheduleModelBlock([blockedRun('a'), limit, limit], block('a'))).toBe(false);
    // ...and it does not start one either.
    expect(isNewScheduleModelBlock([limit], block('a'))).toBe(true);
    // An ordinary failure that got past the model still ends it.
    expect(isNewScheduleModelBlock([blockedRun('a'), { status: 'failure' }], block('a'))).toBe(true);
  });

  it('#3676 follow-up 3: a Test run\'s block (never emailed) does not count as the block the owner was told about', () => {
    const testBlock = { ...blockedRun('a'), [SCHEDULE_TEST_RUN_FLAG]: true };
    expect(isNewScheduleModelBlock([testBlock], block('a'))).toBe(true);
    expect(isNewScheduleModelBlock([{ status: 'success' }, testBlock], block('a'))).toBe(true);
    // A cron block already emailed stays the episode through a later Test click.
    expect(isNewScheduleModelBlock([blockedRun('a'), testBlock], block('a'))).toBe(false);
    // A Test run that got past the model is an ordinary run.
    expect(isNewScheduleModelBlock([blockedRun('a'), { status: 'success', [SCHEDULE_TEST_RUN_FLAG]: true }], block('a'))).toBe(true);
  });

  it('a LinkedIn sourcing block is not a model block', () => {
    expect(isNewScheduleModelBlock([{ status: 'success', blockedBy: 'linkedin_search_unavailable' }], block('a'))).toBe(true);
  });
});

describe('wasStepModelNoticeSent', () => {
  const pause = (stepCount: number, ownerNotified?: boolean) => ({
    role: 'assistant', content: 'Step paused',
    metadata: { kind: 'work-plan-step-model-unavailable', stepCount, model: 'm', ...(ownerNotified !== undefined && { ownerNotified }) },
  });

  it('finds a stamped pause for the step anywhere in the transcript, not only at the tail', () => {
    expect(wasStepModelNoticeSent([pause(2, true), { role: 'user', content: 'Please continue' }], 2)).toBe(true);
  });

  it('an unstamped pause (interactive, or switch off at the time), another step, or no transcript: not sent', () => {
    expect(wasStepModelNoticeSent([pause(2)], 2)).toBe(false);
    expect(wasStepModelNoticeSent([pause(1, true)], 2)).toBe(false);
    expect(wasStepModelNoticeSent(undefined, 2)).toBe(false);
  });
});

describe('isUnattendedPause', () => {
  const scheduled = { sessionType: 'scheduled', pageIdentifier: 'Scheduled: Daily|scheduleId:abc-123' };
  const testRun = { sessionType: 'scheduled', pageIdentifier: 'Test: Daily|scheduleId:abc-123' };
  const regular = { sessionType: 'regular', pageIdentifier: 'agent-mode' };

  it('the per-turn signal wins over the session kind', () => {
    expect(isUnattendedPause(regular, true)).toBe(true);
    expect(isUnattendedPause(scheduled, false)).toBe(false);
  });

  it('without a signal the session kind decides', () => {
    expect(isUnattendedPause(scheduled)).toBe(true);
    expect(isUnattendedPause(regular)).toBe(false);
    expect(isUnattendedPause(null)).toBe(false);
  });

  it('a manual "Test this schedule" run is watched by its owner: never unattended', () => {
    expect(isUnattendedPause(testRun, true)).toBe(false);
    expect(isUnattendedPause(testRun)).toBe(false);
  });
});

describe('notice copy', () => {
  const allText = (notice: ReturnType<typeof buildScheduleModelNotice>) =>
    [notice.subject, notice.headline, notice.subheading, notice.footer, ...notice.paragraphs, ...notice.actions.map((a) => a.label)].join('\n');

  it.each(['not_in_plan', 'not_served', 'not_selectable'] as const)('names no price or amount (%s)', (reason) => {
    for (const notice of [
      buildScheduleModelNotice({ scheduleName: 'Weekly report', modelLabel: 'GPT-5.5', reason, upgradeRequired: ['Pro'] }),
      buildWorkPlanStepModelNotice({ stepCount: 2, modelLabel: 'GPT-5.5', reason, sessionId: 's-1', scheduleName: 'Weekly report', upgradeRequired: ['Pro'] }),
    ]) {
      const text = allText(notice);
      expect(text).not.toMatch(/[$€£]|\bUSD\b|\bper month\b|\/mo\b/i);
    }
  });

  it('schedule, not in plan: names the schedule and model, says it is not in the plan, links the schedule and pricing', () => {
    const notice = buildScheduleModelNotice({ scheduleName: 'Weekly report', modelLabel: 'GPT-5.5', reason: 'not_in_plan', upgradeRequired: ['Pro'] });
    const text = allText(notice);
    expect(notice.subject).toContain('Weekly report');
    expect(text).toContain('Your scheduled chat "Weekly report" is set to run on GPT-5.5, which isn\'t included in your current plan.');
    expect(text).toContain('nothing was sent to a different model');
    expect(text).toContain('choose a model your plan includes, or upgrade your plan');
    expect(text).toContain("We'll only email you once about this, not on every run.");
    expect(notice.actions.map((a) => a.path)).toEqual([SCHEDULES_PATH, PRICING_PATH]);
  });

  it('schedule, no longer available: no upgrade advice and no pricing link (no plan includes it)', () => {
    const notice = buildScheduleModelNotice({ scheduleName: 'Weekly report', modelLabel: 'Old Model', reason: 'not_served' });
    const text = allText(notice);
    expect(text).toContain('which is no longer available');
    expect(text.toLowerCase()).not.toContain('upgrade');
    expect(notice.actions.map((a) => a.path)).toEqual([SCHEDULES_PATH]);
    expect(notice.subject).toBe('⚠️ Your scheduled chat "Weekly report" didn\'t run: its model is no longer available');
  });

  it('#3676 follow-up 5: not in plan, but NO plan includes the model (upgradeRequired empty or absent): no upgrade advice, no "Compare plans"', () => {
    for (const upgradeRequired of [[], undefined]) {
      const schedule = buildScheduleModelNotice({ scheduleName: 'Weekly report', modelLabel: 'GPT-5.5', reason: 'not_in_plan', upgradeRequired });
      const step = buildWorkPlanStepModelNotice({ stepCount: 2, modelLabel: 'GPT-5.5', reason: 'not_in_plan', sessionId: 's-1', sessionTitle: 'Research', upgradeRequired });
      for (const notice of [schedule, step]) {
        expect(allText(notice)).toContain("isn't included in your current plan");
        expect(allText(notice)).toContain('choose a model your plan includes');
        expect(allText(notice).toLowerCase()).not.toContain('upgrade');
        expect(notice.actions.map((a) => a.path)).not.toContain(PRICING_PATH);
      }
    }
  });

  it('#3676 follow-up 6: with no schedule to name, a scheduled run\'s "Scheduled: " / "Test: " title prefix is not the chat\'s name', () => {
    const scheduled = buildWorkPlanStepModelNotice({ stepCount: 2, modelLabel: 'M', reason: 'not_served', sessionId: 's-1', sessionTitle: 'Scheduled: Weekly report' });
    expect(scheduled.subject).toBe('⚠️ Your work plan "Weekly report" paused: a step\'s model is no longer available');
    expect(scheduled.subheading).toBe('Weekly report');
    expect(scheduled.paragraphs[0]).toContain('in your chat "Weekly report"');
    expect(buildWorkPlanStepModelNotice({ stepCount: 2, modelLabel: 'M', reason: 'not_served', sessionId: 's-1', sessionTitle: 'Test: Weekly report' }).subject)
      .toBe('⚠️ Your work plan "Weekly report" paused: a step\'s model is no longer available');
    // Nothing left after the prefix: the plain fallback, never `""`.
    expect(buildWorkPlanStepModelNotice({ stepCount: 2, modelLabel: 'M', reason: 'not_served', sessionId: 's-1', sessionTitle: 'Scheduled: ' }).subject)
      .toBe('⚠️ Your work plan paused: a step\'s model is no longer available');
    // A title that merely contains the word keeps it.
    expect(buildWorkPlanStepModelNotice({ stepCount: 2, modelLabel: 'M', reason: 'not_served', sessionId: 's-1', sessionTitle: 'Scheduled posts review' }).subheading)
      .toBe('Scheduled posts review');
  });

  it('work plan step: names the step, model and schedule (or the chat), links the chat', () => {
    const forSchedule = buildWorkPlanStepModelNotice({
      stepCount: 3, modelLabel: 'GPT-5.5', reason: 'not_in_plan', sessionId: 's/1', scheduleName: 'Weekly report', sessionTitle: 'Scheduled: Weekly report', upgradeRequired: ['Pro'],
    });
    expect(forSchedule.paragraphs[0]).toBe(
      'Step 3 of the work plan in a run of your scheduled chat "Weekly report" uses GPT-5.5, which isn\'t included in your current plan. The plan paused at that step, and nothing was sent to a different model.',
    );
    expect(forSchedule.actions.map((a) => a.path)).toEqual(['/agent-mode/s%2F1', PRICING_PATH]);

    const forChat = buildWorkPlanStepModelNotice({ stepCount: 1, modelLabel: 'Old Model', reason: 'not_selectable', sessionId: 's-2', sessionTitle: 'Research' });
    expect(forChat.paragraphs[0]).toContain('in your chat "Research"');
    expect(forChat.footer).toBe('This is an automated email from AgentWeb.');
    expect(forChat.actions.map((a) => a.path)).toEqual(['/agent-mode/s-2']);
    expect(forChat.subject).toBe('⚠️ Your work plan "Research" paused: a step\'s model is no longer available');
    expect(buildWorkPlanStepModelNotice({ stepCount: 1, modelLabel: 'M', reason: 'not_in_plan', sessionId: 's-3' }).subject)
      .toBe('⚠️ Your work plan paused: a step\'s model isn\'t included in your plan');
  });
});

describe('notice copy: the AgentWeb Model router unavailable (ENG-669 PR-C)', () => {
  it('a schedule on the AgentWeb Model names it and says it is unavailable right now, not gone', () => {
    const notice = buildScheduleModelNotice({ scheduleName: 'Weekly report', modelLabel: 'AgentWeb Model', reason: 'not_served', routerUnavailable: true });
    const text = [notice.subject, notice.headline, ...notice.paragraphs].join(' ');
    expect(notice.subject).toBe('⚠️ Your scheduled chat "Weekly report" didn\'t run: its model is unavailable right now');
    expect(text).toContain('is set to run on AgentWeb Model, which is unavailable right now');
    expect(text).not.toMatch(/no longer available|agentweb-model/);
  });

  it('a work plan step on the AgentWeb Model says the same', () => {
    const notice = buildWorkPlanStepModelNotice({
      stepCount: 2, modelLabel: 'AgentWeb Model', reason: 'not_served', routerUnavailable: true, sessionId: 's-1', sessionTitle: 'Launch',
    });
    const text = [notice.subject, notice.headline, ...notice.paragraphs].join(' ');
    expect(text).toContain('uses AgentWeb Model, which is unavailable right now');
    expect(text).not.toMatch(/no longer available|agentweb-model/);
  });
});

describe('emailService: the model_unavailable failure class', () => {
  beforeEach(() => jest.restoreAllMocks());

  it('sends the model notice, not the keeps-failing / contact-support email', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduledRunFailedEmail(['owner@example.com'], 'Weekly report', 'sched-1', {
      failureClass: 'model_unavailable', modelLabel: 'GPT-5.5', reason: 'not_in_plan', upgradeRequired: ['Pro'],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [recipients, subject, text, html] = spy.mock.calls[0];
    expect(recipients).toEqual(['owner@example.com']);
    expect(subject).toBe('⚠️ Your scheduled chat "Weekly report" didn\'t run: its model isn\'t included in your plan');
    expect(text).toContain('GPT-5.5');
    expect(text).not.toMatch(/contact support|times in a row|keeps failing/i);
    expect(html).not.toMatch(/contact support|times in a row|Keeps Failing/i);
    expect(text).toContain(`/agent-mode?tab=scheduled`);
    expect(text).toContain('/pricing');
    expect(html).toContain('/pricing');
    expect(`${subject}\n${text}\n${html}`).not.toMatch(/\$\d/);
  });

  it('HTML-escapes the schedule name and model label', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduledRunFailedEmail(['x@example.com'], 'Evil <img src=x onerror=alert(1)>', 'sched-2', {
      failureClass: 'model_unavailable', modelLabel: '<b>m</b>', reason: 'not_served',
    });
    const html = spy.mock.calls[0][3];
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
    expect(html).not.toContain('<b>m</b>');
  });

  it('the work plan step notice renders and never throws when the transport fails', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendWorkPlanStepModelUnavailableEmail(['owner@example.com'], {
      sessionId: 'session-1', stepCount: 2, modelLabel: 'GPT-5.5', reason: 'not_in_plan', sessionTitle: 'Research',
    });
    expect(spy.mock.calls[0][1]).toBe('⚠️ Your work plan "Research" paused: a step\'s model isn\'t included in your plan');
    expect(spy.mock.calls[0][2]).toContain('/agent-mode/session-1');

    spy.mockRejectedValue(new Error('SMTP down'));
    await expect(emailService.sendWorkPlanStepModelUnavailableEmail('owner@example.com', {
      sessionId: 'session-1', stepCount: 2, modelLabel: 'GPT-5.5', reason: 'not_in_plan',
    })).resolves.toBeUndefined();
  });

  it('#3676 follow-up 5: both notices pass upgradeRequired through: empty = no pricing link', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduledRunFailedEmail(['owner@example.com'], 'Weekly report', 'sched-1', {
      failureClass: 'model_unavailable', modelLabel: 'GPT-5.5', reason: 'not_in_plan', upgradeRequired: [],
    });
    await emailService.sendWorkPlanStepModelUnavailableEmail(['owner@example.com'], {
      sessionId: 'session-1', stepCount: 2, modelLabel: 'GPT-5.5', reason: 'not_in_plan', sessionTitle: 'Research', upgradeRequired: [],
    });
    for (const [, , text, html] of spy.mock.calls) {
      expect(`${text}\n${html}`).not.toContain('/pricing');
      expect(`${text}`.toLowerCase()).not.toContain('upgrade');
    }
  });

  it('the existing classes are unchanged', async () => {
    const spy = jest.spyOn(emailService, 'sendEmail').mockResolvedValue();
    await emailService.sendScheduledRunFailedEmail(['x@example.com'], 'S', 'sched-3', { failedAttempts: 4, failureClass: 'system' });
    expect(spy.mock.calls[0][1]).toBe('⚠️ Scheduled Chat Keeps Failing: S');
    expect(spy.mock.calls[0][2]).toContain('contact support');
  });
});
