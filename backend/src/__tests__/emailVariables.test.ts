import { substituteVariables, extractVariables, leadHasVariable, injectUnsubscribeUrl, hasUnsafeEmailStyles, inlineEmailStyles, rewriteS3ImageUrls, normalizeYoutubeUrls, checkEmailFormat } from '../utils/emailVariables';
import { LLMService } from '../utils/llmService';

jest.mock('../utils/llmService');
const MockLLMService = LLMService as jest.MockedClass<typeof LLMService>;

describe('substituteVariables', () => {
  // FAIL cases
  it('should return template unchanged when no variables present', () => {
    const template = '<p>Hello world</p>';
    const lead = { firstName: 'John', lastName: 'Doe', email: 'john@test.com' };
    expect(substituteVariables(template, lead)).toBe('<p>Hello world</p>');
  });

  it('should leave unknown variables as-is', () => {
    const template = 'Hello {{unknownField}}';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('Hello {{unknownField}}');
  });

  it('should handle empty template', () => {
    const template = '';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('');
  });

  it('should handle lead with missing fields gracefully', () => {
    const template = 'Hello {{firstName}} {{lastName}} at {{company}}';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('Hello John  at ');
  });

  // SUCCESS cases
  it('should substitute all standard lead fields', () => {
    const template = '{{firstName}} {{lastName}} ({{email}}) - {{company}}, {{title}}';
    const lead = {
      firstName: 'Jane',
      lastName: 'Smith',
      email: 'jane@acme.com',
      company: 'Acme Corp',
      title: 'VP of Engineering',
    };
    expect(substituteVariables(template, lead)).toBe(
      'Jane Smith (jane@acme.com) - Acme Corp, VP of Engineering'
    );
  });

  it('should substitute custom fields', () => {
    const template = 'Your plan: {{customFields.plan}}, region: {{customFields.region}}';
    const lead = {
      customFields: { plan: 'Enterprise', region: 'US-West' },
    };
    expect(substituteVariables(template, lead)).toBe(
      'Your plan: Enterprise, region: US-West'
    );
  });

  it('should handle missing custom field gracefully', () => {
    const template = 'Plan: {{customFields.missing}}';
    const lead = { customFields: { other: 'value' } };
    expect(substituteVariables(template, lead)).toBe('Plan: ');
  });

  it('should handle lead with no customFields object', () => {
    const template = 'Plan: {{customFields.plan}}';
    const lead = { firstName: 'John' };
    expect(substituteVariables(template, lead)).toBe('Plan: ');
  });

  it('should substitute multiple occurrences of the same variable', () => {
    const template = '{{firstName}} - Dear {{firstName}}';
    const lead = { firstName: 'Alice' };
    expect(substituteVariables(template, lead)).toBe('Alice - Dear Alice');
  });
});

describe('extractVariables', () => {
  it('should extract standard and custom field variables', () => {
    const template = 'Hi {{firstName}}, your company {{company}} plan: {{customFields.plan}}';
    expect(extractVariables(template)).toEqual(['firstName', 'company', 'customFields.plan']);
  });

  it('should ignore {{unsubscribeUrl}}', () => {
    const template = '{{firstName}} <a href="{{unsubscribeUrl}}">unsub</a>';
    expect(extractVariables(template)).toEqual(['firstName']);
  });

  it('should deduplicate repeated variables', () => {
    const template = '{{firstName}} and again {{firstName}}';
    expect(extractVariables(template)).toEqual(['firstName']);
  });

  it('should return empty array for empty template', () => {
    expect(extractVariables('')).toEqual([]);
  });
});

