jest.mock('../services/db', () => ({
  scheduleDb: {
    getScheduleById: jest.fn(),
    updateSchedule: jest.fn().mockResolvedValue(undefined),
  },
}));

import { scheduleDb } from '../services/db';
import { grantSchedulePublishConsent } from '../scripts/grant-schedule-autopublish';

const mockDb = scheduleDb as jest.Mocked<typeof scheduleDb>;

/**
 * ENG-827: the audited path for recording an owner's unattended-publish consent on
 * a schedule that predates the "Publish without my review" checkbox.
 *
 * The script must never invent consent, and must never silently no-op. These pin
 * both: it writes only for explicitly named schedules that actually have a publish
 * tool in scope, and it records who attested to the owner's confirmation.
 */
describe('grantSchedulePublishConsent (ENG-827)', () => {
  beforeEach(() => jest.clearAllMocks());

  const PUBLISHER = {
    scheduleName: 'Kevin — Daily LinkedIn Post',
    requiredFunctionCalls: ['post_on_connected_account'],
  };

  it('does not write anything in dry-run mode', async () => {
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue(PUBLISHER);
    const out = await grantSchedulePublishConsent(['sc-1'], 'kevin@ via ENG-827', true);
    expect(out[0].action).toBe('would-grant');
    expect(out[0].detail).toContain('post_on_connected_account');
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('records the grant WITH an audit trail naming who confirmed', async () => {
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue(PUBLISHER);
    const out = await grantSchedulePublishConsent(['sc-1'], 'kevin@ via ENG-827', false);
    expect(out[0].action).toBe('granted');
    const [id, patch] = (mockDb.updateSchedule as jest.Mock).mock.calls[0];
    expect(id).toBe('sc-1');
    expect(patch.autopublishAuthorized).toBe(true);
    expect(patch.autopublishAuthorizedBy).toBe('kevin@ via ENG-827');
    expect(patch.autopublishAuthorizedAt).toEqual(expect.any(String));
  });

  // Consent with no scope authorizes nothing (the resolver returns unauthorized),
  // so writing it would look successful and change no behaviour at all.
  it('REFUSES a schedule with no publishing tool rather than writing a silent no-op', async () => {
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue({
      scheduleName: 'Articles for CHRO Leaders',
      requiredFunctionCalls: ['you_search_web', 'create_blog_article'],
    });
    const out = await grantSchedulePublishConsent(['sc-2'], 'ops', false);
    expect(out[0].action).toBe('skipped-no-publish-tool');
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('never rewrites a schedule that is already authorized', async () => {
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue({
      ...PUBLISHER,
      autopublishAuthorized: true,
    });
    const out = await grantSchedulePublishConsent(['sc-3'], 'ops', false);
    expect(out[0].action).toBe('skipped-already-authorized');
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('reports a missing schedule without throwing or writing', async () => {
    (mockDb.getScheduleById as jest.Mock).mockResolvedValue(null);
    const out = await grantSchedulePublishConsent(['nope'], 'ops', false);
    expect(out[0].action).toBe('not-found');
    expect(mockDb.updateSchedule).not.toHaveBeenCalled();
  });

  it('acts only on the schedules named, in order, mixing outcomes independently', async () => {
    (mockDb.getScheduleById as jest.Mock)
      .mockResolvedValueOnce(PUBLISHER)
      .mockResolvedValueOnce({ scheduleName: 'no-tools', requiredFunctionCalls: [] })
      .mockResolvedValueOnce({ ...PUBLISHER, autopublishAuthorized: true });

    const out = await grantSchedulePublishConsent(['a', 'b', 'c'], 'ops', false);
    expect(out.map(o => o.action)).toEqual([
      'granted',
      'skipped-no-publish-tool',
      'skipped-already-authorized',
    ]);
    expect(mockDb.updateSchedule).toHaveBeenCalledTimes(1);
  });
});
