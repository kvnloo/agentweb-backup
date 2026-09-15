/**
 * ENG-1938 — the pending-invitation ledger keeps the EARLIEST sentAt estimate.
 *
 * LinkedIn reports only relative ages; Unipile resolves "Sent 3 months ago" at
 * request time, so every observation lands at or after the real send. The old
 * rule kept the FIRST observation, which froze wrong rows forever. Production,
 * 2026-09-14: 450 of TFA Connect's 681 rows carried their first sync time as
 * sentAt, so invitations from March–May looked 4–19 days old and the stale
 * invitation drain (ENG-1719) could not see them.
 */

import {
  resolveLedgerSentAt,
  sentInvitationChanged,
} from '../services/linkedInSentInvitationsSyncService';
import type { UnipileSentInvitation } from '../services/unipileSentInvitationsDb';

const NOW = '2026-09-15T12:00:00.000Z';

const row = (overrides: Partial<UnipileSentInvitation> = {}): UnipileSentInvitation => ({
  accountId: 'ofGscnIrR5qZYZ00ovNsTQ',
  invitedUserPublicId: 'kai-luo',
  publicProfileUrl: 'https://www.linkedin.com/in/kai-luo/',
  invitationId: 'inv-1',
  invitedUserName: 'Kai Luo',
  invitationText: '',
  sentAt: '2026-09-10T00:53:49.000Z',
  syncedAt: '2026-09-10T00:53:49.000Z',
  ...overrides,
});

describe('resolveLedgerSentAt', () => {
  it('THE BUG: a row stamped with its first sync time heals once Unipile supplies the real age', () => {
    // First seen with no parsed_datetime → sentAt == syncedAt. Today LinkedIn says "4 months ago".
    const cached = row();
    const sentAt = resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: '2026-05-18T12:00:00.000Z' }, NOW);

    expect(sentAt).toBe('2026-05-18T12:00:00.000Z');
    expect(sentInvitationChanged(cached, { ...cached, sentAt })).toBe(true);
  });

  it('request-time drift moves nothing and writes nothing (ENG-875 still holds)', () => {
    const cached = row({ sentAt: '2026-05-04T04:31:10.002Z' });
    // The same "4 months ago" label resolved again, minutes later.
    const sentAt = resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: '2026-05-04T04:38:52.378Z' }, NOW);

    expect(sentAt).toBe('2026-05-04T04:31:10.002Z');
    expect(sentInvitationChanged(cached, { ...cached, sentAt })).toBe(false);
  });

  it('a bucket rollover to an earlier age lowers sentAt ("1 week ago" → "1 month ago")', () => {
    const cached = row({ sentAt: '2026-09-08T12:00:00.000Z' });
    expect(resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: '2026-08-15T12:00:00.000Z' }, NOW))
      .toBe('2026-08-15T12:00:00.000Z');
  });

  it('keeps the exact instant our own send stamped, since a later label cannot resolve earlier than a real send', () => {
    const cached = row({ sentAt: '2026-09-15T11:58:02.114Z', syncedAt: '2026-09-15T11:58:02.114Z', invitedUserName: '' });
    expect(resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: '2026-09-15T11:59:40.000Z' }, NOW))
      .toBe('2026-09-15T11:58:02.114Z');
  });

  it('a different invitationId is a NEW invitation — the old date is not carried over', () => {
    const cached = row({ invitationId: 'inv-old', sentAt: '2026-03-01T00:00:00.000Z' });
    expect(resolveLedgerSentAt(cached, { id: 'inv-new', parsed_datetime: '2026-09-14T09:00:00.000Z' }, NOW))
      .toBe('2026-09-14T09:00:00.000Z');
  });

  it('a send-path row with no invitationId yet is still the same invitation', () => {
    const cached = row({ invitationId: '', sentAt: '2026-09-15T11:58:02.114Z' });
    expect(resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: '2026-09-15T11:59:40.000Z' }, NOW))
      .toBe('2026-09-15T11:58:02.114Z');
  });

  it('ignores an unparseable or future provider value instead of trusting it', () => {
    const cached = row({ sentAt: '2026-08-01T00:00:00.000Z' });
    expect(resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: 'Sent 3 months ago' }, NOW)).toBe('2026-08-01T00:00:00.000Z');
    expect(resolveLedgerSentAt(cached, { id: 'inv-1', parsed_datetime: '2027-01-01T00:00:00.000Z' }, NOW)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('first sight: uses parsed_datetime, and falls back to now only when there is nothing better', () => {
    expect(resolveLedgerSentAt(undefined, { id: 'inv-1', parsed_datetime: '2026-06-01T00:00:00.000Z' }, NOW)).toBe('2026-06-01T00:00:00.000Z');
    expect(resolveLedgerSentAt(undefined, { id: 'inv-1' }, NOW)).toBe(NOW);
    expect(resolveLedgerSentAt(row({ sentAt: 'garbage' }), { id: 'inv-1' }, NOW)).toBe(NOW);
  });
});

describe('sentInvitationChanged and sentAt', () => {
  it('a LATER sentAt is not a change; an EARLIER one is', () => {
    const cached = row({ sentAt: '2026-06-01T00:00:00.000Z' });
    expect(sentInvitationChanged(cached, { ...cached, sentAt: '2026-06-02T00:00:00.000Z', syncedAt: NOW })).toBe(false);
    expect(sentInvitationChanged(cached, { ...cached, sentAt: '2026-05-31T00:00:00.000Z', syncedAt: NOW })).toBe(true);
  });
});