describe('leadHasVariable', () => {
  it('should return true for present standard field', () => {
    expect(leadHasVariable({ firstName: 'John' }, 'firstName')).toBe(true);
  });

  it('should return false for missing standard field', () => {
    expect(leadHasVariable({}, 'firstName')).toBe(false);
  });

  it('should return false for empty string value', () => {
    expect(leadHasVariable({ firstName: '' }, 'firstName')).toBe(false);
  });

  it('should return true for present custom field', () => {
    expect(leadHasVariable({ customFields: { plan: 'Pro' } }, 'customFields.plan')).toBe(true);
  });

  it('should return false for missing custom field', () => {
    expect(leadHasVariable({ customFields: {} }, 'customFields.plan')).toBe(false);
  });

  it('should return false when customFields object is missing', () => {
    expect(leadHasVariable({}, 'customFields.plan')).toBe(false);
  });
});

describe('injectUnsubscribeUrl', () => {
  const url = 'https://example.com/unsubscribe?id=123';

  // FAIL cases (edge inputs)
  it('should return empty string unchanged', () => {
    expect(injectUnsubscribeUrl('', url)).toBe('');
  });

  it('should handle html with no body tag and no unsubscribe anchor by appending footer at end', () => {
    const html = '<p>Hello</p>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(url);
    expect(result).toContain('Unsubscribe');
  });

  // Step 1: {{unsubscribeUrl}} replacement
  it('should replace {{unsubscribeUrl}} variable in place', () => {
    const html = '<a href="{{unsubscribeUrl}}">Unsubscribe</a>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toBe(`<a href="${url}">Unsubscribe</a>`);
  });

  it('should replace multiple {{unsubscribeUrl}} occurrences', () => {
    const html = '{{unsubscribeUrl}} and again {{unsubscribeUrl}}';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toBe(`${url} and again ${url}`);
  });

  // Step 2: update existing unsubscribe anchor href
  it('should update existing unsubscribe anchor href="#" to real URL', () => {
    const html = '<body><a href="#">Unsubscribe</a></body>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(`href="${url}"`);
    expect(result).not.toContain('href="#"');
  });

  it('should update unsubscribe anchor in full HTML document preserving structure', () => {
    const html = '<!DOCTYPE html><html><head><style>body{color:red}</style></head><body><a href="#">Unsubscribe</a></body></html>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(`href="${url}"`);
    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('body{color:red}');
  });

  it('should not cross tag boundaries when matching unsubscribe anchor', () => {
    // Two separate anchors: first one has no "unsubscribe" text, second does
    const html = '<body><a href="https://other.com">Visit us</a><a href="#">Unsubscribe</a></body>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain('href="https://other.com"'); // other link unchanged
    expect(result).toContain(`href="${url}"`);
  });

  it('should add href if unsubscribe anchor has none', () => {
    const html = '<body><a>Unsubscribe</a></body>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(`href="${url}"`);
  });

  // Step 3: no unsubscribe found — append default footer
  it('should append default footer before </body> when no unsubscribe exists', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const result = injectUnsubscribeUrl(html, url);
    expect(result).toContain(url);
    expect(result).toContain('Unsubscribe');
    expect(result.indexOf(url)).toBeLessThan(result.indexOf('</body>'));
  });

  it('should use fallbackFooterHtml when provided and no unsubscribe exists', () => {
    const html = '<html><body><p>Content</p></body></html>';
    const footer = `<div><a href="{{unsubscribeUrl}}">Click to unsubscribe</a></div>`;
    const result = injectUnsubscribeUrl(html, url, footer);
    expect(result).toContain(`href="${url}"`);
    expect(result).toContain('Click to unsubscribe');
  });
});

