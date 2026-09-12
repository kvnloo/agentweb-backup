import { evaluationSocketDecision, SocketAccountRecord, SocketTokenClaims } from '../utils/socketEvaluationAuth';

type Policy = (userId: string) => Promise<unknown>;
type Load = () => Promise<SocketAccountRecord | null>;

/**
 * ENG-1907 AC1: the real portal streams `session-message-appended` over
 * socket.io, so an active sandbox principal must be admitted on the same policy
 * check the HTTP layer uses — and refused on every signal that revokes it.
 */
const active = async (userId: string) => ({ userId, email: 'c@example.invalid', status: 'active' as const, expiresAt: Date.now() + 60000 });
const denied: Policy = async () => { throw new Error('Evaluation access denied'); };
const account: Load = async () => ({ userId: 'eval_test', email: 'c@example.invalid', isActive: true, isAdmin: false, sessionVersion: 3 });
const base: SocketTokenClaims = { userId: 'eval_test', email: 'c@example.invalid', sv: 3 };
const delegate = { scope: 'evaluation', adminUserId: 'admin', adminEmail: 'a@example.invalid', targetUserId: 'eval_test', targetEmail: 'c@example.invalid' };

it('a non-evaluation token is not decided here', async () => {
  expect(await evaluationSocketDecision({ userId: 'customer', sv: 1 }, active, account)).toBe('not_evaluation');
});
it('admits an active sandbox principal', async () => {
  expect(await evaluationSocketDecision(base, active, account)).toBe('allow');
});
it('admits an evaluation-scoped delegate for its own target', async () => {
  expect(await evaluationSocketDecision({ ...base, delegateAccess: delegate }, active, account)).toBe('allow');
});
it.each([
  ['revoked or expired policy', base, denied, account],
  ['service token', { ...base, _svc: true }, active, account],
  ['admin-flagged token', { ...base, isAdmin: true }, active, account],
  ['generic delegate', { ...base, delegateAccess: { ...delegate, scope: undefined } }, active, account],
  ['delegate for another target', { ...base, delegateAccess: { ...delegate, targetUserId: 'other' } }, active, account],
  ['delegate minted by an evaluation actor', { ...base, delegateAccess: { ...delegate, adminUserId: 'eval_admin' } }, active, account],
  ['token behind the session version', { ...base, sv: 2 }, active, account],
  ['missing account', base, active, async () => null],
  ['account identity mismatch', base, active, async () => ({ userId: 'other', email: 'c@example.invalid', isActive: true, isAdmin: false, sessionVersion: 3 })],
  ['deactivated account', base, active, async () => ({ userId: 'eval_test', email: 'c@example.invalid', isActive: false, isAdmin: false, sessionVersion: 3 })],
  ['account that became admin', base, active, async () => ({ userId: 'eval_test', email: 'c@example.invalid', isActive: true, isAdmin: true, sessionVersion: 3 })],
  ['account that joined an org', base, active, async () => ({ userId: 'eval_test', email: 'c@example.invalid', isActive: true, isAdmin: false, orgId: 'org', sessionVersion: 3 })],
  ['account lookup failure', base, active, async () => { throw new Error('dynamo down'); }],
  ['evaluation target with a non-evaluation subject', { userId: 'admin', email: 'a@example.invalid', delegateAccess: { ...delegate, targetUserId: 'eval_test' } }, active, account],
] as Array<[string, SocketTokenClaims, Policy, Load]>)('refuses: %s', async (_label, claims, policy, load) => {
  expect(await evaluationSocketDecision(claims, policy, load)).toBe('deny');
});
