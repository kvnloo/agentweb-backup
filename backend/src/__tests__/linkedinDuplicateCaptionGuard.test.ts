/**
 * ENG-3015: before an interactive LinkedIn publish, a caption already live on the
 * same page/profile (exact match after whitespace normalisation) stops the publish
 * and requires confirm_duplicate_caption=true. Everything else is unchanged.
 */
jest.mock('unipile-node-sdk', () => ({ UnipileClient: jest.fn().mockImplementation(() => ({})) }), { virtual: true });

jest.mock('../services/connectedAccountsDb', () => ({
  getAccountsWithOwnerIncludingOrgShared: jest.fn(),
  getAccountByIdConsistent: jest.fn(),
  SOCIAL_POSTING_PLATFORMS: ['twitter', 'linkedin', 'instagram', 'youtube'],
}));
jest.mock('../services/socialPlatformService', () => ({ socialPlatformService: { getAdapter: jest.fn() } }));
jest.mock('../services/linkedInPostsDb', () => ({ getPostsByAccount: jest.fn() }));

import { postOnConnectedAccount } from '../emma/impl/linkedin';
import { getAccountsWithOwnerIncludingOrgShared, getAccountByIdConsistent } from '../services/connectedAccountsDb';
import { socialPlatformService } from '../services/socialPlatformService';
import { getPostsByAccount } from '../services/linkedInPostsDb';

const PAGE = 'urn:li:organization:42';
const OTHER = 'urn:li:organization:99';
const account = { account_id: PAGE, platform: 'linkedin', userId: 'u1', account_name: 'Nu', config: { account_type: 'company_page' } };
const CAPTION = 'Meet our speaker  Jane Doe!\n\n#event';

describe('ENG-3015 duplicate-caption guard', () => {
  const createPost = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    (getAccountsWithOwnerIncludingOrgShared as jest.Mock).mockResolvedValue([account]);
    (getAccountByIdConsistent as jest.Mock).mockResolvedValue(account);
    (socialPlatformService.getAdapter as jest.Mock).mockReturnValue({ createPost });
    createPost.mockResolvedValue({ success: true, message: 'Posted successfully on LinkedIn', postId: 'urn:li:share:new', postUrl: 'u' });
  });

  it('blocks a publish whose caption is already live on the page (whitespace-normalised) and returns the existing urn', async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([
      { accountId: PAGE, postId: 'urn:li:share:old', content: 'Meet our speaker Jane Doe! #event' },
    ]);
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, undefined, { duplicateCaptionGuard: true });
    expect(r).toMatchObject({ success: false, duplicate_caption: true, existing_post_urn: 'urn:li:share:old' });
    expect(createPost).not.toHaveBeenCalled();
    expect(getPostsByAccount).toHaveBeenCalledWith(PAGE, 50);
  });

  it('interactive refusal halts the turn so the model cannot self-confirm', async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([{ accountId: PAGE, postId: 'urn:li:share:old', content: CAPTION }]);
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, {}, { duplicateCaptionGuard: true });
    expect(r).toMatchObject({ success: false, duplicate_caption: true, awaitingUserConfirmation: true });
    expect(typeof r.confirmationPrompt).toBe('string');
  });

  it('unattended refusal reports an explicit outcome without halting', async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([{ accountId: PAGE, postId: 'urn:li:share:old', content: CAPTION }]);
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, { isUnattendedRun: true }, { duplicateCaptionGuard: true });
    expect(r).toMatchObject({ success: false, duplicate_caption: true });
    expect(r.awaitingUserConfirmation).toBeUndefined();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('proceeds when the user confirmed (guard not requested)', async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([{ accountId: PAGE, postId: 'urn:li:share:old', content: CAPTION }]);
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, undefined, {});
    expect(r.success).toBe(true);
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(getPostsByAccount).not.toHaveBeenCalled();
  });

  it('proceeds when no stored caption matches', async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([{ accountId: PAGE, postId: 'urn:li:share:old', content: 'Different caption' }]);
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, undefined, { duplicateCaptionGuard: true });
    expect(r.success).toBe(true);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it("ignores another account's post with the same caption", async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([{ accountId: OTHER, postId: 'urn:li:share:x', content: CAPTION }]);
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, undefined, { duplicateCaptionGuard: true });
    expect(r.success).toBe(true);
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('a failing posts read never blocks the publish', async () => {
    (getPostsByAccount as jest.Mock).mockRejectedValue(new Error('ddb down'));
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, undefined, { duplicateCaptionGuard: true });
    expect(r.success).toBe(true);
  });

  it('save_as_draft skips the guard', async () => {
    (getPostsByAccount as jest.Mock).mockResolvedValue([{ accountId: PAGE, postId: 'urn:li:share:old', content: CAPTION }]);
    createPost.mockResolvedValue({ success: true, message: 'draft', postId: 'urn:li:share:d' });
    const r = await postOnConnectedAccount('u1', PAGE, CAPTION, [], undefined, undefined, { duplicateCaptionGuard: true, saveAsDraft: true });
    expect(r.success).toBe(true);
    expect(getPostsByAccount).not.toHaveBeenCalled();
  });
});
