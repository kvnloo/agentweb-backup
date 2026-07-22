/**
 * Tests for downloadSlackFile in slackService.
 *
 * Regression for ENG-323: an attached SVG logo never reached the agent because
 * the HTML-detection guard rejected any content starting with "<!". Valid SVG/XML
 * files legitimately begin with "<!DOCTYPE svg ..." or "<!-- ... -->", so they were
 * discarded as if they were Slack's HTML sign-in page, leaving the attachment empty
 * and the agent with only the "[attached file]" placeholder.
 */

const mockAxiosGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: mockAxiosGet },
}));

jest.mock('@slack/web-api', () => ({
  WebClient: jest.fn().mockImplementation(() => ({
    users: { info: jest.fn() },
  })),
}));

describe('downloadSlackFile', () => {
  let downloadSlackFile: (urlPrivate: string) => Promise<Buffer>;

  const respondWith = (content: string | Buffer) => {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    // Node Buffer is a Uint8Array; axios returns an ArrayBuffer for responseType 'arraybuffer'.
    mockAxiosGet.mockResolvedValue({ data: buf });
  };

  beforeEach(() => {
    mockAxiosGet.mockReset();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    downloadSlackFile = require('../services/slackService').downloadSlackFile;
  });

  it('returns the bytes for an SVG that starts with <!DOCTYPE svg (must not be treated as HTML)', async () => {
    const svg =
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
      '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    respondWith(svg);

    const buffer = await downloadSlackFile('https://files.slack.com/numix-logo.svg');
    expect(buffer.toString('utf8')).toBe(svg);
  });

  it('returns the bytes for an SVG that starts with an XML comment', async () => {
    const svg = '<!-- Generator: Adobe Illustrator -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    respondWith(svg);

    const buffer = await downloadSlackFile('https://files.slack.com/logo.svg');
    expect(buffer.toString('utf8')).toBe(svg);
  });

  it('returns the bytes for an SVG that starts with an XML declaration', async () => {
    const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    respondWith(svg);

    const buffer = await downloadSlackFile('https://files.slack.com/logo.svg');
    expect(buffer.toString('utf8')).toBe(svg);
  });

  it('returns raw binary bytes for a PNG (no false HTML positive)', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    respondWith(png);

    const buffer = await downloadSlackFile('https://files.slack.com/logo.png');
    expect(Buffer.compare(buffer, png)).toBe(0);
  });

  it('throws when Slack serves its HTML sign-in/error page (<!DOCTYPE html>)', async () => {
    respondWith('<!DOCTYPE html>\n<html><head><title>Sign in</title></head></html>');
    await expect(downloadSlackFile('https://files.slack.com/private/xyz')).rejects.toThrow(
      /returned HTML/,
    );
  });

  it('throws when Slack serves an HTML page without a doctype (<html>)', async () => {
    respondWith('<html lang="en"><body>Please sign in</body></html>');
    await expect(downloadSlackFile('https://files.slack.com/private/xyz')).rejects.toThrow(
      /returned HTML/,
    );
  });

  it('throws when SLACK_BOT_TOKEN is not set', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    await expect(downloadSlackFile('https://files.slack.com/logo.svg')).rejects.toThrow(
      /SLACK_BOT_TOKEN not set/,
    );
  });
});
