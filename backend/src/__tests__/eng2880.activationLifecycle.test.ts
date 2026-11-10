jest.mock('../services/db', () => ({ userDb: { getUserById: jest.fn(), getUserByEmail: jest.fn(), recordZomaActivationEvent: jest.fn() } }));
jest.mock('../services/waitlistDb', () => ({ waitlistDb: { getByEmail: jest.fn() } }));
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emitActivationSignup, emitActivationLogin, emitWaitlistApproval } from '../services/zomaActivationEvents';
const user = { userId: 'u1', email: 'u@b.co', createdAt: '2026-01-01T00:00:00.000Z' };
const original = process.env.ZOMA_ACTIVATION_EVENTS_ENABLED;
beforeEach(() => {
  process.env.ZOMA_ACTIVATION_EVENTS_ENABLED = 'true';
  (userDb.getUserById as jest.Mock).mockResolvedValue(user);
  (userDb.getUserByEmail as jest.Mock).mockResolvedValue(user);
  (userDb.recordZomaActivationEvent as jest.Mock).mockResolvedValue(true);
  (waitlistDb.getByEmail as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => { if (original === undefined) delete process.env.ZOMA_ACTIVATION_EVENTS_ENABLED; else process.env.ZOMA_ACTIVATION_EVENTS_ENABLED = original; });
it('signup uses persisted identity and actual createdAt without a GSI read', async () => {
  await emitActivationSignup(user.userId, user.email, user.createdAt);
  expect(userDb.getUserById).not.toHaveBeenCalled();
  expect(userDb.recordZomaActivationEvent).toHaveBeenCalledWith(user, 'signed_up', { userId: 'u1', timestamp: user.createdAt });
});
it('approval before account creation links invitedAt on signup', async () => {
  (waitlistDb.getByEmail as jest.Mock).mockResolvedValue({ status: 'invited', invitedAt: '2025-12-30T00:00:00Z' });
  await emitActivationSignup(user.userId, user.email, user.createdAt);
  expect((userDb.recordZomaActivationEvent as jest.Mock).mock.calls.map(c => [c[1], c[2].timestamp])).toEqual([['signed_up', user.createdAt], ['approved_from_waitlist', '2025-12-30T00:00:00.000Z']]);
});
it('pending waitlist does not imply approval', async () => {
  (waitlistDb.getByEmail as jest.Mock).mockResolvedValue({ status: 'pending' });
  await emitActivationSignup(user.userId, user.email, user.createdAt);
  expect(userDb.recordZomaActivationEvent).toHaveBeenCalledTimes(1);
});
it('approval without account does not invent an identity', async () => {
  (userDb.getUserByEmail as jest.Mock).mockResolvedValue(undefined);
  await emitWaitlistApproval('future@b.co');
  expect(userDb.recordZomaActivationEvent).not.toHaveBeenCalled();
});
it('existing account approval resolves userId', async () => {
  await emitWaitlistApproval(user.email);
  expect(userDb.recordZomaActivationEvent).toHaveBeenCalledWith(user, 'approved_from_waitlist', expect.objectContaining({ userId: 'u1' }));
});
it('login emits both login and later-UTC-day observation', async () => {
  jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-09T00:00:00Z'));
  await emitActivationLogin('u1');
  expect((userDb.recordZomaActivationEvent as jest.Mock).mock.calls.map(c => c[1])).toEqual(['logged_in', 'returned_later_day']);
  jest.restoreAllMocks();
});
it('disabled signup/approval/login have no DB reads or writes', async () => {
  process.env.ZOMA_ACTIVATION_EVENTS_ENABLED = 'false';
  await emitActivationSignup('u1', user.email);
  await emitWaitlistApproval(user.email);
  await emitActivationLogin('u1');
  expect(userDb.getUserById).not.toHaveBeenCalled();
  expect(userDb.getUserByEmail).not.toHaveBeenCalled();
  expect(waitlistDb.getByEmail).not.toHaveBeenCalled();
  expect(userDb.recordZomaActivationEvent).not.toHaveBeenCalled();
});
