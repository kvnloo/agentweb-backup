import type { IssueCommentDetail } from './linearService';

const VERIFICATION_MARKER = '<!-- customer-symptom-verification:v1 -->';

function field(body: string, name: string): string | null {
  const match = body.match(new RegExp(`^\\s*-\\s*${name}:\\s*(.+?)\\s*$`, 'im'));
  return match?.[1]?.trim() || null;
}

// ENG-1556 (2026-08-25, Harsha, live directive): "i don't give a shit about that fix anymore
// that no one can verify their own fixes, we do that all the time, remove that as a rule."
//
// This gate previously also required the Verifier field text to match a trusted-identity prefix
// (`post-merge-verifier/…` or `harsha-direct/…`) AND the comment's authorId to equal Harsha's own
// Linear account — together meaning only Harsha (or automation posting as him) could ever satisfy
// the gate, and no engineer could self-certify their own tested fix. ENG-1465 hit this repeatedly:
// Anurag verified his own fix thoroughly on prod and the Done transition kept bouncing back to
// Verifying anyway. Harsha's ruling: self-verification by the implementer is normal, accepted
// engineering practice. Both the trusted-prefix content check and the author-identity check are
// removed; see `rules/autonomous-execution-and-merge.md` closure-gate item 5 (already updated) for
// the policy this code now matches.
//
// What is deliberately NOT removed: the structured-evidence requirement. A merge/deploy claim
// still cannot satisfy this contract — the comment must explicitly classify the evidence as a
// customer-symptom check (not "looks fixed" / "merged") and record what and how it checked. Only
// the WHO-posted-it restriction is gone; the WHAT-must-be-in-it requirement is unchanged.

/**
 * A customer-bug closure record is deliberately structured and fail-closed.
 * A merge/deploy claim cannot satisfy this contract: the verifier must explicitly
 * classify the evidence as a customer-symptom check and record what and how it checked.
 * Any Linear user's comment can satisfy this — including the fix's own author/implementer
 * (ENG-1556) — as long as the structured fields are present and well-formed.
 */
export function hasCustomerSymptomVerification(comments: IssueCommentDetail[]): boolean {
  return comments.some(({ body }) => {
    const verifier = field(body, 'Verifier');
    return body.includes(VERIFICATION_MARKER) &&
      field(body, 'Result')?.toLowerCase() === 'pass' &&
      field(body, 'Evidence type')?.toLowerCase() === 'customer-symptom' &&
      !!field(body, 'Checked') &&
      !!field(body, 'Method') &&
      !!verifier;
  });
}

export const CUSTOMER_VERIFICATION_BLOCK_MARKER = '<!-- customer-verification-blocked:v1 -->';
