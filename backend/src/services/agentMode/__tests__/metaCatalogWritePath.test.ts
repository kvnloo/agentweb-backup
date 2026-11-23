import { assertMetaCatalogWriteAllowed } from '../metaCatalogWritePath';

describe('assertMetaCatalogWriteAllowed (ENG-3060)', () => {
  it('refuses a CAPI events send without test_event_code', () => {
    expect(() => assertMetaCatalogWriteAllowed('POST', '123/events', {})).toThrow('requires test_event_code');
    expect(() => assertMetaCatalogWriteAllowed('POST', '123/events', { test_event_code: '  ' })).toThrow('requires test_event_code');
  });
  it('allows a CAPI test event and existing catalog edges', () => {
    expect(() => assertMetaCatalogWriteAllowed('POST', '123/events', { test_event_code: 'TEST1' })).not.toThrow();
    expect(() => assertMetaCatalogWriteAllowed('POST', '123/products', {})).not.toThrow();
    expect(() => assertMetaCatalogWriteAllowed('DELETE', '123/external_event_sources', {})).not.toThrow();
  });
  it('refuses unlisted paths and DELETE on events', () => {
    expect(() => assertMetaCatalogWriteAllowed('POST', '123/adsets', {})).toThrow('Unsupported catalog write path.');
    expect(() => assertMetaCatalogWriteAllowed('DELETE', '123/events', { test_event_code: 'T' })).toThrow('Unsupported catalog write path.');
  });
});
