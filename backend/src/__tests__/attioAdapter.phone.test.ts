import { toAttioPhone } from '../services/adapters/attioAdapter';

describe('toAttioPhone', () => {
  it('prefixes bare 10-digit US numbers', () => {
    expect(toAttioPhone('2532344511')).toEqual({ original_phone_number: '+12532344511' });
    expect(toAttioPhone('(513) 737-2727')).toEqual({ original_phone_number: '+15137372727' });
  });
  it('handles 11-digit numbers with leading 1', () => {
    expect(toAttioPhone('1-253-234-4511')).toEqual({ original_phone_number: '+12532344511' });
  });
  it('keeps E.164 numbers as-is', () => {
    expect(toAttioPhone('+44 20 7946 0958')).toEqual({ original_phone_number: '+44 20 7946 0958' });
  });
  it('never folds extension digits into the number', () => {
    expect(toAttioPhone('253-2345 ext 678')).toEqual({ original_phone_number: '253-2345 ext 678', country_code: 'US' });
    expect(toAttioPhone('253-2345 x678')).toEqual({ original_phone_number: '253-2345 x678', country_code: 'US' });
  });
  it('falls back to a US country hint for other shapes', () => {
    expect(toAttioPhone('555-0100')).toEqual({ original_phone_number: '555-0100', country_code: 'US' });
  });
});
