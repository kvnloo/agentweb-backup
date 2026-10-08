/**
 * ENG-2082: lead capture accepts phone-only submissions, so a contactable lead may have no
 * email at all. askCrm both RENDERED and SEARCHED such a lead as if it were an empty row:
 * `name` fell through to '(unnamed)' and the specific_contact haystack had no phone in it,
 * so asking about someone by their number answered "no contacts matched" for a lead that
 * plainly exists.
 */
import { askCrm, AskCrmLead } from '../services/askCrmService';

const phoneOnly: AskCrmLead = {
  leadId: 'p1',
  listId: 'L1',
  phone: '2125559876',
};

const withEmail: AskCrmLead = {
  leadId: 'e1',
  listId: 'L1',
  email: 'ada@example.com',
  firstName: 'Ada',
  lastName: 'Lovelace',
};

const deps = (leads: AskCrmLead[]) => ({
  loadLeadsForUser: jest.fn().mockResolvedValue(leads),
  now: () => new Date('2026-09-24T00:00:00.000Z'),
});

describe('askCrm — phone-only leads', () => {
  it('finds a lead by its phone number', async () => {
    const answer = await askCrm('what is going on with 2125559876', 'u1', deps([phoneOnly, withEmail]));
    expect(answer.items.map((i) => i.leadId)).toContain('p1');
  });

  it('renders the number rather than "(unnamed)"', async () => {
    const answer = await askCrm('what is going on with 2125559876', 'u1', deps([phoneOnly]));
    const item = answer.items.find((i) => i.leadId === 'p1');
    expect(item).toBeDefined();
    expect(item!.name).toBe('2125559876');
    expect(item!.phone).toBe('2125559876');
    expect(item!.email).toBeNull();
  });

  it('still prefers a real name and email when there is one', async () => {
    const answer = await askCrm('tell me about ada', 'u1', deps([withEmail, phoneOnly]));
    const item = answer.items.find((i) => i.leadId === 'e1');
    expect(item).toBeDefined();
    expect(item!.name).toBe('Ada Lovelace');
    expect(item!.email).toBe('ada@example.com');
  });
});
