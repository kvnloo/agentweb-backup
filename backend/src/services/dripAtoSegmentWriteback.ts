/**
 * ENG-2546 (ENG-2167 slice): pure ATO segment write-back payload builder.
 *
 * Maps a drip routing/evaluator outcome to the tag diff to apply to the lead
 * in ATO. Pure: no ATO API calls, no persistence, no worker wiring. Tag names
 * come exclusively from config so nothing customer-specific is hard-coded.
 */

export type DripAtoOutcome =
  | 'no_response'
  | 'replied'
  | 'booked'
  | 'unsubscribed'
  | 'bounced';

export interface DripAtoSegmentConfig {
  inSequenceTag: string;
  newsletterTag: string;
  repliedTag: string;
  bookedTag: string;
  suppressionTag: string;
}

export interface BuildAtoSegmentWritebackInput {
  leadId: string;
  currentTags: readonly string[];
  outcome: string;
  config: DripAtoSegmentConfig;
}

export interface AtoSegmentWriteback {
  leadId: string;
  add: string[];
  remove: string[];
  reason?: string;
}

function desiredChange(
  outcome: string,
  c: DripAtoSegmentConfig,
): { add: string[]; remove: string[] } | null {
  switch (outcome) {
    case 'no_response':
      return { add: [c.newsletterTag], remove: [c.inSequenceTag] };
    case 'replied':
      return { add: [c.repliedTag], remove: [c.inSequenceTag] };
    case 'booked':
      return { add: [c.bookedTag], remove: [c.inSequenceTag] };
    case 'unsubscribed':
    case 'bounced':
      return { add: [c.suppressionTag], remove: [c.inSequenceTag, c.newsletterTag] };
    default:
      return null;
  }
}

export function buildAtoSegmentWriteback(
  input: BuildAtoSegmentWritebackInput,
): AtoSegmentWriteback {
  const { leadId, currentTags, outcome, config } = input;
  const change = desiredChange(outcome, config);
  if (!change) {
    return { leadId, add: [], remove: [], reason: `unknown_outcome:${outcome}` };
  }
  const have = new Set(currentTags);
  const add = [...new Set(change.add.filter((t) => t && !have.has(t)))];
  const addSet = new Set(add);
  const remove = [
    ...new Set(change.remove.filter((t) => t && have.has(t) && !addSet.has(t) && !change.add.includes(t))),
  ];
  return { leadId, add, remove };
}
