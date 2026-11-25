import { describeStatusReport } from '../services/gtmStatusReportOutcome';

// ENG-2840 W2-4: the status report routes answered "sent successfully" when no email went out. This is the one place that decides
// what a caller may say about a finished report.
describe('describeStatusReport', () => {
  it('refuses with 400 when no recipient resolved (nobody chosen, or the chosen contact has no address)', () => {
    const outcome = describeStatusReport({ recipients: 0, sent: 0, failed: 0 }, 'plan status report');
    expect(outcome.ok).toBe(false);
    expect(outcome.httpStatus).toBe(400);
    expect(outcome.message).toContain('Nothing was emailed');
    expect(outcome.message).not.toContain('successfully');
  });

  it('refuses with 400 and says nothing was emailed when the report would go to more people than the caller allows', () => {
    const outcome = describeStatusReport({ recipients: 12, sent: 0, failed: 0, overCap: 10 }, 'plan status report for "Launch"');
    expect(outcome).toEqual({
      ok: false,
      httpStatus: 400,
      message: 'The plan status report for "Launch" was not sent: it would go to 12 people and one call may email at most 10. Nothing was emailed. Choose fewer contacts.',
    });
  });

  it('a report over the cap is a 400 (nothing happened), never the 502 "refused all" answer its zero counts would otherwise give', () => {
    expect(describeStatusReport({ recipients: 3, sent: 0, failed: 0, overCap: 2 }, 'x').httpStatus).toBe(400);
    // a cap of 0 is still a cap: the field is "set", not "truthy"
    expect(describeStatusReport({ recipients: 1, sent: 0, failed: 0, overCap: 0 }, 'x').ok).toBe(false);
  });

  it('refuses with 400 and names how many contacts hold a list of addresses, singular and plural', () => {
    expect(describeStatusReport({ recipients: 1, sent: 0, failed: 0, multiAddressContacts: 1 }, 'plan status report')).toEqual({
      ok: false,
      httpStatus: 400,
      message: 'The plan status report was not sent: 1 contact on the plan holds more than one email address, and a report sent this way goes to one address per contact. Nothing was emailed. Put a single address in each contact.',
    });
    const two = describeStatusReport({ recipients: 3, sent: 0, failed: 0, multiAddressContacts: 2 }, 'phase status report');
    expect(two.httpStatus).toBe(400);
    expect(two.message).toContain('2 contacts on the plan hold more than one email address');
  });

  it('a list contact is a 400 (nothing happened), never the 502 "refused all" answer its zero counts would give', () => {
    expect(describeStatusReport({ recipients: 1, sent: 0, failed: 0, multiAddressContacts: 1 }, 'x').httpStatus).toBe(400);
  });

  it('refuses with 502 when the mail service refused every email', () => {
    const outcome = describeStatusReport({ recipients: 2, sent: 0, failed: 2 }, 'phase status report');
    expect(outcome).toEqual({
      ok: false,
      httpStatus: 502,
      message: 'The phase status report could not be sent: the mail service refused all 2 emails, or the report could not be built. Nothing was delivered.',
    });
  });

  it('never says nobody was chosen when recipients were resolved, even if the counts do not add up', () => {
    const outcome = describeStatusReport({ recipients: 2, sent: 0, failed: 0 }, 'plan status report');
    expect(outcome.httpStatus).toBe(502);
    expect(outcome.message).toContain('could not be sent');
  });

  it('says "1 email" for one recipient, not "1 emails"', () => {
    expect(describeStatusReport({ recipients: 1, sent: 0, failed: 1 }, 'plan status report').message).toContain('refused all 1 email, or');
  });

  it('succeeds and counts a partial send, never hiding the failures', () => {
    const outcome = describeStatusReport({ recipients: 3, sent: 2, failed: 1 }, 'plan status report');
    expect(outcome.ok).toBe(true);
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.message).toBe('The plan status report was sent to 2 of 3 recipients; 1 could not be sent.');
  });

  it('a send the non-production email guard held back is not "sent": the answer says so, and is not an error', () => {
    const held = describeStatusReport({ recipients: 2, sent: 0, failed: 0, suppressed: 2 }, 'plan status report');
    expect(held.ok).toBe(true);
    expect(held.message).toBe("The plan status report was NOT delivered: this environment's email guard held back 2 emails.");
    expect(held.message).not.toContain('successfully');
    expect(describeStatusReport({ recipients: 1, sent: 0, failed: 0, suppressed: 1 }, 'x').message).toContain('held back 1 email.');
    expect(describeStatusReport({ recipients: 3, sent: 0, failed: 1, suppressed: 2 }, 'x').message).toContain('and 1 could not be sent');
    // delivered, held back and refused all at once: all three are named
    expect(describeStatusReport({ recipients: 3, sent: 1, failed: 1, suppressed: 1 }, 'plan status report').message)
      .toBe("The plan status report was sent to 1 of 3 recipients; 1 could not be sent. 1 held back by this environment's email guard.");
    const mixed = describeStatusReport({ recipients: 3, sent: 2, failed: 0, suppressed: 1 }, 'plan status report');
    expect(mixed.message).toBe("The plan status report was sent successfully to 2 recipients. 1 held back by this environment's email guard.");
  });

  it('succeeds with a plain message when every email was accepted', () => {
    expect(describeStatusReport({ recipients: 2, sent: 2, failed: 0 }, 'plan status report').message)
      .toBe('The plan status report was sent successfully to 2 recipients.');
    expect(describeStatusReport({ recipients: 1, sent: 1, failed: 0 }, 'plan status report').message)
      .toBe('The plan status report was sent successfully to 1 recipient.');
  });
});
