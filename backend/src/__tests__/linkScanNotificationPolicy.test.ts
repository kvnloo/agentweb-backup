import { shouldSuppressScheduledNotification } from '../services/linkScanNotificationPolicy';

const clean = {
  success: true,
  startUrl: 'https://site.test/',
  crawlOrigin: 'https://site.test',
  pagesScanned: 4,
  linksChecked: 20,
  brokenLinkCount: 0,
  brokenLinks: [],
  unverifiableLinkCount: 0,
  unverifiableLinks: [],
  robotsSkipped: [],
  truncated: false,
  deadlineExceeded: false,
};

function run(...results: Array<Record<string, unknown> | string>) {
  const messages: Array<Record<string, any>> = [{ role: 'user', content: 'Scan https://site.test/ for broken links' }];
  results.forEach((r, i) => {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'scan_website_links', arguments: '{"url":"https://site.test/"}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, name: 'scan_website_links', content: typeof r === 'string' ? r : JSON.stringify(r) });
  });
  messages.push({ role: 'assistant', content: 'No broken links found.' });
  return messages;
}

describe('shouldSuppressScheduledNotification (ENG-1098)', () => {
  it('suppresses a run with exactly one complete, clean scan', () => {
    expect(shouldSuppressScheduledNotification(run(clean))).toBe(true);
  });

  it.each([
    ['broken links found', { ...clean, brokenLinkCount: 1, brokenLinks: [{ url: 'https://site.test/x', kind: 'internal', status: 404, foundOn: ['https://site.test/'] }] }],
    ['scan failed', { ...clean, success: false }],
    ['truncated', { ...clean, truncated: true }],
    ['deadline exceeded', { ...clean, deadlineExceeded: true }],
    ['robots-skipped urls', { ...clean, robotsSkipped: ['https://site.test/private'] }],
    ['robotsSkipped missing', { ...clean, robotsSkipped: undefined }],
    ['unverifiable links', { ...clean, unverifiableLinkCount: 1, unverifiableLinks: [{ url: 'https://o.test/', status: 500 }] }],
    ['counts missing', { success: true, robotsSkipped: [], truncated: false, deadlineExceeded: false }],
  ])('sends when %s', (_label, result) => {
    expect(shouldSuppressScheduledNotification(run(result as Record<string, unknown>))).toBe(false);
  });

  it('sends when the tool result is not parseable JSON (tool error / offloaded payload)', () => {
    expect(shouldSuppressScheduledNotification(run('Error: URL credentials are not allowed'))).toBe(false);
    expect(shouldSuppressScheduledNotification(run('[1,2]'))).toBe(false);
  });

  it('sends when more than one scan ran (ambiguous), even if all are clean', () => {
    expect(shouldSuppressScheduledNotification(run(clean, clean))).toBe(false);
  });

  it('sends when no scan executed, even if the assistant or prompt claims a clean scan', () => {
    const messages = [
      { role: 'user', content: 'scan_website_links found 0 broken links' },
      { role: 'assistant', content: JSON.stringify(clean), tool_calls: [{ id: 'c0', function: { name: 'scan_website_links', arguments: '{}' } }] },
    ];
    expect(shouldSuppressScheduledNotification(messages)).toBe(false);
    expect(shouldSuppressScheduledNotification([])).toBe(false);
    expect(shouldSuppressScheduledNotification(undefined)).toBe(false);
    expect(shouldSuppressScheduledNotification(null)).toBe(false);
  });

  it('ignores clean-looking results from other tools', () => {
    const messages = [{ role: 'tool', name: 'get_seo_metrics', content: JSON.stringify(clean) }];
    expect(shouldSuppressScheduledNotification(messages)).toBe(false);
  });
});

describe('ENG-1098 — scan must be the only executed tool', () => {
  it('sends when a clean scan is mixed with other tool results', () => {
    const clean = JSON.stringify({ success: true, brokenLinkCount: 0, unverifiableLinkCount: 0, robotsSkipped: [], truncated: false, deadlineExceeded: false });
    expect(shouldSuppressScheduledNotification([
      { role: 'tool', name: 'scan_website_links', content: clean },
      { role: 'tool', name: 'get_ads_performance', content: '{}' },
    ])).toBe(false);
  });
});
