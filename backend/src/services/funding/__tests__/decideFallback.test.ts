import { decideFallback, type FundingErrorClass } from '../decideFallback';
import type { RunFunding } from '../runFunding';

function fundingWith(fallback: 'stop' | 'agentweb'): RunFunding {
  return {
    route: 'api_key',
    fallback,
    ownerUserId: 'user-1',
    billingUserId: 'billing-1',
    resolvedAt: new Date().toISOString(),
  };
}

const ALL_ERROR_CLASSES: FundingErrorClass[] = [
  'invalid_credential',
  'revoked_credential',
  'quota_exceeded',
  'provider_outage',
  'network',
  'unknown',
];

describe('decideFallback (ENG-1816 F1)', () => {
  it('never returns switch_to_agentweb when the run\'s fallback is "stop", for any error class', () => {
    for (const errorClass of ALL_ERROR_CLASSES) {
      expect(decideFallback(errorClass, fundingWith('stop'))).not.toBe('switch_to_agentweb');
    }
  });

  it('a "stop" fallback run always stops, regardless of error class', () => {
    for (const errorClass of ALL_ERROR_CLASSES) {
      expect(decideFallback(errorClass, fundingWith('stop'))).toBe('stop');
    }
  });
});
