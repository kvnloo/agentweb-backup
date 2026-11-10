jest.mock('../services/db');
jest.mock('../services/emailService');
jest.mock('../services/waitlistDb');
jest.mock('../services/crmAutoSyncService', () => ({ syncUserUpdateToLeadList: jest.fn(), syncNewUserToLeadList: jest.fn() }));
jest.mock('../services/subscriptionService', () => ({ DEFAULT_PAGES: ['/'], getTierConfig: jest.fn().mockResolvedValue({ allowedPages: ['/'], allowedSkills: [] }) }));
jest.mock('../middleware/auth', () => ({ authenticateToken: jest.fn() }));
jest.mock('../services/zomaActivationEvents', () => ({ emitWaitlistApproval: jest.fn().mockResolvedValue(undefined) }));
import routes from '../routes/admin';
import { userDb } from '../services/db';
import { waitlistDb } from '../services/waitlistDb';
import { emailService } from '../services/emailService';
import { emitWaitlistApproval } from '../services/zomaActivationEvents';
const user: any = { userId: 'u1', email: 'u@b.co', roles: ['free'] };
function response() { const r: any = {}; r.status = jest.fn().mockReturnValue(r); r.json = jest.fn().mockReturnValue(r); return r; }
const handler = (path: string, method: string) => {
  const route = (routes as any).stack.find((s: any) => s.route?.path === path && s.route.methods[method]).route;
  return route.stack[route.stack.length - 1].handle;
};
beforeEach(() => {
  (userDb.getUserByEmail as jest.Mock).mockResolvedValue(user);
  (userDb.updateUser as jest.Mock).mockResolvedValue(user);
  (waitlistDb.getByEmail as jest.Mock).mockResolvedValue({ email: user.email, status: 'invited' });
  (emailService.sendWelcomeEmail as jest.Mock).mockResolvedValue(undefined);
});
it('admin create-user upgrade emits approval only after waitlist completion', async () => {
  const r = response();
  await handler('/waitlist/:email/create-user', 'post')({ params: { email: user.email }, body: {} }, r);
  expect(r.status).not.toHaveBeenCalled();
  expect(waitlistDb.updateStatus).toHaveBeenCalledWith(user.email, 'completed');
  expect(emitWaitlistApproval).toHaveBeenCalledWith(user.email);
});
it('admin status invited emits after welcome email succeeds, not after email rollback', async () => {
  const call = handler('/waitlist/:email/status', 'put');
  const req = { params: { email: user.email }, body: { status: 'invited' } };
  await call(req, response());
  expect(emitWaitlistApproval).toHaveBeenCalledWith(user.email);
  (emitWaitlistApproval as jest.Mock).mockClear();
  (emailService.sendWelcomeEmail as jest.Mock).mockRejectedValueOnce(new Error('email unavailable'));
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  const r = response(); await call(req, r);
  expect(r.status).toHaveBeenCalledWith(500);
  expect(waitlistDb.updateStatus).toHaveBeenCalledWith(user.email, 'pending');
  expect(emitWaitlistApproval).not.toHaveBeenCalled();
  log.mockRestore();
});
it('admin resend emits approval for existing free user after successful send', async () => {
  await handler('/waitlist/resend-invitation', 'post')({ body: { email: user.email } }, response());
  expect(emitWaitlistApproval).toHaveBeenCalledWith(user.email);
});
it('admin manual invite emits approval only when inviting', async () => {
  (waitlistDb.getByEmail as jest.Mock).mockResolvedValue(undefined);
  const call = handler('/waitlist/invite', 'post');
  await call({ body: { email: user.email, sendInvitation: true } }, response());
  expect(emitWaitlistApproval).toHaveBeenCalledWith(user.email);
  (emitWaitlistApproval as jest.Mock).mockClear();
  await call({ body: { email: user.email, sendInvitation: false } }, response());
  expect(emitWaitlistApproval).not.toHaveBeenCalled();
});
