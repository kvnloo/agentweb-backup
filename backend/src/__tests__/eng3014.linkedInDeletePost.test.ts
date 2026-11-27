/**
 * ENG-3014: linkedin_manage_post action=delete_post.
 * LinkedIn HTTP is mocked on the service's own axios client, so the real service,
 * adapter and impl all run. No live LinkedIn call is possible from this file.
 */
const mockHttp = { get: jest.fn(), delete: jest.fn(), post: jest.fn() };

jest.mock('../services/linkedInPostsDb', () => ({
  ...jest.requireActual('../services/linkedInPostsDb'),
  getPostById: jest.fn(),
  deletePost: jest.fn(),
}));
jest.mock('../services/connectedAccountsDb', () => ({
  ...jest.requireActual('../services/connectedAccountsDb'),
  getAccountByIdConsistent: jest.fn(),
  updateAccountTokens: jest.fn(),
}));
jest.mock('../config/integrations', () => ({ ...jest.requireActual('../config/integrations'), getLinkedInConfig: jest.fn() }));
jest.mock('../services/socialPlatformService', () => {
  const { LinkedInAdapter } = jest.requireActual('../services/adapters/linkedInAdapter');
  const adapter = new LinkedInAdapter();
  return { socialPlatformService: { getAdapter: () => adapter } };
});

import { linkedinDeletePost, linkedinManagePost } from '../emma/impl/linkedin';
import { linkedInService } from '../services/linkedInService';
import * as postsDb from '../services/linkedInPostsDb';
import * as accountsDb from '../services/connectedAccountsDb';
import { isExternalContentPublish } from '../utils/schedulePublishApproval';
import { isPublishCall } from '../utils/schedulePublishAuthorization';
import '../emma/tools';
import { emmaToolRegistry } from '../emma/registry';

const getPostById = postsDb.getPostById as jest.Mock;
const removeStored = postsDb.deletePost as jest.Mock;
const getAccount = accountsDb.getAccountByIdConsistent as jest.Mock;

const TOKEN = 'secret-token-do-not-leak';
const account = (urn: string, type: string) => ({
  account_id: urn,
  platform: 'linkedin',
  userId: 'user-1',
  config: { account_type: type, access_token: TOKEN, token_expires_at: Date.now() + 3_600_000 },
});
const company = account('urn:li:organization:42', 'company_page');
const personal = account('urn:li:person:abc', 'personal');
const notFound = () => Promise.reject(Object.assign(new Error('nf'), { response: { status: 404 } }));
const enc = (urn: string) => `/rest/posts/${encodeURIComponent(urn)}`;