describe('hasUnsafeEmailStyles', () => {
  it('should return false for empty string', () => {
    expect(hasUnsafeEmailStyles('')).toBe(false);
  });

  it('should return false for HTML with no <style> block', () => {
    expect(hasUnsafeEmailStyles('<p style="color:red">Hello</p>')).toBe(false);
  });

  it('should return false for <style> block with only element selectors', () => {
    const html = '<html><head><style>body { color: red; } p { margin: 0; }</style></head></html>';
    expect(hasUnsafeEmailStyles(html)).toBe(false);
  });

  it('should return true for <style> block with class-based rules', () => {
    const html = '<html><head><style>.header { background: purple; }</style></head></html>';
    expect(hasUnsafeEmailStyles(html)).toBe(true);
  });

  it('should return true for HTML with multiple <style> blocks where one has classes', () => {
    const html = '<head><style>body{}</style><style>.btn { color: white; }</style></head>';
    expect(hasUnsafeEmailStyles(html)).toBe(true);
  });

  it('should return false for class rules only inside @media blocks (responsive + dark mode)', () => {
    const html = '<html><head><style>@media only screen and (max-width:480px){.wrapper{width:100%!important;}} @media (prefers-color-scheme:dark){.dm-card{background:#000!important;}}</style></head></html>';
    expect(hasUnsafeEmailStyles(html)).toBe(false);
  });

  it('should return true when class rules exist both inside and outside @media', () => {
    const html = '<html><head><style>.header{background:purple;} @media(max-width:480px){.wrapper{width:100%;}}</style></head></html>';
    expect(hasUnsafeEmailStyles(html)).toBe(true);
  });
});

