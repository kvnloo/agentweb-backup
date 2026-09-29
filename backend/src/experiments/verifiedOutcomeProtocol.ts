export type OutcomeState = 'prepared' | 'committed' | 'verified' | 'failed' | 'unknown';

export interface OutcomeReceipt {
  operationId: string;
  state: OutcomeState;
  evidence?: string;
}

export function canClaimSuccess(receipt: OutcomeReceipt): boolean {
  return receipt.state === 'verified' && Boolean(receipt.evidence?.trim());
}

export function advanceOutcome(
  receipt: OutcomeReceipt,
  next: OutcomeState,
  evidence?: string,
): OutcomeReceipt {
  const allowed: Record<OutcomeState, OutcomeState[]> = {
    prepared: ['committed', 'failed'],
    committed: ['verified', 'failed', 'unknown'],
    verified: [],
    failed: [],
    unknown: ['verified', 'failed'],
  };
  if (!allowed[receipt.state].includes(next)) {
    throw new Error('invalid outcome transition: ' + receipt.state + ' -> ' + next);
  }
  return { ...receipt, state: next, evidence };
}
