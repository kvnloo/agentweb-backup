import { getApproverChannel, getApproverReminderChannel } from '../services/approverDirectory';
import { settingsService } from '../services/settingsService';

jest.mock('../services/settingsService', () => ({ settingsService: { getSetting: jest.fn() } }));
const getSetting = settingsService.getSetting as jest.Mock;

const KEYS = ['APPROVAL_INBOX_DEFAULT_SLACK_CHANNEL', 'HUMAN_EVAL_SLACK_CHANNEL', 'EVAL_QUEUE_SLACK_CHANNEL', 'SLACK_EVAL_CHANNEL'];
const saved: Record<string, string | undefined> = {};
const withSettings = (m: Record<string, string>) => getSetting.mockImplementation(async (k: string) => (m[k] ? { settingValue: m[k] } : null));

describe('approver Slack channels', () => {
  beforeEach(() => { KEYS.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); getSetting.mockReset(); });
  afterEach(() => { KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  it('getApproverChannel prefers the per-approver channel, then the approval-inbox default', async () => {
    withSettings({ approval_inbox_channel_matt: 'C-PER', approval_inbox_channel_default: 'C-DEF', human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverChannel('matt')).toBe('C-PER');
    withSettings({ approval_inbox_channel_default: 'C-DEF', human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverChannel('matt')).toBe('C-DEF');
  });

  it('getApproverChannel does NOT fall back to the eval queue: the interactive queue message, resolution/expiry notices and plan_choice staging stay dormant until configured on purpose', async () => {
    withSettings({ human_eval_slack_channel: 'C-EVAL' });
    process.env.EVAL_QUEUE_SLACK_CHANNEL = 'C-ENV';
    await expect(getApproverChannel('matt')).rejects.toThrow('No Slack channel configured');
  });

  it('getApproverReminderChannel uses the configured approver channel when there is one', async () => {
    withSettings({ approval_inbox_channel_fangfang: 'C-PER', human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverReminderChannel('fangfang')).toBe('C-PER');
  });

  it('getApproverReminderChannel falls back to the eval-queue channel (setting, then env) so the reminder lands where reviewers already look', async () => {
    withSettings({ human_eval_slack_channel: 'C-EVAL' });
    expect(await getApproverReminderChannel('matt')).toBe('C-EVAL');
    withSettings({});
    process.env.EVAL_QUEUE_SLACK_CHANNEL = ' C-ENV ';
    expect(await getApproverReminderChannel('matt')).toBe('C-ENV');
  });

  it('getApproverReminderChannel throws the original error when nothing is configured', async () => {
    withSettings({});
    await expect(getApproverReminderChannel('matt')).rejects.toThrow('No Slack channel configured');
  });
});