describe('rewriteS3ImageUrls', () => {
  const S3_URL = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/abc/files/123/logo.png';
  const BACKEND = 'https://api.agentweb.pro';

  it('should return empty string unchanged', () => {
    expect(rewriteS3ImageUrls('', BACKEND)).toBe('');
  });

  it('should not modify HTML with no img tags', () => {
    const html = '<p>Hello world</p>';
    expect(rewriteS3ImageUrls(html, BACKEND)).toBe(html);
  });

  it('should not modify img src pointing to non-S3 domain', () => {
    const html = '<img src="https://cdn.example.com/logo.png" alt="Logo">';
    expect(rewriteS3ImageUrls(html, BACKEND)).toBe(html);
  });

  it('should rewrite S3 img src to backend /asset/ proxy URL', () => {
    const html = `<img src="${S3_URL}" alt="Logo">`;
    const result = rewriteS3ImageUrls(html, BACKEND);
    expect(result).toMatch(/src="https:\/\/api\.agentweb\.pro\/asset\/[A-Za-z0-9_-]+"/);
    expect(result).not.toContain('s3.us-west-2.amazonaws.com');
  });

  it('should produce a proxy URL that round-trips back to the original S3 URL', () => {
    const html = `<img src="${S3_URL}" alt="Logo">`;
    const result = rewriteS3ImageUrls(html, BACKEND);
    const match = result.match(/src="https:\/\/api\.agentweb\.pro\/asset\/([A-Za-z0-9_-]+)"/);
    expect(match).toBeTruthy();
    const hash = match![1];
    const base64 = hash.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = Buffer.from(base64, 'base64').toString('utf-8');
    expect(decoded).toBe(S3_URL);
  });

  it('should rewrite multiple S3 img tags independently', () => {
    const url2 = 'https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/abc/files/456/icon.png';
    const html = `<img src="${S3_URL}"><img src="${url2}">`;
    const result = rewriteS3ImageUrls(html, BACKEND);
    const matches = result.match(/\/asset\/[A-Za-z0-9_-]+/g);
    expect(matches).toHaveLength(2);
    expect(matches![0]).not.toBe(matches![1]);
  });

  it('should preserve all other img attributes', () => {
    const html = `<img class="logo" alt="AgentWeb" width="200" src="${S3_URL}" height="50">`;
    const result = rewriteS3ImageUrls(html, BACKEND);
    expect(result).toContain('class="logo"');
    expect(result).toContain('alt="AgentWeb"');
    expect(result).toContain('width="200"');
    expect(result).toContain('height="50"');
  });

  it('should strip trailing slash from baseUrl', () => {
    const html = `<img src="${S3_URL}">`;
    const result = rewriteS3ImageUrls(html, 'https://api.agentweb.pro/');
    expect(result).toMatch(/src="https:\/\/api\.agentweb\.pro\/asset\//);
    expect(result).not.toMatch(/\/\/asset\//);
  });
});

describe('normalizeYoutubeUrls', () => {
  // FAIL cases — inputs that should not be transformed
  it('should return empty string unchanged', () => {
    expect(normalizeYoutubeUrls('')).toBe('');
  });

  it('should not modify HTML with no YouTube URLs', () => {
    const html = '<p>Check out <a href="https://example.com">this site</a></p>';
    expect(normalizeYoutubeUrls(html)).toBe(html);
  });

  it('should not modify full youtube.com/watch URLs', () => {
    const html = '<a href="https://www.youtube.com/watch?v=gtTodHxuEp8">Watch</a>';
    expect(normalizeYoutubeUrls(html)).toBe(html);
  });

  it('should not modify other youtube.com URLs (channel, playlist, etc.)', () => {
    const html = '<a href="https://www.youtube.com/channel/UC123">Channel</a>';
    expect(normalizeYoutubeUrls(html)).toBe(html);
  });

  // SUCCESS cases — youtu.be short URLs should be expanded
  it('should convert a plain youtu.be href to full youtube.com/watch URL', () => {
    const html = '<a href="https://youtu.be/gtTodHxuEp8">Watch</a>';
    const result = normalizeYoutubeUrls(html);
    expect(result).toBe('<a href="https://www.youtube.com/watch?v=gtTodHxuEp8">Watch</a>');
  });

  it('should preserve the si= query parameter as additional param', () => {
    const html = '<a href="https://youtu.be/gtTodHxuEp8?si=3ugFPHb5pXxylgps">Watch</a>';
    const result = normalizeYoutubeUrls(html);
    expect(result).toContain('https://www.youtube.com/watch?v=gtTodHxuEp8');
    expect(result).toContain('si=3ugFPHb5pXxylgps');
  });

  it('should convert youtu.be URLs appearing as plain text (not in href)', () => {
    const html = '<p>Watch: https://youtu.be/abc123XYZ</p>';
    const result = normalizeYoutubeUrls(html);
    expect(result).toContain('https://www.youtube.com/watch?v=abc123XYZ');
    expect(result).not.toContain('youtu.be');
  });

  it('should convert multiple youtu.be URLs in one HTML string', () => {
    const html = '<a href="https://youtu.be/vid1abc">One</a> and <a href="https://youtu.be/vid2def">Two</a>';
    const result = normalizeYoutubeUrls(html);
    expect(result).toContain('https://www.youtube.com/watch?v=vid1abc');
    expect(result).toContain('https://www.youtube.com/watch?v=vid2def');
    expect(result).not.toContain('youtu.be');
  });

  it('should handle http:// youtu.be links', () => {
    const html = '<a href="http://youtu.be/testId123">Watch</a>';
    const result = normalizeYoutubeUrls(html);
    expect(result).toContain('https://www.youtube.com/watch?v=testId123');
    expect(result).not.toContain('youtu.be');
  });
});

describe('checkEmailFormat', () => {
  it('should return empty array for empty string', () => {
    expect(checkEmailFormat('')).toEqual([]);
  });

  it('should warn about class-based CSS (error severity)', () => {
    const html = '<html><head><style>.btn { color: white; }</style></head><body></body></html>';
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('class-based-css');
    const csWarn = warnings.find((w) => w.code === 'class-based-css');
    expect(csWarn?.severity).toBe('error');
  });

  it('should warn no-dark-mode when @media prefers-color-scheme: dark is absent', () => {
    const html = '<html><body><p style="color:#111">Hello</p></body></html>';
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('no-dark-mode');
  });

  it('should NOT warn no-dark-mode when @media prefers-color-scheme: dark is present', () => {
    const html = `<html><head><style>@media (prefers-color-scheme: dark) { body { background: #000; } }</style></head><body></body></html>`;
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).not.toContain('no-dark-mode');
    expect(codes).not.toContain('dark-mode-contrast');
  });

  it('should NOT warn no-dark-mode when color-scheme opt-out meta tag is present', () => {
    const html = `<html><head><meta name="color-scheme" content="light"></head><body><div style="background-color:#fff"><p style="color:#000">Text</p></div></body></html>`;
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).not.toContain('no-dark-mode');
    expect(codes).not.toContain('dark-mode-contrast');
  });

  it('should NOT warn no-dark-mode when color-scheme meta has light only supported-color-schemes', () => {
    const html = `<html><head><meta name="color-scheme" content="light only"></head><body></body></html>`;
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).not.toContain('no-dark-mode');
  });

  it('should warn dark-mode-contrast when dark text on light bg without dark mode query', () => {
    const html = '<html><body><div style="background-color:#ffffff"><p style="color:#111111">Text</p></div></body></html>';
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('dark-mode-contrast');
    const cw = warnings.find((w) => w.code === 'dark-mode-contrast');
    expect(cw?.severity).toBe('warning');
  });

  it('should NOT warn dark-mode-contrast when dark mode query is present even with dark text on light bg', () => {
    const html = `<html><head><style>@media (prefers-color-scheme: dark) { body { background: #000; } }</style></head><body><div style="background-color:#fff"><p style="color:#000">Text</p></div></body></html>`;
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).not.toContain('dark-mode-contrast');
  });

  it('should NOT warn dark-mode-contrast when color-scheme opt-out is present', () => {
    const html = `<html><head><meta name="color-scheme" content="light"></head><body><div style="background-color:#fff"><p style="color:#000">Text</p></div></body></html>`;
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).not.toContain('dark-mode-contrast');
  });

  it('should return only no-dark-mode warning for a plain HTML email with no inline style colors', () => {
    const html = '<html><body><p>Hello world</p></body></html>';
    const warnings = checkEmailFormat(html);
    const codes = warnings.map((w) => w.code);
    expect(codes).toContain('no-dark-mode');
    expect(codes).not.toContain('class-based-css');
    expect(codes).not.toContain('dark-mode-contrast');
  });
});

