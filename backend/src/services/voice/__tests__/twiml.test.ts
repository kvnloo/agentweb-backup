import {
  CONNECTING_COPY,
  LEAD_UNREACHABLE_COPY,
  NO_INPUT_COPY,
  LEAD_DECLINED_COPY,
  LEAD_PHONE_CHANGED_COPY,
  SCREEN_NO_INPUT_COPY,
  bridgeTwiml,
  connectTwiml,
  escapeXml,
  hangupTwiml,
  INBOUND_NOBODY_COPY,
  INBOUND_UNAVAILABLE_COPY,
  inboundMemberScreenTwiml,
  inboundNobodyTwiml,
  inboundRingTwiml,
  inboundUnavailableTwiml,
  leadDeclinedTwiml,
  leadDeferredMemberTwiml,
  leadDeferredTwiml,
  leadOptedOutMemberTwiml,
  leadOptedOutTwiml,
  leadPhoneChangedTwiml,
  leadScreenTwiml,
  leadUnreachableTwiml,
  memberPromptTwiml,
  spokenPhoneNumber,
  verificationCodeTwiml,
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
  screenUrl: 'https://api.example.test/api/webhooks/twilio-voice/screen?listId=l1&leadId=ld1&jobKey=j1',
  resultUrl: 'https://api.example.test/api/webhooks/twilio-voice/screen-result?listId=l1&leadId=ld1&jobKey=j1',
};
const NASTY = `Smith & Sons <"O'Brien"> ]]> &amp;`;

