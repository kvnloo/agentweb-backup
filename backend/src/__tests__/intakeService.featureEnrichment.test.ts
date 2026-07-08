/**
 * ENG-187 contract #4 — feature-request enrichment on the FB-synced Linear issue.
 *
 * "A feature request's Linear issue ends up in Backlog carrying the reporter's stage labels
 *  (Status: <stage> + coarse tag) + 'Needs PM'; no auto-priority, no auto-assignee."
 *
 * Feature requests are Featurebase-first (fileFeatureRequest creates the public post; Featurebase's
 * own FB->Linear sync creates the Linear issue inside their SaaS), so the enrichment seam is the
 * Linear Issue-creation webhook -> enrichFeaturebaseSyncedIssue. Author resolution: issue title ->
 * exact-match FB post -> author email -> AgentWeb user -> funnelStatus.
 *
 * Also re-asserted here: contract #5 (privacy) — enrichment only READS from Featurebase; nothing
 * funnel-related is ever written back to it. Contract #7 (loud failures) — every resolution miss
 * logs an error naming the issue; the "Needs PM" floor is still applied.
 */
import { enrichFeaturebaseSyncedIssue } from '../services/intakeService';

jest.mock('../services/dedupService', () => ({ findDuplicate: jest.fn(), MAX_CANDIDATES: 30 }));
jest.mock('../services/featurebaseService', () => ({
  findPostByTitle: jest.fn(),
  // Write surfaces — must NEVER be touched by enrichment (contract #5: nothing flows back to FB).
  createPost: jest.fn(),
  addComment: jest.fn(),
  addVoter: jest.fn(),
  createTicket: jest.fn(),
  patchTicketStatus: jest.fn(),
}));
jest.mock('../services/linearService', () => ({ raiseIssueTriage: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/db', () => ({ userDb: { getUserByEmail: jest.fn() } }));

const fb = require('../services/featurebaseService');
const linear = require('../services/linearService');
const { userDb } = require('../services/db');

describe('enrichFeaturebaseSyncedIssue — stage labels + Needs PM + Backlog (ENG-187 contract #4)', () => {
  afterEach(() => jest.clearAllMocks());

  it('known author with a funnel stage -> stage labels + "Needs PM", settled in Backlog, NO priority, NO assignee', async () => {
    fb.findPostByTitle.mockResolvedValue({ id: 'post-1', authorEmail: 'payer@e.com' });
    userDb.getUserByEmail.mockResolvedValue({ email: 'payer@e.com', funnelStatus: 'paid_retention_handoff' });

    const r = await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-1', title: 'Dark mode please' });

    expect(fb.findPostByTitle).toHaveBeenCalledWith('Dark mode please');
    expect(userDb.getUserByEmail).toHaveBeenCalledWith('payer@e.com');
    expect(linear.raiseIssueTriage).toHaveBeenCalledTimes(1);
    const [issueId, params] = linear.raiseIssueTriage.mock.calls[0];
    expect(issueId).toBe('uuid-fr-1');
    expect(params.addLabelNames).toEqual(['Status: Paid / Retention Handoff', 'Retention', 'Needs PM']);
    expect(params.settleStateName).toBe('Backlog');
    // No auto-priority, no auto-assignee — feature requests await the weekly PM pass.
    expect(params.priority).toBeUndefined();
    expect(Object.keys(params).sort()).toEqual(['addLabelNames', 'settleStateName']);
    expect(r.labelNames).toEqual(['Status: Paid / Retention Handoff', 'Retention', 'Needs PM']);
  });

  it('sales-stage author -> that stage\'s labels + "Needs PM"', async () => {
    fb.findPostByTitle.mockResolvedValue({ id: 'post-2', authorEmail: 'prospect@e.com' });
    userDb.getUserByEmail.mockResolvedValue({ email: 'prospect@e.com', funnelStatus: 'follow_up' });

    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-2', title: 'CSV export' });

    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-fr-2', {
      addLabelNames: ['Status: Follow-up', 'Sales', 'Needs PM'],
      settleStateName: 'Backlog',
    });
  });

  it('post not found (or ambiguous) -> "Needs PM" only + LOUD error naming the issue', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fb.findPostByTitle.mockResolvedValue(null);

    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-3', title: 'Mystery' });

    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-fr-3', {
      addLabelNames: ['Needs PM'],
      settleStateName: 'Backlog',
    });
    expect(userDb.getUserByEmail).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('uuid-fr-3'));
    errSpy.mockRestore();
  });

  it('author email resolves but no AgentWeb user matches -> "Needs PM" only + LOUD error naming the email', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fb.findPostByTitle.mockResolvedValue({ id: 'post-4', authorEmail: 'stranger@nowhere.com' });
    userDb.getUserByEmail.mockResolvedValue(undefined);

    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-4', title: 'Anon ask' });

    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-fr-4', {
      addLabelNames: ['Needs PM'],
      settleStateName: 'Backlog',
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('stranger@nowhere.com'));
    errSpy.mockRestore();
  });

  it('user found but funnelStatus missing -> "Needs PM" only, and NO error (unstaged users are normal)', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fb.findPostByTitle.mockResolvedValue({ id: 'post-5', authorEmail: 'new@e.com' });
    userDb.getUserByEmail.mockResolvedValue({ email: 'new@e.com' });

    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-5', title: 'Fresh signup ask' });

    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-fr-5', {
      addLabelNames: ['Needs PM'],
      settleStateName: 'Backlog',
    });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('author resolution throwing (FB API down) -> "Needs PM" still applied, LOUD, no throw', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    fb.findPostByTitle.mockRejectedValue(new Error('featurebase 503'));

    await expect(enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-6', title: 'Down time' })).resolves.toEqual({
      labelNames: ['Needs PM'],
    });
    expect(linear.raiseIssueTriage).toHaveBeenCalledWith('uuid-fr-6', {
      addLabelNames: ['Needs PM'],
      settleStateName: 'Backlog',
    });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('uuid-fr-6'), 'featurebase 503');
    errSpy.mockRestore();
  });

  it('a hard failure applying the labels PROPAGATES (the webhook route catches + logs it)', async () => {
    fb.findPostByTitle.mockResolvedValue({ id: 'post-7', authorEmail: 'payer@e.com' });
    userDb.getUserByEmail.mockResolvedValue({ email: 'payer@e.com', funnelStatus: 'activation' });
    linear.raiseIssueTriage.mockRejectedValueOnce(new Error('linear 500'));

    await expect(enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-7', title: 'x' })).rejects.toThrow('linear 500');
  });

  it('privacy (contract #5): enrichment only READS Featurebase — no FB write surface is ever called', async () => {
    fb.findPostByTitle.mockResolvedValue({ id: 'post-8', authorEmail: 'payer@e.com' });
    userDb.getUserByEmail.mockResolvedValue({ email: 'payer@e.com', funnelStatus: 'paid_retention_handoff' });

    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-8', title: 'Privacy check' });

    expect(fb.createPost).not.toHaveBeenCalled();
    expect(fb.addComment).not.toHaveBeenCalled();
    expect(fb.addVoter).not.toHaveBeenCalled();
    expect(fb.createTicket).not.toHaveBeenCalled();
    expect(fb.patchTicketStatus).not.toHaveBeenCalled();
  });

  it('idempotent under webhook retries: a re-delivery re-applies the exact same label set (union-safe)', async () => {
    fb.findPostByTitle.mockResolvedValue({ id: 'post-9', authorEmail: 'payer@e.com' });
    userDb.getUserByEmail.mockResolvedValue({ email: 'payer@e.com', funnelStatus: 'account_setup' });

    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-9', title: 'Retry me' });
    await enrichFeaturebaseSyncedIssue({ issueId: 'uuid-fr-9', title: 'Retry me' });

    expect(linear.raiseIssueTriage).toHaveBeenCalledTimes(2);
    expect(linear.raiseIssueTriage.mock.calls[0]).toEqual(linear.raiseIssueTriage.mock.calls[1]);
    expect(linear.raiseIssueTriage.mock.calls[0][1].addLabelNames).toEqual(['Status: Account Setup', 'Setup', 'Needs PM']);
  });
});
