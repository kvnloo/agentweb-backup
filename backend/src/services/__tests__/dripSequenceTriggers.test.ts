import {
  matchEnrollmentTriggers,
  TriggerEvent,
  TriggerSequence,
} from '../dripSequenceTriggers';

const tagEvent = (tag: string, source: TriggerEvent['source'] = 'crm'): TriggerEvent => ({
  type: 'tag_added',
  leadId: 'lead-1',
  tag,
  source,
});
const createdEvent = (source: TriggerEvent['source'] = 'crm'): TriggerEvent => ({
  type: 'lead_created',
  leadId: 'lead-1',
  source,
});

describe('matchEnrollmentTriggers (ENG-2534)', () => {
  it('only matches active sequences; paused/draft get not_active', () => {
    const seqs: TriggerSequence[] = [
      { id: 'a', status: 'active', trigger: { type: 'lead_created' } },
      { id: 'b', status: 'paused', trigger: { type: 'lead_created' } },
      { id: 'c', status: 'draft', trigger: { type: 'lead_created' } },
    ];
    expect(matchEnrollmentTriggers(createdEvent(), seqs)).toEqual({
      enroll: ['a'],
      skipped: [
        { sequenceId: 'b', reason: 'not_active' },
        { sequenceId: 'c', reason: 'not_active' },
      ],
    });
  });

  it('tag_added matches case-insensitively on trimmed tag', () => {
    const seqs: TriggerSequence[] = [
      { id: 'ato', status: 'active', trigger: { type: 'tag_added', tag: ' ATO ' } },
      { id: 'other', status: 'active', trigger: { type: 'tag_added', tag: 'vip' } },
    ];
    const r = matchEnrollmentTriggers(tagEvent('  ato'), seqs);
    expect(r.enroll).toEqual(['ato']);
    expect(r.skipped).toEqual([{ sequenceId: 'other', reason: 'tag_mismatch' }]);
  });

  it('tag_added sequence without a tag never matches', () => {
    const seqs: TriggerSequence[] = [{ id: 'x', status: 'active', trigger: { type: 'tag_added' } }];
    expect(matchEnrollmentTriggers(tagEvent(''), seqs).skipped).toEqual([
      { sequenceId: 'x', reason: 'tag_mismatch' },
    ]);
  });

  it('lead_created ignores tag and event type must match', () => {
    const seqs: TriggerSequence[] = [
      { id: 'a', status: 'active', trigger: { type: 'lead_created', tag: 'ignored' } },
      { id: 'b', status: 'active', trigger: { type: 'tag_added', tag: 'ato' } },
    ];
    const r = matchEnrollmentTriggers({ ...createdEvent(), tag: 'something' }, seqs);
    expect(r.enroll).toEqual(['a']);
    expect(r.skipped).toEqual([{ sequenceId: 'b', reason: 'event_type_mismatch' }]);
  });

  it('optional sources filter restricts by event source', () => {
    const seqs: TriggerSequence[] = [
      { id: 'a', status: 'active', trigger: { type: 'lead_created', sources: ['webhook', 'csv'] } },
      { id: 'b', status: 'active', trigger: { type: 'lead_created', sources: [] } },
    ];
    expect(matchEnrollmentTriggers(createdEvent('crm'), seqs)).toEqual({
      enroll: ['b'],
      skipped: [{ sequenceId: 'a', reason: 'source_mismatch' }],
    });
    expect(matchEnrollmentTriggers(createdEvent('csv'), seqs).enroll).toEqual(['a', 'b']);
  });

  it('does not re-enroll a lead with an active or completed enrollment', () => {
    const seqs: TriggerSequence[] = ['s1', 's2', 's3', 's4'].map((id) => ({
      id,
      status: 'active' as const,
      trigger: { type: 'lead_created' as const },
    }));
    const r = matchEnrollmentTriggers(createdEvent(), seqs, [
      { leadId: 'lead-1', sequenceId: 's1', status: 'active' },
      { leadId: 'lead-1', sequenceId: 's2', status: 'completed' },
      { leadId: 'lead-1', sequenceId: 's3', status: 'unsubscribed' },
      { leadId: 'lead-2', sequenceId: 's4', status: 'active' },
    ]);
    expect(r.enroll).toEqual(['s3', 's4']);
    expect(r.skipped).toEqual([
      { sequenceId: 's1', reason: 'already_enrolled' },
      { sequenceId: 's2', reason: 'already_enrolled' },
    ]);
  });

  it('returns deterministic order by sequence id and does not mutate input', () => {
    const seqs: TriggerSequence[] = [
      { id: 'z', status: 'active', trigger: { type: 'lead_created' } },
      { id: 'a', status: 'active', trigger: { type: 'lead_created' } },
      { id: 'm', status: 'paused', trigger: { type: 'lead_created' } },
    ];
    const snapshot = JSON.stringify(seqs);
    const r = matchEnrollmentTriggers(createdEvent(), seqs);
    expect(r.enroll).toEqual(['a', 'z']);
    expect(JSON.stringify(seqs)).toBe(snapshot);
    expect(matchEnrollmentTriggers(createdEvent(), [...seqs].reverse())).toEqual(r);
  });
});