describe('twiml builders', () => {
  it('builds the member prompt: Gather with the prompt inside, then the no-input fallthrough and a hangup', () => {
    const xml = memberPromptTwiml({ announcedName: 'Acme Plumbing', gatherUrl: URLS.gatherUrl });
    const root = parseXml(xml);
    expect(root.name).toBe('Response');
    expect(root.children.map((c) => c.name)).toEqual(['Gather', 'Say', 'Hangup']);
    const gather = root.children[0];
    expect(gather.attrs).toEqual({ input: 'dtmf', numDigits: '1', timeout: '8', action: URLS.gatherUrl, method: 'POST' });
    expect(gather.children[0].text).toBe('New lead from Acme Plumbing. Are you available to take the call now? Press 1.');
    expect(root.children[1].text).toBe(NO_INPUT_COPY);
  });

  it('escapes the announced name: "Smith & Sons" stays well-formed and reads back unchanged', () => {
    const xml = memberPromptTwiml({ announcedName: 'Smith & Sons', gatherUrl: URLS.gatherUrl });
    expect(xml).toContain('New lead from Smith &amp; Sons. Are you available');
    expect(parseXml(xml).children[0].children[0].text).toBe('New lead from Smith & Sons. Are you available to take the call now? Press 1.');
  });

  it('survives quotes, angle brackets and entity look-alikes in the name even though the validator forbids them', () => {
    const xml = memberPromptTwiml({ announcedName: NASTY, gatherUrl: URLS.gatherUrl });
    expect(parseXml(xml).children[0].children[0].text).toBe(`New lead from ${NASTY}. Are you available to take the call now? Press 1.`);
    expect(xml.match(/<Say>/g)).toHaveLength(2);
  });

  it('escapes attribute values (URLs carry & between query parameters)', () => {
    const xml = memberPromptTwiml({ announcedName: 'A', gatherUrl: 'https://x.test/g?a=1&b="2"<' });
    expect(xml).toContain('action="https://x.test/g?a=1&amp;b=&quot;2&quot;&lt;"');
    expect(parseXml(xml).children[0].attrs.action).toBe('https://x.test/g?a=1&b="2"<');
  });

  it('drops characters XML 1.0 cannot carry instead of emitting a document Twilio would reject', () => {
    const xml = memberPromptTwiml({ announcedName: 'Ac\u0000me\u0008', gatherUrl: URLS.gatherUrl });
    expect(parseXml(xml).children[0].children[0].text).toContain('Acme.');
  });

  it('builds the connect response: Say, then Dial with callerId/timeout/action and one Number carrying the screening url and the status callback', () => {
    const xml = connectTwiml({ twilioNumber: '+15555550111', leadE164: '+15555550123', ...URLS });
    const root = parseXml(xml);
    expect(root.children.map((c) => c.name)).toEqual(['Say', 'Dial']);
    expect(root.children[0].text).toBe(CONNECTING_COPY);
    const dial = root.children[1];
    expect(dial.attrs).toEqual({ answerOnBridge: 'true', callerId: '+15555550111', timeout: '25', timeLimit: '1800', action: URLS.dialUrl, method: 'POST' });
    expect(dial.children).toHaveLength(1);
    const number = dial.children[0];
    expect(number.name).toBe('Number');
    expect(number.text).toBe('+15555550123');
    expect(number.attrs).toEqual({
      url: URLS.screenUrl,
      method: 'POST',
      statusCallback: URLS.statusUrl,
      statusCallbackEvent: 'initiated ringing answered completed',
      statusCallbackMethod: 'POST',
    });
  });

  it('escapes the screening url like every other attribute', () => {
    const xml = connectTwiml({ twilioNumber: '+15555550111', leadE164: '+15555550123', dialUrl: 'd', statusUrl: 's', screenUrl: 'https://x.test/s?a=1&b="2"<' });
    expect(xml).toContain('url="https://x.test/s?a=1&amp;b=&quot;2&quot;&lt;"');
    expect(parseXml(xml).children[1].children[0].attrs.url).toBe('https://x.test/s?a=1&b="2"<');
  });

  it('refuses to put anything but an E.164 number into the Dial', () => {
    expect(() => connectTwiml({ twilioNumber: '+15555550111', leadE164: '5555550123</Number><Hangup/>', ...URLS })).toThrow('TwiML lead number is not E.164');
    expect(() => connectTwiml({ twilioNumber: 'client:x', leadE164: '+15555550123', ...URLS })).toThrow('TwiML caller id is not E.164');
  });

  it('builds the lead-unreachable apology and the bare hangup', () => {
    const apology = parseXml(leadUnreachableTwiml());
    expect(apology.children.map((c) => c.name)).toEqual(['Say', 'Hangup']);
    expect(apology.children[0].text).toBe(LEAD_UNREACHABLE_COPY);
    expect(hangupTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  const promptFor = (name: string, number = '+14155550111', canDefer = true): string =>
    `Hi, this is an automated call from ${name}. To stop these calls at any time, press 3. We're calling about the enquiry you sent us. ${canDefer ? "Press 1 and we'll connect you to a person now, or press 2 and we'll call you again later." : "Press 1 and we'll connect you to a person now."} You can also call us on ${number}.`;

  it('builds the lead screening prompt: a one-digit Gather with the escaped name and the spoken callback number, then a goodbye and hangup', () => {
    const xml = leadScreenTwiml({ announcedName: 'Smith & Sons', callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer: true });
    const root = parseXml(xml);
    expect(root.children.map((c) => c.name)).toEqual(['Gather', 'Say', 'Hangup']);
    expect(root.children[0].attrs).toEqual({ input: 'dtmf', numDigits: '1', timeout: '8', action: URLS.resultUrl, method: 'POST' });
    expect(root.children[0].children[0].text).toBe(promptFor('Smith & Sons', '4 1 5, 5 5 5, 0 1 1 1'));
    expect(xml).toContain('automated call from Smith &amp; Sons. To stop');
    expect(xml).not.toContain('+14155550111');
    expect(root.children[1].text).toBe(SCREEN_NO_INPUT_COPY);
  });

  it('offers option 2 only when a retry can happen (canDefer): the retry call and a disabled feature get the two-option prompt', () => {
    const say = (canDefer: boolean): string =>
      parseXml(leadScreenTwiml({ announcedName: 'Smith & Sons', callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer })).children[0].children[0].text;
    expect(say(true)).toContain('press 2 and');
    expect(say(false)).toBe(promptFor('Smith & Sons', '4 1 5, 5 5 5, 0 1 1 1', false));
    expect(say(false)).not.toContain('press 2');
    expect(say(false)).toMatch(/connect you to a person now\. You can also call us on 4 1 5, 5 5 5, 0 1 1 1\.$/);
  });

  it('says the exact owner-approved prompt strings (full equality, both variants, name escaped as before)', () => {
    const say = (canDefer: boolean, name = 'Smith & Sons'): string =>
      parseXml(leadScreenTwiml({ announcedName: name, callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer })).children[0].children[0].text;
    expect(say(true)).toBe("Hi, this is an automated call from Smith & Sons. To stop these calls at any time, press 3. We're calling about the enquiry you sent us. Press 1 and we'll connect you to a person now, or press 2 and we'll call you again later. You can also call us on 4 1 5, 5 5 5, 0 1 1 1.");
    expect(say(false)).toBe("Hi, this is an automated call from Smith & Sons. To stop these calls at any time, press 3. We're calling about the enquiry you sent us. Press 1 and we'll connect you to a person now. You can also call us on 4 1 5, 5 5 5, 0 1 1 1.");
    const raw = leadScreenTwiml({ announcedName: `A&B <C> 'D' "E"`, callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer: true });
    expect(raw).toContain('call from A&amp;B &lt;C&gt; &apos;D&apos; &quot;E&quot;. To stop these calls');
  });

  it('writes the apostrophes of the static copy as &apos; and the parsed <Say> text round-trips to the exact string', () => {
    const xml = leadScreenTwiml({ announcedName: 'Smith & Sons', callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer: true });
    expect(xml).toContain('We&apos;re calling about the enquiry you sent us. Press 1 and we&apos;ll connect you to a person now, or press 2 and we&apos;ll call you again later.');
    expect(xml).not.toContain("We're");
    expect(parseXml(xml).children[0].children[0].text).toBe(promptFor('Smith & Sons', '4 1 5, 5 5 5, 0 1 1 1'));
  });

  it.each([[true], [false]])('names the caller first and offers press 3 before the enquiry sentence and the options (canDefer=%s)', (canDefer) => {
    const text = parseXml(leadScreenTwiml({ announcedName: 'Smith & Sons', callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer })).children[0].children[0].text;
    expect(text.startsWith('Hi, this is an automated call from Smith & Sons. To stop these calls at any time, press 3.')).toBe(true);
    expect(text.startsWith('Hi, this is an automated call from Smith & Sons. To stop these calls at any time, press 3.')).toBe(true);
    expect(text.indexOf('press 3')).toBeLessThan(text.indexOf("We're calling about the enquiry"));
    expect(text.indexOf('press 3')).toBeLessThan(text.indexOf('Press 1'));
    expect(text.indexOf('Press 1')).toBeLessThan(text.indexOf('call us on 4 1 5')); // the callback number is last
  });

  it('keeps the screening prompt well-formed for quotes, angle brackets and entity look-alikes in the name', () => {
    const xml = leadScreenTwiml({ announcedName: NASTY, callbackNumber: '+14155550111', resultUrl: URLS.resultUrl, canDefer: true });
    expect(parseXml(xml).children[0].children[0].text).toBe(promptFor(NASTY, '4 1 5, 5 5 5, 0 1 1 1'));
  });

  it('refuses a callback number that is not E.164 rather than speaking it', () => {
    expect(() => leadScreenTwiml({ announcedName: 'X', callbackNumber: '4155550111', resultUrl: URLS.resultUrl, canDefer: true })).toThrow('not E.164');
  });

  it('speaks a US number in 3-3-4 groups, digit by digit, and any other number digit by digit', () => {
    expect(spokenPhoneNumber('+12125550198')).toBe('2 1 2, 5 5 5, 0 1 9 8');
    expect(spokenPhoneNumber('+442071838750')).toBe('4 4 2 0 7 1 8 3 8 7 5 0');
  });

  it.each([
    ['+1 with too few digits', '+141555501', '1 4 1 5 5 5 5 0 1'],
    ['+1 with too many digits', '+1415555011199', '1 4 1 5 5 5 5 0 1 1 1 9 9'],
    ['a bare plus', '+', ''],
    ['empty input', '', ''],
    ['a Canadian number (formatting only: the prompt itself is US-only, Canada is refused upstream)', '+14165550142', '4 1 6, 5 5 5, 0 1 4 2'],
    ['a non-US number, read digit by digit', '+33142685300', '3 3 1 4 2 6 8 5 3 0 0'],
  ])('speaks %s', (_name, input, spoken) => {
    expect(spokenPhoneNumber(input)).toBe(spoken);
  });

  it.each([['a bare plus', '+'], ['empty', ''], ['a number with a letter', '+1415555011x']])('refuses %s as the callback number', (_name, number) => {
    expect(() => leadScreenTwiml({ announcedName: 'X', callbackNumber: number, resultUrl: URLS.resultUrl, canDefer: true })).toThrow('not E.164');
  });

  it('reads a non-US E.164 callback number digit by digit in the prompt', () => {
    const xml = leadScreenTwiml({ announcedName: 'X', callbackNumber: '+442071838750', resultUrl: URLS.resultUrl, canDefer: true });
    expect(parseXml(xml).children[0].children[0].text).toContain('call us on 4 4 2 0 7 1 8 3 8 7 5 0.');
  });

  it('builds the stop messages: the lead hears the goodbye naming the business, the member is told in the fixed copy', () => {
    const lead = parseXml(leadOptedOutTwiml('Smith & Sons'));
    expect(lead.children.map((c) => c.name)).toEqual(['Say', 'Hangup']);
    expect(lead.children.map((c) => c.name)).not.toContain('Gather'); // nothing more is asked: the call ends after the goodbye
    expect(lead.children[0].text).toBe('Smith & Sons will not call this number again. Goodbye.');
    const member = parseXml(leadOptedOutMemberTwiml());
    expect(member.children.map((c) => c.name)).toEqual(['Say', 'Hangup']);
    expect(member.children[0].text).toBe('The lead asked not to be called again. Their details are in your lead alert.');
    expect(parseXml(leadOptedOutTwiml(NASTY)).children[0].text).toBe(`${NASTY} will not call this number again. Goodbye.`);
  });

  it('answers the screening with an empty response so Twilio bridges the calls', () => {
    expect(bridgeTwiml()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(parseXml(bridgeTwiml()).children).toHaveLength(0);
  });

  it('builds the fixed messages for the member when the lead phone changed or the lead did not confirm', () => {
    for (const [xml, copy] of [[leadPhoneChangedTwiml(), LEAD_PHONE_CHANGED_COPY], [leadDeclinedTwiml(), LEAD_DECLINED_COPY]] as const) {
      const root = parseXml(xml);
      expect(root.children.map((c) => c.name)).toEqual(['Say', 'Hangup']);
      expect(root.children[0].text).toBe(copy);
    }
    expect(LEAD_PHONE_CHANGED_COPY).toBe('We could not reach the lead. Their details are in your lead alert.');
    expect(LEAD_DECLINED_COPY).toBe('The lead did not confirm. Their details are in your lead alert.');
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

describe('verificationCodeTwiml', () => {
  it('is well-formed and contains only the fixed phrase and the spaced digits', () => {
    const xml = verificationCodeTwiml('042917');
    const root = parseXml(xml);
    expect(root.children.map(c => c.name)).toEqual(['Pause', 'Say']);
    expect(root.children[1].text).toBe('Your Agent Web verification code is 0 4 2 9 1 7. Again, your code is 0 4 2 9 1 7. Goodbye.');
  });
  it.each(['12345', '1234567', '12&456', '<1234>', '12 456', '１２３４５６', ''])('refuses %j instead of interpolating it', bad => {
    expect(() => verificationCodeTwiml(bad)).toThrow('6 digits');
  });
});

describe('inbound callback TwiML', () => {
  const ring = { memberE164: '+14155550100', callerId: '+14155550111', screenUrl: 'https://x.test/s?orgId=o&tried=m', dialUrl: 'https://x.test/d?a=1&b=2', statusUrl: 'https://x.test/t' };

  it('the refusals say their copy and hang up, nothing else', () => {
    expect(inboundUnavailableTwiml()).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${INBOUND_UNAVAILABLE_COPY}</Say><Hangup/></Response>`);
    expect(inboundNobodyTwiml()).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>${INBOUND_NOBODY_COPY}</Say><Hangup/></Response>`);
  });

  it('rings one member with answerOnBridge, the screening url, an escaped action and the completed status callback', () => {
    const xml = inboundRingTwiml(ring);
    expect(xml).toContain('<Dial answerOnBridge="true" callerId="+14155550111"');
    expect(xml).toContain('action="https://x.test/d?a=1&amp;b=2"');
    expect(xml).toContain('<Number url="https://x.test/s?orgId=o&amp;tried=m" method="POST" statusCallback="https://x.test/t" statusCallbackEvent="completed"');
    expect(xml).toContain('>+14155550100</Number>');
    expect(xml.match(/<Number /g)).toHaveLength(1);
  });

  it.each([['member', { memberE164: '5550100' }], ['caller id', { callerId: 'abc' }]])('refuses a %s that is not E.164', (_what, over) => {
    expect(() => inboundRingTwiml({ ...ring, ...over })).toThrow(/E\.164/);
  });

  it('asks the member to press 1, naming the business with XML escaping, and hangs up on no input', () => {
    const xml = inboundMemberScreenTwiml({ announcedName: 'Smith & Sons', resultUrl: 'https://x.test/r?a=1&b=2' });
    expect(xml).toContain('<Say>Smith &amp; Sons: a lead is calling back. Are you available to take the call? Press 1.</Say>');
    expect(xml).toContain('<Gather input="dtmf" numDigits="1"');
    expect(xml).toContain('action="https://x.test/r?a=1&amp;b=2"');
    expect(xml.endsWith(`<Say>${NO_INPUT_COPY}</Say><Hangup/></Response>`)).toBe(true);
  });
});

describe('press 2 copies (ENG-2783)', () => {
  it('says the two fixed lines, escaping the name', () => {
    const say = (xml: string): string => parseXml(xml).children[0].text;
    expect(say(leadDeferredTwiml('Smith & Sons'))).toBe('Okay. Smith & Sons will call you again later. Goodbye.');
    expect(say(leadDeferredMemberTwiml())).toBe('The lead is not available right now. We will try again later.');
    expect(leadDeferredTwiml('A <b>')).toContain('A &lt;b&gt;');
  });
});
