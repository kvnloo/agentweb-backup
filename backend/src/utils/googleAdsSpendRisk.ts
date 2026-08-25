/**
 * ENG-1362. Whether a connected Google Ads account can spend real money.
 *
 * Derived in ONE place, and deliberately not left to each caller. Google's guarantee is
 * narrow and specific: `customer.test_account === true` means the account cannot serve
 * ads and cannot spend. Everything else — a real account, or one connected before we
 * recorded the flag, or one whose live lookup failed — is billable.
 *
 * The asymmetry is the point. A helper that returned `can_spend: false` for anything
 * other than an affirmative true would let "we never checked" read as "it is safe",
 * which is the exact failure this closes: a real, billable, ENABLED account whose
 * descriptive name is "Test" and whose name is the only thing suggesting otherwise.
 *
 * The account NAME is not an input here, and must not become one.
 */
export function describeGoogleAdsSpendRisk(
  config: { test_account?: boolean | null | undefined },
): { test_account: boolean | null | undefined; can_spend: boolean } {
  const flag = config.test_account;
  return {
    test_account: typeof flag === 'boolean' || flag === null ? flag : undefined,
    can_spend: flag !== true,
  };
}
