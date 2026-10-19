import { decideSendingDomainReadiness, SendingDomain } from '../dripSendingDomainReadiness';

const verified: SendingDomain = {
  name: 'usehaven.ai',
  status: 'verified',
  records: [
    { record: 'SPF', type: 'TXT', status: 'verified' },
    { record: 'SPF', type: 'MX', status: 'verified' },
    { record: 'DKIM', type: 'TXT', status: 'verified' },
  ],
};

const decide = (over: Partial<Parameters<typeof decideSendingDomainReadiness>[0]> = {}) =>
  decideSendingDomainReadiness({ fromAddress: 'no-reply@usehaven.ai', domain: verified, ...over });

describe('decideSendingDomainReadiness', () => {
  it('ready for a fully verified matching domain', () => {
    expect(decide()).toEqual({ ready: true });
  });

  it('accepts subdomains, display names, and mixed case', () => {
    expect(decide({ fromAddress: 'Haven <Hi@Mail.UseHaven.ai>' })).toEqual({ ready: true });
  });

  it('invalid_from_address', () => {
    expect(decide({ fromAddress: 'not-an-email' })).toEqual({ ready: false, reasons: ['invalid_from_address'] });
    expect(decide({ fromAddress: null })).toEqual({ ready: false, reasons: ['invalid_from_address'] });
  });

  it('missing_domain', () => {
    expect(decide({ domain: null })).toEqual({ ready: false, reasons: ['missing_domain'] });
  });

  it('domain_mismatch, including lookalike suffix', () => {
    expect(decide({ fromAddress: 'a@agentweb.pro' })).toEqual({ ready: false, reasons: ['domain_mismatch'] });
    expect(decide({ fromAddress: 'a@evilusehaven.ai' })).toEqual({ ready: false, reasons: ['domain_mismatch'] });
  });

  it('domain_not_verified', () => {
    expect(decide({ domain: { ...verified, status: 'pending' } })).toEqual({
      ready: false,
      reasons: ['domain_not_verified'],
    });
  });

  it('spf_not_verified when any SPF record is pending or none exist', () => {
    const records = verified.records!.map((r) => (r.type === 'MX' ? { ...r, status: 'pending' } : r));
    expect(decide({ domain: { ...verified, records } })).toEqual({ ready: false, reasons: ['spf_not_verified'] });
    const noSpf = verified.records!.filter((r) => r.record !== 'SPF');
    expect(decide({ domain: { ...verified, records: noSpf } })).toEqual({ ready: false, reasons: ['spf_not_verified'] });
  });

  it('dkim_not_verified', () => {
    const records = verified.records!.map((r) => (r.record === 'DKIM' ? { ...r, status: 'failed' } : r));
    expect(decide({ domain: { ...verified, records } })).toEqual({ ready: false, reasons: ['dkim_not_verified'] });
  });

  it('lists every failure', () => {
    expect(
      decide({ fromAddress: 'a@other.com', domain: { name: 'usehaven.ai', status: 'not_started', records: [] } }),
    ).toEqual({
      ready: false,
      reasons: ['domain_mismatch', 'domain_not_verified', 'spf_not_verified', 'dkim_not_verified'],
    });
  });

  it('dmarc warning only when provided and invalid; never blocks', () => {
    expect(decide({ dmarcTxt: 'v=DMARC1; p=none' })).toEqual({ ready: true });
    expect(decide({ dmarcTxt: '' })).toEqual({ ready: true, warnings: ['dmarc_missing'] });
    expect(decide({ dmarcTxt: 'v=spf1 -all', domain: null })).toEqual({
      ready: false,
      reasons: ['missing_domain'],
      warnings: ['dmarc_missing'],
    });
  });
});
