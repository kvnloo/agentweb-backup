import { configOf } from '../services/leadNotificationConfig';
import { collectLeadFitHints } from '../services/leadNotificationFit';

const enabled = { enabled: true, minUnitsDisqualifiers: ['under_50'] };
describe('lead notification fit', () => {
  it('preserves valid fit config and rejects malformed opt-ins', () => {
    const base = { enabled: true, slackChannelId: 'C123' };
    expect(configOf({ ...base, fitFilter: enabled })?.fitFilter).toEqual(enabled);
    for (const fitFilter of [null, [], { enabled: 'true' }, { enabled: true, minUnitsDisqualifiers: [9] }]) {
      expect(configOf({ ...base, fitFilter })).toBeUndefined();
    }
  });
  it.each([
    [{ company: 'Sunrise Property Management', customFields: { units: '50_200' } }, []],
    [{ company: 'Sunrise Property Management', customFields: { units: 'under_50' } }, ['units: under_50']],
    [{ company: 'UsuarioK', customFields: { units: '50_200' } }, ['no property signal']],
    [{ email: 'a@sunriseproperties.com', customFields: { number_of_units: 'under_50' } }, ['units: under_50']],
    [{ website: 'https://sunrisemgmt.com', customFields: { units: 'under_50' } }, ['units: under_50']],
    [{ company: 'BPMusic', email: 'property@gmail.com', customFields: { message: 'property management', landingUrl: 'https://properties.com' } }, ['no property signal']],
  ])('classifies independent flags without suppressing a single flag', (lead, reasons) => {
    expect(collectLeadFitHints(lead, enabled)).toEqual({ reasons });
  });
  it('defaults off, including explicitly disabled configs', () => {
    const lead = { customFields: { units: 'under_50' } };
    expect(collectLeadFitHints(lead)).toEqual({ reasons: [] });
    expect(collectLeadFitHints(lead, { enabled: false })).toEqual({ reasons: [] });
  });
  it('honors configured unit disqualifiers', () => {
    expect(collectLeadFitHints({ customFields: { units: 'under_50' } }, { enabled: true, minUnitsDisqualifiers: [] }).reasons).toEqual(['no property signal']);
  });
  it('collects weak negative hints for UsuarioK', () => {
    expect(collectLeadFitHints({ company: 'UsuarioK', email: 'usuario@gmail.com', customFields: { units: 'under_50', message: 'Les agradezco todo gracias' } }, enabled)).toEqual({ reasons: ['units: under_50', 'no property signal'] });
  });
});
