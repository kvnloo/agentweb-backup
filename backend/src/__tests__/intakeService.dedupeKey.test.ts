/**
 * fileAutoIssue dedupeKey — one incident per run (ENG-145/146).
 *
 * When a dedupeKey (the runId) is provided and the run store is enabled,
 * fileAutoIssue claims incident#<key> via a conditional put BEFORE filing.
 * The second caller for the same run gets a deduped no-op result — so a run
 * whose validation-fail AND exception paths both fire can never file twice.
 */
jest.mock('../services/agentMode/runStore', () => ({
  isRunStoreEnabled: jest.fn().mockReturnValue(true),
  claimIncident: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/linearService', () => ({
  listOpenIssuesByLabel: jest.fn().mockResolvedValue([]),
  addIssueComment: jest.fn().mockResolvedValue(undefined),
  createInternalLinearIssue: jest.fn().mockResolvedValue({
    id: 'uuid-1',
    identifier: 'ENG-999',
    url: 'https://linear.app/emmabyaw/issue/ENG-999',
  }),
}));

jest.mock('../services/notionService', () => ({
  createOncallItem: jest.fn().mockResolvedValue({ pageId: 'notion-1', notionUrl: 'https://notion.so/x' }),
}));

import { fileAutoIssue } from '../services/intakeService';
import * as runStore from '../services/agentMode/runStore';
import { createInternalLinearIssue } from '../services/linearService';
import { createOncallItem } from '../services/notionService';

const mockClaimIncident = runStore.claimIncident as jest.Mock;
const mockIsEnabled = runStore.isRunStoreEnabled as jest.Mock;

const baseParams = {
  title: 'Scheduled Chat Error: X',
  description: 'boom',
  source: 'Scheduled chat (error)',
};

describe('fileAutoIssue dedupeKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockClaimIncident.mockResolvedValue(true);
    process.env.FEATUREBASE_INTAKE = 'true';
  });

  afterAll(() => {
    delete process.env.FEATUREBASE_INTAKE;
  });

  it('claim won → files the issue exactly once', async () => {
    const result = await fileAutoIssue({ ...baseParams, dedupeKey: 'run-1' });
    expect(mockClaimIncident).toHaveBeenCalledWith('run-1');
    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
    expect(result.deduped).toBe(false);
  });

  it('claim lost (incident already filed for this run) → returns deduped WITHOUT filing', async () => {
    mockClaimIncident.mockResolvedValue(false);
    const result = await fileAutoIssue({ ...baseParams, dedupeKey: 'run-1' });
    expect(createInternalLinearIssue).not.toHaveBeenCalled();
    expect(createOncallItem).not.toHaveBeenCalled();
    expect(result.deduped).toBe(true);
  });

  it('claim error propagates (caller\'s best-effort .catch logs it — no hidden reroute)', async () => {
    mockClaimIncident.mockRejectedValue(new Error('ddb down'));
    await expect(fileAutoIssue({ ...baseParams, dedupeKey: 'run-1' })).rejects.toThrow('ddb down');
    expect(createInternalLinearIssue).not.toHaveBeenCalled();
  });

  it('no dedupeKey → files without touching the run store (back-compat)', async () => {
    await fileAutoIssue({ ...baseParams });
    expect(mockClaimIncident).not.toHaveBeenCalled();
    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
  });

  it('run store disabled → dedupeKey ignored, files as today', async () => {
    mockIsEnabled.mockReturnValue(false);
    await fileAutoIssue({ ...baseParams, dedupeKey: 'run-1' });
    expect(mockClaimIncident).not.toHaveBeenCalled();
    expect(createInternalLinearIssue).toHaveBeenCalledTimes(1);
  });

  it('dedupe also guards the Notion (flag-off) path', async () => {
    process.env.FEATUREBASE_INTAKE = 'false';
    mockClaimIncident.mockResolvedValue(false);
    const result = await fileAutoIssue({ ...baseParams, dedupeKey: 'run-1' });
    expect(createOncallItem).not.toHaveBeenCalled();
    expect(result.deduped).toBe(true);
  });
});
