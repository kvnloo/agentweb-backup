/**
 * ENG-2426 — fileAutoIssue is list-then-create, so two concurrent filers both saw no canonical and
 * both created (ENG-2416/2417 filed 0.3s apart). Contract (from the issue):
 *  1. Racing calls both resolve to the same canonical; exactly one stays open.
 *  2. The loser is closed (duplicate) with a comment linking the winner; the winner gets an occurrence comment.
 *  3. A non-racing create is unchanged.
 *  4. Reconciliation errors are swallowed and the created issue is returned as before.
 */

const listOpenIssuesByLabel = jest.fn();
const addIssueComment = jest.fn();
const createInternalLinearIssue = jest.fn();
const escalateIssue = jest.fn();
const markIssueDuplicateOf = jest.fn();
const findMostRecentArchivedIssueByLabel = jest.fn();

jest.mock('../linearService', () => ({
  listOpenIssuesByLabel: (...a: any[]) => listOpenIssuesByLabel(...a),
  addIssueComment: (...a: any[]) => addIssueComment(...a),
  createInternalLinearIssue: (...a: any[]) => createInternalLinearIssue(...a),
  escalateIssue: (...a: any[]) => escalateIssue(...a),
  markIssueDuplicateOf: (...a: any[]) => markIssueDuplicateOf(...a),
  findMostRecentArchivedIssueByLabel: (...a: any[]) => findMostRecentArchivedIssueByLabel(...a),
}));

import { fileAutoIssue } from '../intakeService';

const TITLE = 'Meta ad account 409853340719899 cannot be read — token invalid';
const params = {
  title: TITLE,
  description: 'Meta rejected our stored credentials.',
  source: 'Oncall alert',
  notionContext: { 'Alert Class': 'meta-token-invalid', 'Ad Account': '409853340719899' },
} as any;

const row = (n: number) => ({
  identifier: `ENG-${n}`,
  issueId: `uuid-${n}`,
  title: TITLE,
  description: `body\nAlert Class: meta-token-invalid`,
});

beforeEach(() => {
  jest.resetAllMocks();
  findMostRecentArchivedIssueByLabel.mockResolvedValue(null);
  addIssueComment.mockResolvedValue(undefined);
  markIssueDuplicateOf.mockResolvedValue(undefined);
});

describe('fileAutoIssue concurrent-filer reconciliation (ENG-2426)', () => {
  it('two racing filers converge on the oldest canonical; the newer is marked duplicate', async () => {
    // Both racers list before either creates -> both see nothing. Post-create both see both rows.
    listOpenIssuesByLabel
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue([row(2416), row(2417)]);
    createInternalLinearIssue
      .mockResolvedValueOnce({ id: 'uuid-2416', identifier: 'ENG-2416', url: 'u/2416' })
      .mockResolvedValueOnce({ id: 'uuid-2417', identifier: 'ENG-2417', url: 'u/2417' });

    const [a, b] = await Promise.all([fileAutoIssue(params), fileAutoIssue(params)]);

    expect(a.pageId).toBe('ENG-2416');
    expect(b.pageId).toBe('ENG-2416');
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(markIssueDuplicateOf).toHaveBeenCalledTimes(1);
    expect(markIssueDuplicateOf).toHaveBeenCalledWith('uuid-2417', 'uuid-2416');
    expect(addIssueComment).toHaveBeenCalledWith('uuid-2417', expect.stringContaining('Duplicate of ENG-2416'));
    expect(addIssueComment).toHaveBeenCalledWith('uuid-2416', expect.stringContaining('Recurred on'));
  });

  it('a non-racing create is unchanged: no duplicate mark, no extra comments', async () => {
    listOpenIssuesByLabel.mockResolvedValueOnce([]).mockResolvedValue([row(2500)]);
    createInternalLinearIssue.mockResolvedValue({ id: 'uuid-2500', identifier: 'ENG-2500', url: 'u/2500' });

    const r = await fileAutoIssue(params);

    expect(r).toEqual({ pageId: 'ENG-2500', url: 'u/2500', deduped: false, tracker: 'Linear' });
    expect(markIssueDuplicateOf).not.toHaveBeenCalled();
    expect(addIssueComment).not.toHaveBeenCalled();
  });

  it('does not fold into an unrelated open Auto issue', async () => {
    const other = { identifier: 'ENG-100', issueId: 'uuid-100', title: 'Something else', description: 'Alert Class: v0-credits' };
    listOpenIssuesByLabel.mockResolvedValueOnce([other]).mockResolvedValue([other, row(2501)]);
    createInternalLinearIssue.mockResolvedValue({ id: 'uuid-2501', identifier: 'ENG-2501', url: 'u/2501' });

    const r = await fileAutoIssue(params);

    expect(r.pageId).toBe('ENG-2501');
    expect(markIssueDuplicateOf).not.toHaveBeenCalled();
  });

  it('reconciliation failure is swallowed and the created issue is returned as before', async () => {
    listOpenIssuesByLabel.mockResolvedValueOnce([]).mockRejectedValue(new Error('linear down'));
    createInternalLinearIssue.mockResolvedValue({ id: 'uuid-2502', identifier: 'ENG-2502', url: 'u/2502' });

    const r = await fileAutoIssue(params);

    expect(r).toEqual({ pageId: 'ENG-2502', url: 'u/2502', deduped: false, tracker: 'Linear' });
  });
});
