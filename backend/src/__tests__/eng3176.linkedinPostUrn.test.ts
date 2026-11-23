/**
 * ENG-3176: linkedin_manage_post list_comments failed with
 * "LinkedIn Error: Syntax exception in path variables" when the model passed a
 * post URL or bare id instead of a URN.
 */
import { normalizeLinkedInPostUrn } from '../emma/impl/linkedinPostUrn';
import { linkedinManagePost } from '../emma/impl/linkedin';

describe('normalizeLinkedInPostUrn', () => {
  it.each([
    ['urn:li:share:123', 'urn:li:share:123'],
    ['urn:li:ugcPost:456', 'urn:li:ugcPost:456'],
    ['  urn:li:activity:789 ', 'urn:li:activity:789'],
    ['urn%3Ali%3Aactivity%3A789', 'urn:li:activity:789'],
    ['https://www.linkedin.com/feed/update/urn:li:activity:7123456789012/', 'urn:li:activity:7123456789012'],
    ['https://www.linkedin.com/feed/update/urn%3Ali%3AugcPost%3A7123/?utm=x', 'urn:li:ugcPost:7123'],
    ['https://www.linkedin.com/posts/acme_launch-day-activity-7123456789012-AbCd', 'urn:li:activity:7123456789012'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeLinkedInPostUrn(input)).toEqual({ ok: true, urn: expected });
  });

  it.each(['7123456789012', 'not a post', 'https://www.linkedin.com/in/someone', ''])(
    'rejects %p with a model-facing message',
    (input) => {
      const r = normalizeLinkedInPostUrn(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(/post_urn/);
    },
  );
});

describe('linkedinManagePost post_urn normalization', () => {
  const makeDeps = () => ({
    linkedinRepost: jest.fn().mockResolvedValue({ success: true }),
    commentOnLinkedInPost: jest.fn().mockResolvedValue({ success: true }),
    listLinkedInComments: jest.fn().mockResolvedValue({ success: true, comments: [] }),
    reactToLinkedInPost: jest.fn().mockResolvedValue({ success: true }),
    linkedinDeletePost: jest.fn().mockResolvedValue({ success: true }),
    getPostAnalytics: jest.fn().mockResolvedValue({ success: true }),
  });

  it('passes a URN extracted from a post URL to list_comments', async () => {
    const deps = makeDeps();
    await linkedinManagePost('u1', {
      action: 'list_comments',
      account_id: 'a1',
      post_urn: 'https://www.linkedin.com/feed/update/urn:li:activity:7123456789012/',
    }, undefined, deps as any);
    expect(deps.listLinkedInComments).toHaveBeenCalledWith('u1', 'a1', 'urn:li:activity:7123456789012');
  });

  it('returns a validation error instead of calling LinkedIn for a bare id', async () => {
    const deps = makeDeps();
    const res = await linkedinManagePost('u1', {
      action: 'list_comments', account_id: 'a1', post_urn: '7123456789012',
    }, undefined, deps as any);
    expect(res.success).toBe(false);
    expect(res.message).toMatch(/ambiguous/);
    expect(deps.listLinkedInComments).not.toHaveBeenCalled();
  });

  it('does not touch delete_post ids', async () => {
    const deps = makeDeps();
    await linkedinManagePost('u1', { action: 'delete_post', account_id: 'a1', post_urn: 'raw-id' }, undefined, deps as any);
    expect(deps.linkedinDeletePost).toHaveBeenCalledWith('u1', 'a1', 'raw-id', undefined);
  });
});

describe('ENG-3176 CodeRabbit follow-up: strict validation', () => {
  const { normalizeLinkedInPostUrn: n } = require('../emma/impl/linkedinPostUrn');
  it('rejects URNs with trailing junk', () => {
    expect(n('urn:li:share:123oops').ok).toBe(false);
  });
  it('rejects activity slugs on non-LinkedIn hosts', () => {
    expect(n('https://example.com/posts/a-activity-7123456789-AbCd').ok).toBe(false);
  });
  it('still accepts LinkedIn post URLs', () => {
    expect(n('https://www.linkedin.com/posts/acme_title-activity-7123456789-AbCd')).toEqual({ ok: true, urn: 'urn:li:activity:7123456789' });
    expect(n('https://www.linkedin.com/feed/update/urn:li:share:7123456789/')).toEqual({ ok: true, urn: 'urn:li:share:7123456789' });
  });
});
