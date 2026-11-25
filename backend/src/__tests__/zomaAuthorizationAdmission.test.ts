const mockUser = jest.fn();
const mockAdmit = jest.fn();
jest.mock('../services/db', () => ({ userDb: { getUserById: (...a: unknown[]) => mockUser(...a) } }));
jest.mock('../services/zomaAdmission', () => ({ zomaAdmissionEnabled: () => process.env.ZOMA_WAITLIST_ENABLED === 'true', admitZomaSignup: (...a: unknown[]) => mockAdmit(...a) }));
import { admitZomaAuthorizationSignup } from '../services/zomaAuthorizationAdmission';

beforeEach(() => { jest.clearAllMocks(); process.env.ZOMA_WAITLIST_ENABLED='true'; process.env.ZOMA_WAITLIST_COHORT_STARTED_AT='2026-11-13T00:00:00.000Z'; mockAdmit.mockResolvedValue('approved'); });
afterEach(() => { delete process.env.ZOMA_WAITLIST_ENABLED; delete process.env.ZOMA_WAITLIST_COHORT_STARTED_AT; });
it('gates a new account returning to Zoma after generic password or Google signup', async () => {
  mockUser.mockResolvedValue({ email:'new@company.example', createdAt:'2026-11-13T01:00:00.000Z' });
  expect(await admitZomaAuthorizationSignup('new')).toBe('approved');
  expect(mockAdmit).toHaveBeenCalledWith('new@company.example');
});
it('never reserves seats for accounts grandfathered before enablement', async () => {
  mockUser.mockResolvedValue({ email:'old@company.example', createdAt:'2026-11-12T01:00:00.000Z' });
  expect(await admitZomaAuthorizationSignup('old')).toBe('approved');
  expect(mockAdmit).not.toHaveBeenCalled();
});
it('fails closed on missing cohort configuration and propagates overflow', async () => {
  delete process.env.ZOMA_WAITLIST_COHORT_STARTED_AT;
  await expect(admitZomaAuthorizationSignup('new')).rejects.toThrow('cohort');
  process.env.ZOMA_WAITLIST_COHORT_STARTED_AT='2026-11-13T00:00:00.000Z';
  mockUser.mockResolvedValue({ email:'new@company.example', createdAt:'2026-11-13T01:00:00.000Z' });
  mockAdmit.mockResolvedValue('waitlisted');
  expect(await admitZomaAuthorizationSignup('new')).toBe('waitlisted');
});
it('is dark without reading user or counter', async () => {
  delete process.env.ZOMA_WAITLIST_ENABLED;
  expect(await admitZomaAuthorizationSignup('new')).toBe('approved');
  expect(mockUser).not.toHaveBeenCalled(); expect(mockAdmit).not.toHaveBeenCalled();
});

describe('ENG-2781 Databricks-origin authorization', () => {
  const fresh = { email: 'new@company.example', createdAt: '2026-11-13T01:00:00.000Z' };

  it('passes the Databricks origin to the seat decision for an account created since launch', async () => {
    mockUser.mockResolvedValue(fresh);
    expect(await admitZomaAuthorizationSignup('new', { databricks: true })).toBe('approved');
    expect(mockAdmit).toHaveBeenCalledWith('new@company.example', undefined, { databricks: true });
  });
  it.each([undefined, {}, { databricks: false }])('an authorization with origin %p is decided exactly as before', async (origin) => {
    mockUser.mockResolvedValue(fresh);
    mockAdmit.mockResolvedValue('waitlisted');
    expect(await admitZomaAuthorizationSignup('new', origin)).toBe('waitlisted');
    expect(mockAdmit.mock.calls).toEqual([['new@company.example']]); // the email only: no origin argument
  });
  it('is dark without reading user or counter, even for a Databricks origin', async () => {
    delete process.env.ZOMA_WAITLIST_ENABLED;
    expect(await admitZomaAuthorizationSignup('new', { databricks: true })).toBe('approved');
    expect(mockUser).not.toHaveBeenCalled(); expect(mockAdmit).not.toHaveBeenCalled();
  });
  it('still grandfathers pre-launch accounts and still fails closed on missing cohort configuration', async () => {
    mockUser.mockResolvedValue({ email: 'old@company.example', createdAt: '2026-11-12T01:00:00.000Z' });
    expect(await admitZomaAuthorizationSignup('old', { databricks: true })).toBe('approved');
    expect(mockAdmit).not.toHaveBeenCalled();
    delete process.env.ZOMA_WAITLIST_COHORT_STARTED_AT;
    await expect(admitZomaAuthorizationSignup('new', { databricks: true })).rejects.toThrow('cohort');
  });
});
