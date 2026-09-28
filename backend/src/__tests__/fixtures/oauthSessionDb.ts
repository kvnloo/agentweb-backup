/** Stateful database fake shared by the unchanged route characterizations. */
export function createOAuthSessionDbMock() {
  const rows = new Map<string, any>();
  return {
    save: jest.fn(async (session: any) => {
      rows.set(session.sessionId, { ...session, ttl: Math.floor(Date.now() / 1000) + 600 });
    }),
    consume: jest.fn(async (sessionId: string, userId: string, provider: string) => {
      const row = rows.get(sessionId);
      if (!row || row.userId !== userId || row.provider !== provider || row.ttl <= Math.floor(Date.now() / 1000)) return null;
      rows.delete(sessionId);
      return row;
    }),
    rows,
  };
}
