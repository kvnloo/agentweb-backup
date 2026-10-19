import {
  CONNECTING_COPY,
  LEAD_UNREACHABLE_COPY,
  NO_INPUT_COPY,
  connectTwiml,
  escapeXml,
  hangupTwiml,
  leadUnreachableTwiml,
  ownerPromptTwiml,
} from '../twiml';

// No XML parser is a direct dependency of the backend, so this is a small strict checker for the subset
// the builders emit: declaration, properly nested elements, double-quoted attributes, and text/attribute
// values with no raw '<' and no '&' that does not start one of the five predefined entities.
interface El { name: string; attrs: Record<string, string>; text: string; children: El[] }
function parseXml(xml: string): El {
  const decl = '<?xml version="1.0" encoding="UTF-8"?>';
  if (!xml.startsWith(decl)) throw new Error('missing declaration');
  const body = xml.slice(decl.length);
  const unescape = (v: string): string => {
    if (/&(?!(amp|lt|gt|quot|apos);)/.test(v)) throw new Error(`bad entity in ${v}`);
    if (/</.test(v)) throw new Error(`raw < in ${v}`);
    return v.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  const root: El = { name: '#root', attrs: {}, text: '', children: [] };
  const stack: El[] = [root];
  const tokens = body.match(/<[^>]*>|[^<]+/g) ?? [];
  if (tokens.join('') !== body) throw new Error('unparsed content');
  for (const t of tokens) {
    const top = stack[stack.length - 1];
    if (!t.startsWith('<')) { top.text += unescape(t); continue; }
    if (t.startsWith('</')) {
      if (top.name !== t.slice(2, -1)) throw new Error(`mismatched close ${t}`);
      stack.pop();
      continue;
    }
    const m = /^<([A-Za-z]+)((?:\s+[A-Za-z]+="[^"<]*")*)\s*(\/?)>$/.exec(t);
    if (!m) throw new Error(`bad tag ${t}`);
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([A-Za-z]+)="([^"]*)"/g)) attrs[a[1]] = unescape(a[2]);
    const el: El = { name: m[1], attrs, text: '', children: [] };
    top.children.push(el);
    if (!m[3]) stack.push(el);
  }
  if (stack.length !== 1) throw new Error('unclosed element');
  return root.children[0];
}

const URLS = {
  gatherUrl: 'https://api.example.test/api/webhooks/twilio-voice/gather?listId=l1&leadId=ld1&jobKey=j1',
  dialUrl: 'https://api.example.test/api/webhooks/twilio-voice/dial?listId=l1&leadId=ld1&jobKey=j1',
  statusUrl: 'https://api.example.test/api/webhooks/twilio-voice/status?listId=l1&leadId=ld1&jobKey=j1&leg=lead',
};
const NASTY = `Smith & Sons <"O'Brien"> ]]> &amp;`;

describe('twiml builders', () => {
  it('builds the owner prompt: Gather with the prompt inside, then the no-input fallthrough and a hangup', () => {
    const xml = ownerPromptTwiml({ announcedName: 'Acme Plumbing', gatherUrl: URLS.gatherUrl });
    const root = parseXml(xml);
    expect(root.name).toBe('Response');
    expect(root.children.map((c) => c.name)).toEqual(['Gather', 'Say', 'Hangup']);
    const gather = root.children[0];
    expect(gather.attrs).toEqual({ input: 'dtmf', numDigits: '1', timeout: '8', action: URLS.gatherUrl, method: 'POST' });
    expect(gather.children[0].text).toBe('New lead from Acme Plumbing. Press 1 to connect to them now.');
    expect(root.children[1].text).toBe(NO_INPUT_COPY);
  });

  it('escapes the announced name: "Smith & Sons" stays well-formed and reads back unchanged', () => {
    const xml = ownerPromptTwiml({ announcedName: 'Smith & Sons', gatherUrl: URLS.gatherUrl });
    expect(xml).toContain('New lead from Smith &amp; Sons. Press 1');
    expect(parseXml(xml).children[0].children[0].text).toBe('New lead from Smith & Sons. Press 1 to connect to them now.');
  });

  it('survives quotes, angle brackets and entity look-alikes in the name even though the validator forbids them', () => {
    const xml = ownerPromptTwiml({ announcedName: NASTY, gatherUrl: URLS.gatherUrl });
    expect(parseXml(xml).children[0].children[0].text).toBe(`New lead from ${NASTY}. Press 1 to connect to them now.`);
    expect(xml.match(/<Say>/g)).toHaveLength(2);
  });

  it('escapes attribute values (URLs carry & between query parameters)', () => {
    const xml = ownerPromptTwiml({ announcedName: 'A', gatherUrl: 'https://x.test/g?a=1&b="2"<' });
    expect(xml).toContain('action="https://x.test/g?a=1&amp;b=&quot;2&quot;&lt;"');
    expect(parseXml(xml).children[0].attrs.action).toBe('https://x.test/g?a=1&b="2"<');
  });

  it('drops characters XML 1.0 cannot carry instead of emitting a document Twilio would reject', () => {
    const xml = ownerPromptTwiml({ announcedName: 'Ac\u0000me\u0008', gatherUrl: URLS.gatherUrl });
    expect(parseXml(xml).children[0].children[0].text).toContain('Acme.');
  });

  it('builds the connect response: Say, then Dial with callerId/timeout/action and one Number carrying the status callback', () => {
    const xml = connectTwiml({ twilioNumber: '+15555550111', leadE164: '+15555550123', ...URLS });
    const root = parseXml(xml);
    expect(root.children.map((c) => c.name)).toEqual(['Say', 'Dial']);
    expect(root.children[0].text).toBe(CONNECTING_COPY);
    const dial = root.children[1];
    expect(dial.attrs).toEqual({ callerId: '+15555550111', timeout: '25', action: URLS.dialUrl, method: 'POST' });
    expect(dial.children).toHaveLength(1);
    const number = dial.children[0];
    expect(number.name).toBe('Number');
    expect(number.text).toBe('+15555550123');
    expect(number.attrs).toEqual({
      statusCallback: URLS.statusUrl,
      statusCallbackEvent: 'initiated ringing answered completed',
      statusCallbackMethod: 'POST',
    });
  });

  it('refuses to put anything but an E.164 number into the Dial', () => {
    expect(() => connectTwiml({ twilioNumber: '+15555550111', leadE164: '5555550123</Number><Hangup/>', ...URLS })).toThrow();
    expect(() => connectTwiml({ twilioNumber: 'client:x', leadE164: '+15555550123', ...URLS })).toThrow();
  });

  it('builds the lead-unreachable apology and the bare hangup', () => {
    const apology = parseXml(leadUnreachableTwiml());
    expect(apology.children.map((c) => c.name)).toEqual(['Say', 'Hangup']);
    expect(apology.children[0].text).toBe(LEAD_UNREACHABLE_COPY);
    expect(hangupTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  it('escapeXml output never contains a raw special character, for any input (property check)', () => {
    const alphabet = ['&', '<', '>', '"', "'", 'a', ';', '\u0001', 'amp', '&amp;'];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    for (let n = 0; n < 300; n++) {
      const s = Array.from({ length: 1 + (next() % 12) }, () => alphabet[next() % alphabet.length]).join('');
      const out = escapeXml(s);
      expect(out).not.toMatch(/[<>"']/);
      expect(out).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    }
  });
});
