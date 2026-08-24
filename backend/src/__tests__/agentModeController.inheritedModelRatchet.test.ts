/**
 * ENG-1365 — editing an inheriting schedule silently pinned it to `""`.
 *
 * `updateScheduledChat` resolved the model as:
 *
 *     llmModel: llmModel !== undefined ? llmModel : (existingSchedule.llmModel || '')
 *
 * The fallback is a read-modify-write, and it writes `''` in two places it should
 * not. When the request never mentions `llmModel` and the stored attribute is
 * ABSENT, `existingSchedule.llmModel || ''` still resolves to `''` — and `''` gets
 * written. So a rename, a cadence change, an added email recipient, ANY edit,
 * converted a schedule from "inherits the platform default" to "stores an empty
 * string". Nothing ever converted it back.
 *
 * That ratchet is where ENG-1363's blast radius came from: 48 of 82 active
 * schedules held `''`, and the model-switch condition asserted
 * `attribute_not_exists` against an attribute that was plainly present, so every
 * switch 409'd permanently. ENG-1363 makes the reader tolerate both spellings;
 * this stops the second spelling being manufactured.
 *
 * The comment SIX LINES ABOVE the defect already states the rule, for
 * `requirePublishApproval`: "`updateSchedule` builds a PARTIAL SET expression, so
 * omitting the key leaves the stored value untouched, which is the only race-free
 * way to preserve it." `llmModel` did the copy-forward that comment rejects.
 *
 * These tests assert the ARGUMENTS handed to `updateSchedule`, which is normally
 * the weakness that hid ENG-1217's undo bug. It is the right level here because
 * the defect IS the payload: what the controller decides to send. What DynamoDB
 * then does with a well-formed payload is `scheduleDb.updateSchedule`'s contract
 * and is covered by scheduleDb.updateSchedule.wireValidity.test.ts.
 */

import { agentModeController } from '../controllers/agentModeController';
import { scheduleDb } from '../services/db';

jest.mock('../services/db', () => ({
  scheduleDb: { getScheduleById: jest.fn(), updateSchedule: jest.fn() },
  userDb: { getUserById: jest.fn() },
  chatDb: { getChatSession: jest.fn() },
}));

const mockScheduleDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

const SCHEDULE_ID = 'sc-1365';
const OWNER = 'user-1';
const PINNED = 'anthropic.claude-opus-5';

/** `over` may omit `llmModel` entirely — that ABSENCE is the state under test. */
const existing = (over: any = {}) => ({
  scheduleId: SCHEDULE_ID,
  userId: OWNER,
  type: 'scheduled_chat',
  scheduleName: 'Daily digest',
  startingMessage: 'Summarise yesterday',
  frequency: 'daily',
  nextRunTime: '2026-09-01T10:00:00.000Z',
  timezone: 'UTC',
  emailNotifications: ['owner@example.com'],
  ...over,
});

const req = (body: any) =>
  ({ params: { scheduleId: SCHEDULE_ID }, body, user: { userId: OWNER } } as any);

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

/** An ordinary edit that says nothing whatsoever about the model. */
const RENAME = {
  scheduleName: 'Daily digest (renamed)',
  startingMessage: 'Summarise yesterday',
  scheduleFrequency: 'daily',
  emailNotifications: ['owner@example.com'],
};

const written = () => (mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][1] as any;
const removals = () =>
  ((mockScheduleDb.updateSchedule as jest.Mock).mock.calls[0][4] as string[] | undefined) || [];

beforeEach(() => {
  jest.clearAllMocks();
  mockScheduleDb.updateSchedule.mockReset();
  mockScheduleDb.updateSchedule.mockResolvedValue({} as any);
});

describe('an edit that says nothing about the model must not touch the model', () => {
  it('leaves an ABSENT llmModel absent — the ratchet itself', async () => {
    // The stored schedule has no `llmModel` key at all. This is the majority
    // state, and the one an ordinary edit was silently converting.
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    await agentModeController.updateScheduledChat(req(RENAME), res());

    const w = written();
    // Either the key is absent from the payload (partial SET leaves it alone) or
    // it is explicitly undefined. What it must NEVER be is `''`.
    expect(w.llmModel).not.toBe('');
    expect(w.llmModel ?? undefined).toBeUndefined();
    // And it must not be smuggled in as a removal either — the attribute was
    // already absent, so there is nothing to remove and no reason to say so.
    expect(removals()).not.toContain('llmModel');
  });

  it('leaves a PINNED llmModel exactly as it was', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing({ llmModel: PINNED }) as any);

    await agentModeController.updateScheduledChat(req(RENAME), res());

    const w = written();
    // Omitted, or written back unchanged. Both preserve it; neither may drop it.
    expect(w.llmModel === undefined || w.llmModel === PINNED).toBe(true);
    expect(removals()).not.toContain('llmModel');
  });

  it('leaves an existing empty string alone rather than "fixing" it mid-edit', async () => {
    // Not this ticket's job. Rewriting stored rows as a side effect of an unrelated
    // edit is a data migration hiding inside a rename, and ENG-1363 already makes
    // the reader handle `''`. Converting them is a deliberate, separate decision.
    mockScheduleDb.getScheduleById.mockResolvedValue(existing({ llmModel: '' }) as any);

    await agentModeController.updateScheduledChat(req(RENAME), res());

    const w = written();
    expect(w.llmModel === undefined || w.llmModel === '').toBe(true);
  });
});

describe('an edit that DOES carry a model still does what it says', () => {
  it('pins the model the request asks for', async () => {
    mockScheduleDb.getScheduleById.mockResolvedValue(existing() as any);

    await agentModeController.updateScheduledChat(
      req({ ...RENAME, llmModel: PINNED }),
      res(),
    );

    expect(written().llmModel).toBe(PINNED);
    expect(removals()).not.toContain('llmModel');
  });

  it('clearing the model RESTORES inheritance by removing the attribute, not by storing ""', async () => {
    // The customer-facing "use the platform default" action. Storing `''` here is
    // what made the state exist at all; removing the attribute is the only
    // spelling of "inherits" the rest of the system agrees on.
    mockScheduleDb.getScheduleById.mockResolvedValue(existing({ llmModel: PINNED }) as any);

    await agentModeController.updateScheduledChat(
      req({ ...RENAME, llmModel: '' }),
      res(),
    );

    expect(removals()).toContain('llmModel');
    // And it must not ALSO be SET, or the write carries a value and a removal for
    // the same attribute — DynamoDB rejects overlapping paths in one expression.
    expect(written().llmModel).toBeUndefined();
  });

  it('the removal rides the SAME write as the edit', async () => {
    // One write, not two. A separate call could leave the rename applied and the
    // model still pinned, or vice versa, with no way to tell which landed.
    mockScheduleDb.getScheduleById.mockResolvedValue(existing({ llmModel: PINNED }) as any);

    await agentModeController.updateScheduledChat(
      req({ ...RENAME, llmModel: '' }),
      res(),
    );

    expect(mockScheduleDb.updateSchedule).toHaveBeenCalledTimes(1);
    expect(written().scheduleName).toBe('Daily digest (renamed)');
    expect(removals()).toContain('llmModel');
  });
});
