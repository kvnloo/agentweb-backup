import { getApproverChannel } from '../services/approverDirectory';
import { settingsService } from '../services/settingsService';

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
const getSetting = settingsService.getSetting as jest.Mock;

const KEYS = ['APPROVAL_INBOX_DEFAULT_SLACK_CHANNEL', 'HUMAN_EVAL_SLACK_CHANNEL', 'EVAL_QUEUE_SLACK_CHANNEL', 'SLACK_EVAL_CHANNEL'];
const saved: Record<string, string | undefined> = {};
const withSettings = (m: Record<string, string>) => getSetting.mockImplementation(async (k: string) => (m[k] ? { settingValue: m[k] } : null));

describe('getApproverChannel', () => {
  beforeEach(() => { KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); getSetting.mockReset(); });
  afterEach(() => { KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('prefers the per-approver channel, then the approval-inbox default', async () => {
    withSettings({ approval_inbox_channel_matt: 'C-PER', approval_inbox_channel_default: 'C-DEF', human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverChannel('matt')).toBe('C-PER');
    withSettings({ approval_inbox_channel_default: 'C-DEF', human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverChannel('matt')).toBe('C-DEF');
  });

  it('falls back to the eval-queue channel so Desk reminders land where reviewers already look', async () => {
    withSettings({ human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverChannel('fangfang')).toBe('C-EVAL');
  });

  it('falls back to the eval-queue env vars, and throws when nothing is configured', async () => {
    withSettings({});
    process.env.EVAL_QUEUE_SLACK_CHANNEL = ' C-ENV ';
    expect(await getApproverChannel('matt')).toBe('C-ENV');
    delete process.env.EVAL_QUEUE_SLACK_CHANNEL;
    await expect(getApproverChannel('matt')).rejects.toThrow('No Slack channel configured');
  });
});