beforeEach(() => {
  jest.clearAllMocks();
  mockHttp.get.mockReset();
  mockHttp.delete.mockReset();
  (linkedInService as any).client = mockHttp;
  getPostById.mockResolvedValue(null);
  removeStored.mockResolvedValue(undefined);
  mockHttp.delete.mockResolvedValue({ status: 204 });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('ENG-3014 linkedin delete_post', () => {
  it.each([
    ['company page', company, 'urn:li:share:7527760199676297216'],
    ['personal profile', personal, 'urn:li:ugcPost:7527760221361025024'],
  ])('deletes a %s post, verifies with a not-found readback, removes the stored row', async (_n, acct, urn) => {
    getAccount.mockResolvedValue(acct);
    mockHttp.get
      .mockResolvedValueOnce({ data: { author: acct.account_id } }) // authorship read
      .mockImplementationOnce(notFound); // readback

    const result = await linkedinDeletePost('user-1', acct.account_id, urn);

    expect(result).toMatchObject({ success: true, post_id: urn });
    expect(mockHttp.delete).toHaveBeenCalledTimes(1);
    expect(mockHttp.delete.mock.calls[0][0]).toBe(enc(urn));
    expect(mockHttp.get).toHaveBeenCalledTimes(2);
    expect(removeStored).toHaveBeenCalledWith('user-1', urn);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify((console.log as jest.Mock).mock.calls)).not.toContain(TOKEN);
  });

  it('trusts a stored row naming this account as author (no authorship read needed)', async () => {
    getAccount.mockResolvedValue(personal);
    getPostById.mockResolvedValue({ accountId: personal.account_id });
    mockHttp.get.mockImplementationOnce(notFound);

    const result = await linkedinDeletePost('user-1', personal.account_id, 'urn:li:share:1');

    expect(result.success).toBe(true);
    expect(mockHttp.get).toHaveBeenCalledTimes(1);
    expect(mockHttp.delete).toHaveBeenCalledTimes(1);
  });

  it('refuses a post stored under a different author with NO LinkedIn call', async () => {
    getAccount.mockResolvedValue(company);
    getPostById.mockResolvedValue({ accountId: 'urn:li:organization:999' });

    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:share:1');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authored/);
    expect(mockHttp.get).not.toHaveBeenCalled();
    expect(mockHttp.delete).not.toHaveBeenCalled();
    expect(removeStored).not.toHaveBeenCalled();
  });

  it('refuses a live post authored by someone else without sending a delete', async () => {
    getAccount.mockResolvedValue(company);
    mockHttp.get.mockResolvedValueOnce({ data: { author: 'urn:li:person:stranger' } });

    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:ugcPost:5');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not authored/);
    expect(mockHttp.delete).not.toHaveBeenCalled();
    expect(removeStored).not.toHaveBeenCalled();
  });

  it('refuses when authorship cannot be read (fails closed)', async () => {
    getAccount.mockResolvedValue(personal);
    mockHttp.get.mockRejectedValueOnce(Object.assign(new Error('forbidden'), { response: { status: 403 } }));

    const result = await linkedinDeletePost('user-1', personal.account_id, 'urn:li:share:5');

    expect(result.success).toBe(false);
    expect(mockHttp.delete).not.toHaveBeenCalled();
  });

  it('refuses an account the caller may not use, with no LinkedIn call', async () => {
    getAccount.mockResolvedValue(null);

    const result = await linkedinDeletePost('user-1', 'urn:li:organization:not-mine', 'urn:li:share:1');

    expect(result).toEqual({ success: false, message: 'Account not found or access denied' });
    expect(getAccount).toHaveBeenCalledWith('urn:li:organization:not-mine', 'user-1', 'linkedin');
    expect(mockHttp.get).not.toHaveBeenCalled();
    expect(mockHttp.delete).not.toHaveBeenCalled();
  });

  it('reports failure when LinkedIn rejects the delete, and keeps the stored row', async () => {
    getAccount.mockResolvedValue(company);
    mockHttp.get.mockResolvedValueOnce({ data: { author: company.account_id } });
    mockHttp.delete.mockRejectedValueOnce(Object.assign(new Error('boom'), { response: { status: 500 } }));

    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:share:1');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/not deleted/);
    expect(removeStored).not.toHaveBeenCalled();
  });

  it('does not claim deletion when the readback still returns the post', async () => {
    getAccount.mockResolvedValue(company);
    mockHttp.get.mockResolvedValue({ data: { author: company.account_id } });

    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:share:1');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/NOT confirmed deleted/);
    expect(removeStored).not.toHaveBeenCalled();
  });

  it('does not claim deletion when the readback itself errors', async () => {
    getAccount.mockResolvedValue(company);
    mockHttp.get
      .mockResolvedValueOnce({ data: { author: company.account_id } })
      .mockRejectedValueOnce(Object.assign(new Error('x'), { response: { status: 403 } }));

    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:share:1');

    expect(result.success).toBe(false);
    expect(removeStored).not.toHaveBeenCalled();
  });

  it('does not delete when publish consent is withdrawn during the authorship read', async () => {
    getAccount.mockResolvedValue(company);
    mockHttp.get.mockResolvedValueOnce({ data: { author: company.account_id } });
    // First read (entry check) still authorized; withdrawn by the time the DELETE is due.
    const assertPublishStillAuthorized = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ error: 'Publish authorization was withdrawn.' });

    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:share:1', { assertPublishStillAuthorized });

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/withdrawn/);
    expect(mockHttp.delete).not.toHaveBeenCalled();
    expect(removeStored).not.toHaveBeenCalled();
  });

  it('re-reads consent before a fresh-token retry of the delete and stops if withdrawn', async () => {
    const { LinkedInAdapter } = jest.requireActual('../services/adapters/linkedInAdapter');
    const adapter = new LinkedInAdapter();
    jest.spyOn(adapter as any, 'getValidToken').mockResolvedValue({ token: TOKEN, isFresh: true });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as any);
    getPostById.mockResolvedValue({ accountId: company.account_id });
    mockHttp.delete.mockRejectedValue(Object.assign(new Error('unauthorized'), { response: { status: 401 } }));
    const assertStillAuthorized = jest.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({ error: 'Publish authorization was withdrawn.' });

    const result = await adapter.deletePost(company, 'urn:li:share:1', 'user-1', assertStillAuthorized);
    (global.setTimeout as unknown as jest.SpyInstance).mockRestore();

    expect(result).toEqual({ success: false, message: 'Publish authorization was withdrawn.' });
    expect(mockHttp.delete).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-post URN before any lookup', async () => {
    getAccount.mockResolvedValue(company);
    const result = await linkedinDeletePost('user-1', company.account_id, 'urn:li:activity:1');
    expect(result.success).toBe(false);
    expect(mockHttp.get).not.toHaveBeenCalled();
    expect(mockHttp.delete).not.toHaveBeenCalled();
  });

  it('dispatcher routes delete_post and requires post_urn', async () => {
    const deps: any = { linkedinDeletePost: jest.fn().mockResolvedValue({ success: true }) };
    await linkedinManagePost('user-1', { action: 'delete_post', account_id: 'a', post_urn: 'urn:li:share:1' }, { x: 1 }, deps);
    expect(deps.linkedinDeletePost).toHaveBeenCalledWith('user-1', 'a', 'urn:li:share:1', { x: 1 });
    const missing = await linkedinManagePost('user-1', { action: 'delete_post', account_id: 'a' }, undefined, deps);
    expect(missing).toEqual({ success: false, message: 'post_urn is required for action=delete_post' });
  });

  it('is held on unattended runs by the existing approval/authorization gates', () => {
    expect(isExternalContentPublish('linkedin_manage_post', { action: 'delete_post' })).toBe(true);
    expect(isExternalContentPublish('linkedin_manage_post', { action: 'delete-post' })).toBe(true);
    expect(isPublishCall('linkedin_manage_post', { action: 'delete_post' })).toBe(true);
  });

  it('tool description requires explicit user approval before deleting', () => {
    const def = emmaToolRegistry.getTool('linkedin_manage_post')!.definition;
    expect(def.inputSchema.properties.action.enum).toContain('delete_post');
    expect(def.description).toMatch(/delete_post:.*CRITICAL: Always get explicit user approval before deleting\./);
  });
});
