/**
 * ENG-926 §C follow-up — per-list conversion mapping.
 *
 * §C shipped with `qualified` matched BY NAME, and recorded it as an accepted limitation:
 * a customer who renames "Qualified" to "SQL" silently stops emitting `QualifiedLead`.
 * Silently is the problem — §C's own design note calls it the safe failure direction, but
 * "safe" and "invisible" are not the same thing, and the card exists because of a failure
 * nobody could see.
 *
 * Won is NOT part of this. It resolves by the status entry's `type`, which customers
 * cannot rename out from under it, so it needs no mapping and gets none.
 */

import { mapStatusToMetaEvent } from '../services/metaConversionRelay';

const STATUSES = [
  { value: 'new', label: 'New', color: 'gray', type: 'active' as const },
  { value: 'sql', label: 'Sales Qualified', color: 'indigo', type: 'active' as const },
  { value: 'qualified', label: 'Qualified', color: 'blue', type: 'active' as const },
  { value: 'signed', label: 'Signed!', color: 'green', type: 'won' as const },
];

describe('mapStatusToMetaEvent — without a mapping (unchanged §C behaviour)', () => {
  it('still matches a status literally named qualified', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'qualified')).toEqual({
      conversionKind: 'qualified',
      isValueEvent: false,
    });
  });

  it('still resolves a renamed won status by its type', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'signed')).toEqual({
      conversionKind: 'won',
      isValueEvent: true,
    });
  });

  it('does not match a renamed qualified status — the limitation this fixes', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'sql')).toBeNull();
  });
});

describe('mapStatusToMetaEvent — with a per-list mapping', () => {
  it('maps the customer-chosen status to QualifiedLead', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'sql', { qualifiedStatus: 'sql' })).toEqual({
      conversionKind: 'qualified',
      isValueEvent: false,
    });
  });

  it('is authoritative: once set, the name match no longer applies', () => {
    // Otherwise a list would emit QualifiedLead for TWO statuses — the chosen one and any
    // that happens to be called "qualified" — which is a conversion the customer did not
    // ask for, on a relay whose whole premise is not sending those.
    expect(mapStatusToMetaEvent(STATUSES, 'qualified', { qualifiedStatus: 'sql' })).toBeNull();
  });

  it('matches on the label as well as the value', () => {
    expect(
      mapStatusToMetaEvent(STATUSES, 'sql', { qualifiedStatus: 'Sales Qualified' }),
    ).toEqual({ conversionKind: 'qualified', isValueEvent: false });
  });

  it('is case and separator insensitive, like every other status comparison here', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'sql', { qualifiedStatus: '  SQL  ' })).toEqual({
      conversionKind: 'qualified',
      isValueEvent: false,
    });
  });

  it('turns QualifiedLead off entirely when the mapping is explicitly null', () => {
    // A customer who does not want MQLs relayed needs a way to say so that is different
    // from "not configured", which still means "guess by name".
    expect(mapStatusToMetaEvent(STATUSES, 'qualified', { qualifiedStatus: null })).toBeNull();
    expect(mapStatusToMetaEvent(STATUSES, 'sql', { qualifiedStatus: null })).toBeNull();
  });

  it('never affects won, which resolves by type regardless', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'signed', { qualifiedStatus: null })).toEqual({
      conversionKind: 'won',
      isValueEvent: true,
    });
  });

  it('lets a won-typed status win even if it is also named as the qualified one', () => {
    // A misconfiguration, but it must resolve deterministically and toward the event that
    // carries revenue rather than the one that does not.
    expect(mapStatusToMetaEvent(STATUSES, 'signed', { qualifiedStatus: 'signed' })).toEqual({
      conversionKind: 'won',
      isValueEvent: true,
    });
  });

  it('maps nothing when the mapping names a status that does not exist', () => {
    // A status deleted after the mapping was set. Falling back to the name match here
    // would resurrect the exact behaviour the customer configured away from.
    expect(mapStatusToMetaEvent(STATUSES, 'qualified', { qualifiedStatus: 'deleted_status' })).toBeNull();
    expect(mapStatusToMetaEvent(STATUSES, 'sql', { qualifiedStatus: 'deleted_status' })).toBeNull();
  });

  it('falls back to the name match when the mapping object carries no qualifiedStatus', () => {
    // `{}` is "nothing configured", not "configured to nothing" — the latter is null.
    expect(mapStatusToMetaEvent(STATUSES, 'qualified', {})).toEqual({
      conversionKind: 'qualified',
      isValueEvent: false,
    });
  });

  it('ignores a blank string, which is neither a status name nor an explicit off', () => {
    expect(mapStatusToMetaEvent(STATUSES, 'qualified', { qualifiedStatus: '   ' })).toEqual({
      conversionKind: 'qualified',
      isValueEvent: false,
    });
  });
});
