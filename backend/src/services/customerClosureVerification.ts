import type { IssueCommentDetail } from './linearService';

const VERIFICATION_MARKER = '<!-- customer-symptom-verification:v1 -->';

function field(body: string, name: string): string | null {
  const match = body.match(new RegExp(`^\\s*-\\s*${name}:\\s*(.+?)\\s*$`, 'im'));
  return match?.[1]?.trim() || null;
}

// Trusted verifier identities. Deliberately an allowlist of exact, structured prefixes rather
// than "any non-empty string" or "anyone other than the fix author" — the point of this gate is
// that a claim of independence must come from an identity we can actually trust, not merely one
// that isn't the implementer (a free-text human name, however genuine, is still an unstructured
// claim the gate exists to distrust — ENG-1268 originally had no path for this at all, which
// meant even Harsha reviewing and closing an issue himself, directly, in a live session, got
// silently reverted with no way to satisfy the gate; that incident is this test's regression
// fixture). `harsha-direct/<anything>` is Harsha's own explicit, deliberate sign-off — the one
// human identity this contract already treats as authoritative everywhere else (comms decisions,
// database/data-plane approval, external-copy review). Anyone else's name, however well-meaning,
// stays rejected exactly as before.
const TRUSTED_VERIFIER_PREFIX = /^(post-merge-verifier|harsha-direct)\/\S+$/i;

/**
 * A customer-bug closure record is deliberately structured and fail-closed.
 * A merge/deploy claim cannot satisfy this contract: the verifier must explicitly
 * classify the evidence as a customer-symptom check and record what and how it checked.
 */
export function hasCustomerSymptomVerification(comments: IssueCommentDetail[]): boolean {
  return comments.some(({ body }) => {
    const verifier = field(body, 'Verifier');
    return body.includes(VERIFICATION_MARKER) &&
      field(body, 'Result')?.toLowerCase() === 'pass' &&
      field(body, 'Evidence type')?.toLowerCase() === 'customer-symptom' &&
      !!field(body, 'Checked') &&
      !!field(body, 'Method') &&
      !!verifier && TRUSTED_VERIFIER_PREFIX.test(verifier);
  });
}

export const CUSTOMER_VERIFICATION_BLOCK_MARKER = '<!-- customer-verification-blocked:v1 -->';
