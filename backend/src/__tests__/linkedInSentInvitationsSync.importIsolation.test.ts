const listSentInvitations = jest.fn();
const upsertSentInvitations = jest.fn();
const pruneStaleSentInvitations = jest.fn();
const getAllSentInvitationsByAccount = jest.fn();

jest.mock('../services/linkedInOutreachService', () => ({
  linkedInOutreachService: {
    listSentInvitations: (...args: unknown[]) => listSentInvitations(...args),
  },
}));

jest.mock('../services/unipileSentInvitationsDb', () => ({
  getAllSentInvitationsByAccount: (...args: unknown[]) => getAllSentInvitationsByAccount(...args),
  profileUrlFromPublicId: (publicId: string) => `https://www.linkedin.com/in/${publicId}/`,
  pruneStaleSentInvitations: (...args: unknown[]) => pruneStaleSentInvitations(...args),
  upsertSentInvitations: (...args: unknown[]) => upsertSentInvitations(...args),
}));

describe('ENG-876 sent-invitation sync import isolation', () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENAI_API_KEY;
    getAllSentInvitationsByAccount.mockResolvedValue([]);
    listSentInvitations.mockResolvedValue({ items: [], cursor: undefined });
    upsertSentInvitations.mockResolvedValue(undefined);
    pruneStaleSentInvitations.mockResolvedValue(0);
  });

  afterAll(() => {
    if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiKey;
  });

  it('runs a live cache refresh without loading an OpenAI client', async () => {
    const { syncSentInvitationsForAccount } = await import(
      '../services/linkedInSentInvitationsSyncService'
    );

    await expect(syncSentInvitationsForAccount('acct-1')).resolves.toBe(0);
    expect(listSentInvitations).toHaveBeenCalledWith('acct-1', undefined);
    expect(upsertSentInvitations).toHaveBeenCalledWith([]);
  });
});