describe('inlineEmailStyles', () => {
  const htmlWithClasses = '<html><head><style>.btn { color: white; background: purple; }</style></head><body><a class="btn" href="#">Click</a></body></html>';
  const inlinedHtml = '<html><head></head><body><a href="#" style="color: white; background: purple;">Click</a></body></html>';

  beforeEach(() => {
    MockLLMService.mockClear();
  });

  it('should return original html unchanged when no unsafe styles detected', async () => {
    const html = '<html><body><p style="color:red">Hello</p></body></html>';
    const result = await inlineEmailStyles(html);
    expect(result.html).toBe(html);
    expect(result.wasFixed).toBe(false);
    expect(MockLLMService).not.toHaveBeenCalled();
  });

  it('should call LLM and return inlined html when class-based styles detected', async () => {
    MockLLMService.prototype.generateHTML = jest.fn().mockResolvedValue(inlinedHtml);
    const result = await inlineEmailStyles(htmlWithClasses);
    expect(result.wasFixed).toBe(true);
    expect(result.html).toBe(inlinedHtml);
    expect(MockLLMService.prototype.generateHTML).toHaveBeenCalledTimes(1);
  });

  it('should return original html if LLM returns suspiciously short output', async () => {
    MockLLMService.prototype.generateHTML = jest.fn().mockResolvedValue('<p>x</p>');
    const result = await inlineEmailStyles(htmlWithClasses);
    expect(result.wasFixed).toBe(false);
    expect(result.html).toBe(htmlWithClasses);
  });

  it('should return original html if LLM call throws', async () => {
    MockLLMService.prototype.generateHTML = jest.fn().mockRejectedValue(new Error('LLM timeout'));
    const result = await inlineEmailStyles(htmlWithClasses);
    expect(result.wasFixed).toBe(false);
    expect(result.html).toBe(htmlWithClasses);
  });
});
