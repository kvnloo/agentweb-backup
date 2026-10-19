import {
  hotLeadCallConfigOf, HOT_LEAD_CALL_LIMITS, HOT_LEAD_CALL_LIMIT_FIELDS, type HotLeadCallConfig,
} from '../services/hotLeadCallConfig';

const SID = 'PN' + 'a'.repeat(32);
const base = (over: Record<string, unknown> = {}) => ({ enabled: false, destinationPhone: '+14155550100', announcedName: 'Acme Plumbing', ...over });
const enabledBase = (over: Record<string, unknown> = {}) => base({
  enabled: true, destinationVerifiedAt: '2026-01-01T00:00:00.000Z', twilioNumber: '+14155550111',
  quietHours: { timezone: 'America/Chicago' }, ...over,
});

describe('hotLeadCallConfigOf', () => {
  it('fills defaults for a minimal disabled config', () => {
    expect(hotLeadCallConfigOf(base())).toEqual({
      enabled: false, destinationPhone: '+14155550100', announcedName: 'Acme Plumbing', leadTypes: ['form_fill'],
      maxAgeMinutes: 10, maxCallsPerHour: 6, maxCallsPerDay: 20, ownerCooldownMinutes: 2, allowedCountries: ['US', 'CA'],
    });
  });

  it('accepts a fully populated enabled config and defaults quiet hours to 08:00-21:00', () => {
    const config = hotLeadCallConfigOf(enabledBase({ twilioNumberSid: SID, leadTypes: ['form_fill', 'booking'], allowedCountries: ['US'] })) as HotLeadCallConfig;
    expect(config.enabled).toBe(true);
    expect(config.quietHours).toEqual({ start: '08:00', end: '21:00', timezone: 'America/Chicago' });
    expect(config.twilioNumberSid).toBe(SID);
  });

  it('trims announcedName', () => {
    expect(hotLeadCallConfigOf(base({ announcedName: '  O\'Brien & Sons, Inc.  ' }))?.announcedName).toBe("O'Brien & Sons, Inc.");
  });

  it.each([null, undefined, 'x', 5, [], base({ enabled: 'true' }), base({ enabled: undefined })])('rejects non-object or bad enabled %j', raw => {
    expect(hotLeadCallConfigOf(raw)).toBeNull();
  });

  it.each([
    ['unknown key', { extra: 1 }],
    ['unknown key shaped like an org override', { orgId: 'org-b' }],
    ['missing phone', { destinationPhone: undefined }],
    ['non-E.164 phone', { destinationPhone: '(415) 555-0100' }],
    ['non US/CA phone', { destinationPhone: '+442071838750' }],
    ['non US/CA NANP phone', { destinationPhone: '+18765550100' }],
    ['non-string phone', { destinationPhone: 4155550100 }],
    ['bad verifiedAt', { destinationVerifiedAt: 'yesterday' }],
    ['non-canonical verifiedAt', { destinationVerifiedAt: '2026-01-01' }],
    ['bad twilioNumber', { twilioNumber: '12345' }],
    ['bad sid', { twilioNumberSid: 'PN123' }],
    ['uppercase sid', { twilioNumberSid: 'PN' + 'A'.repeat(32) }],
    ['unknown lead type', { leadTypes: ['spam'] }],
    ['duplicate lead types', { leadTypes: ['form_fill', 'form_fill'] }],
    ['empty lead types', { leadTypes: [] }],
    ['null lead types', { leadTypes: null }],
    ['missing announcedName', { announcedName: undefined }],
    ['blank announcedName', { announcedName: '   ' }],
    ['61-char announcedName', { announcedName: 'a'.repeat(61) }],
    ['angle brackets in name', { announcedName: 'Acme <Say>' }],
    ['ampersand-entity injection', { announcedName: 'Acme </Say><Dial>' }],
    ['newline in name', { announcedName: 'Acme\nPlumbing' }],
    ['control char in name', { announcedName: 'Acme\u0007' }],
    ['quote in name', { announcedName: 'Acme "x"' }],
    ['semicolon in name', { announcedName: 'Acme; drop' }],
    ['non-string name', { announcedName: 5 }],
    ['unknown country', { allowedCountries: ['MX'] }],
    ['empty countries', { allowedCountries: [] }],
    ['duplicate countries', { allowedCountries: ['US', 'US'] }],
    ['quiet hours without timezone', { quietHours: { start: '08:00', end: '21:00' } }],
    ['quiet hours bad timezone', { quietHours: { timezone: 'Mars/Olympus' } }],
    ['quiet hours empty timezone', { quietHours: { timezone: '' } }],
    ['quiet hours bad time', { quietHours: { start: '8:00', timezone: 'UTC' } }],
    ['quiet hours 24:00', { quietHours: { end: '24:00', timezone: 'UTC' } }],
    ['quiet hours start == end', { quietHours: { start: '09:00', end: '09:00', timezone: 'UTC' } }],
    ['quiet hours unknown key', { quietHours: { timezone: 'UTC', x: 1 } }],
    ['quiet hours not object', { quietHours: '08:00-21:00' }],
  ])('rejects %s', (_label, over) => {
    expect(hotLeadCallConfigOf(base(over))).toBeNull();
  });

  describe.each(HOT_LEAD_CALL_LIMIT_FIELDS)('%s bounds', field => {
    const { min, max, default: dflt } = HOT_LEAD_CALL_LIMITS[field];
    it('accepts the bounds and defaults when absent', () => {
      expect(hotLeadCallConfigOf(base({ [field]: min }))?.[field]).toBe(min);
      expect(hotLeadCallConfigOf(base({ [field]: max }))?.[field]).toBe(max);
      expect(hotLeadCallConfigOf(base())?.[field]).toBe(dflt);
    });
    it.each([min - 1, max + 1, 1.5, '5', null, NaN])('rejects %j', value => {
      expect(hotLeadCallConfigOf(base({ [field]: value }))).toBeNull();
    });
  });

  describe('enabled requires a verified phone, a caller number and quiet hours', () => {
    it('accepts the complete enabled config', () => expect(hotLeadCallConfigOf(enabledBase())).not.toBeNull());
    it.each(['destinationVerifiedAt', 'twilioNumber', 'quietHours'])('rejects enabled without %s', field => {
      expect(hotLeadCallConfigOf(enabledBase({ [field]: undefined }))).toBeNull();
    });
    it('allows the same incomplete config when disabled', () => {
      expect(hotLeadCallConfigOf(enabledBase({ enabled: false, destinationVerifiedAt: undefined, twilioNumber: undefined, quietHours: undefined }))).not.toBeNull();
    });
  });
});
