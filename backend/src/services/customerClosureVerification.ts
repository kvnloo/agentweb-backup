import type { IssueCommentDetail } from './linearService';

const VERIFICATION_MARKER = '<!-- customer-symptom-verification:v1 -->';

function field(body: string, name: string): string | null {
  const match = body.match(new RegExp(`^\\s*-\\s*${name}:\\s*(.+?)\\s*$`, 'im'));
  return match?.[1]?.trim() || null;
}

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
      !!verifier && /^post-merge-verifier\/\S+$/i.test(verifier);
  });
}

export const CUSTOMER_VERIFICATION_BLOCK_MARKER = '<!-- customer-verification-blocked:v1 -->';
