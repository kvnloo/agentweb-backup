/**
 * Tests for resolveSlackFileUrl in slackService.
 *
 * Regression for ENG-323 (real root cause): in a Slack Connect / externally-shared
 * channel, the file_share event omits `url_private` and instead sends a stub with
 * `file_access: 'check_file_info'`. The app must call files.info to hydrate the stub
 * before it can download the bytes. Previously the stub's undefined `url_private` was
 * passed straight to downloadSlackFile → axios threw `TypeError: Invalid URL`, the
 * attachment was silently dropped, and the agent received only the "[attached file]"
 * placeholder (yielding "Invalid URL format. Must be HTTP or HTTPS." from
 * read_file_content).
 */

const mockFilesInfo = jest.fn();

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    files: { info: mockFilesInfo },
    users: { info: jest.fn() },
  })),
}));

describe('resolveSlackFileUrl', () => {
  let resolveSlackFileUrl: (file: {
    id?: string;
    url_private?: string;
    url_private_download?: string;
    file_access?: string;
  }) => Promise<string>;

  beforeAll(() => {
    // slackClient is constructed at import time from SLACK_BOT_TOKEN.
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    resolveSlackFileUrl = require('../services/slackService').resolveSlackFileUrl;
  });

  beforeEach(() => {
    mockFilesInfo.mockReset();
  });

  it('returns url_private directly and does NOT call files.info when the file is already hydrated', async () => {
    const url = await resolveSlackFileUrl({
      id: 'F123',
      url_private: 'https://files.slack.com/private/F123',
    });
    expect(url).toBe('https://files.slack.com/private/F123');
    expect(mockFilesInfo).not.toHaveBeenCalled();
  });

  it('hydrates a Slack Connect stub (file_access: check_file_info) via files.info', async () => {
    mockFilesInfo.mockResolvedValue({
      ok: true,
      file: {
        id: 'F0BH7RZ6VM4',
        url_private_download: 'https://files.slack.com/dl/F0BH7RZ6VM4',
        url_private: 'https://files.slack.com/private/F0BH7RZ6VM4',
      },
    });

    const url = await resolveSlackFileUrl({
      id: 'F0BH7RZ6VM4',
      file_access: 'check_file_info',
      // url_private absent — exactly what an ext-shared channel sends
    });

    expect(mockFilesInfo).toHaveBeenCalledWith({ file: 'F0BH7RZ6VM4' });
    // Prefer the download URL when present.
    expect(url).toBe('https://files.slack.com/dl/F0BH7RZ6VM4');
  });

  it('falls back to url_private from files.info when url_private_download is absent', async () => {
    mockFilesInfo.mockResolvedValue({
      ok: true,
      file: { id: 'F999', url_private: 'https://files.slack.com/private/F999' },
    });

    const url = await resolveSlackFileUrl({ id: 'F999' });
    expect(url).toBe('https://files.slack.com/private/F999');
  });

  it('throws when the stub has neither a url_private nor an id to hydrate', async () => {
    await expect(resolveSlackFileUrl({ file_access: 'check_file_info' })).rejects.toThrow(
      /no id or url_private/i,
    );
    expect(mockFilesInfo).not.toHaveBeenCalled();
  });

  it('throws when files.info returns no usable URL', async () => {
    mockFilesInfo.mockResolvedValue({ ok: true, file: { id: 'F555' } });
    await expect(resolveSlackFileUrl({ id: 'F555' })).rejects.toThrow(/no url_private/i);
  });
});
