/**
 * Subscriber emails on approval — shared by the Slack and WhatsApp paths (ENG-273).
 */
jest.mock('../services/db', () => ({
  taskDb: { getTaskExecutionById: jest.fn(), getTaskById: jest.fn() },
  subscriberDb: { getTaskSubscribers: jest.fn() },
}));
jest.mock('../services/emailService', () => ({
  emailService: { sendTaskExecutionEmail: jest.fn() },
}));

const { taskDb, subscriberDb } = require('../services/db');
const { emailService } = require('../services/emailService');
import { notifySubscribersOfApproval } from '../services/approvalSubscriberNotify';

const ENV = { ...process.env };

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...ENV };
  delete process.env.SUBSCRIBER_EMAIL_LIMIT;
  taskDb.getTaskExecutionById.mockResolvedValue({ taskId: 'task-1' });
  taskDb.getTaskById.mockResolvedValue({ name: 'Weekly report' });
  subscriberDb.getTaskSubscribers.mockResolvedValue([
    { email: 'a@example.com' },
    { email: 'b@example.com', unsubscribed: true },
    { email: 'c@example.com' },
  ]);
  emailService.sendTaskExecutionEmail.mockResolvedValue(undefined);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  process.env = ENV;
});

it('emails every active subscriber and skips unsubscribed ones', async () => {
  await notifySubscribersOfApproval({ executionId: 'exec-1' });
  const sentTo = emailService.sendTaskExecutionEmail.mock.calls.map((c: any[]) => c[0]);
  expect(sentTo).toEqual(['a@example.com', 'c@example.com']);
  expect(emailService.sendTaskExecutionEmail).toHaveBeenCalledWith('a@example.com', 'exec-1');
});

it('honours SUBSCRIBER_EMAIL_LIMIT', async () => {
  process.env.SUBSCRIBER_EMAIL_LIMIT = '1';
  await notifySubscribersOfApproval({ executionId: 'exec-1' });
  expect(emailService.sendTaskExecutionEmail).toHaveBeenCalledTimes(1);
});

it('keeps going when one subscriber email fails', async () => {
  emailService.sendTaskExecutionEmail.mockRejectedValueOnce(new Error('bounce'));
  await notifySubscribersOfApproval({ executionId: 'exec-1' });
  expect(emailService.sendTaskExecutionEmail).toHaveBeenCalledTimes(2);
});

it.each([null, undefined, {}])('does nothing without an execution id (%p)', async (approval) => {
  await notifySubscribersOfApproval(approval as any);
  expect(taskDb.getTaskExecutionById).not.toHaveBeenCalled();
});

it('does nothing when the execution or task is gone', async () => {
  taskDb.getTaskExecutionById.mockResolvedValue(null);
  await notifySubscribersOfApproval({ executionId: 'exec-1' });
  expect(emailService.sendTaskExecutionEmail).not.toHaveBeenCalled();
});

it('never throws — a recorded approval must not be failed by mail', async () => {
  taskDb.getTaskExecutionById.mockRejectedValue(new Error('dynamo down'));
  await expect(notifySubscribersOfApproval({ executionId: 'exec-1' })).resolves.toBeUndefined();
});
