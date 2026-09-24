import { buildDriveAccessInventory, DriveListClient } from '../services/integrationAccessService';

const now = () => new Date('2026-09-23T00:00:00Z');

function fakeDrive(folders: any[][], drives: any[] = [], failDrives = false): DriveListClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    drives: {
      list: async (p: any) => {
        calls.push(['drives', p]);
        if (failDrives) throw Object.assign(new Error('x'), { response: { status: 403 } });
        return { data: { drives } };
      },
    },
    files: {
      list: async (p: any) => {
        calls.push(['files', p]);
        const idx = p.pageToken ? Number(p.pageToken) : 0;
        return { data: { files: folders[idx], nextPageToken: idx + 1 < folders.length ? String(idx + 1) : undefined } };
      },
    },
  };
}

describe('ENG-2118 Drive access inventory', () => {
  it('reports disconnected without provider calls', async () => {
    const inv = await buildDriveAccessInventory(null, null, now);
    expect(inv).toMatchObject({ connected: false, folders: [], sharedDrives: [], checkedAt: '2026-09-23T00:00:00.000Z' });
  });

  it('lists only folders the token can see, across pages, with identity', async () => {
    const d = fakeDrive([[{ id: 'a', name: 'Emma Approved' }], [{ id: 'b', name: 'Briefs' }]], [{ id: 'sd', name: 'Marketing' }]);
    const inv = await buildDriveAccessInventory(d, 'agentwebintegration@xcures.ai', now);
    expect(inv.identity).toEqual({ email: 'agentwebintegration@xcures.ai' });
    expect(inv.folders.map((f) => f.name)).toEqual(['Emma Approved', 'Briefs']);
    expect(inv.sharedDrives).toEqual([{ id: 'sd', name: 'Marketing', type: 'workspace' }]);
    // folder-only query: never enumerates file contents
    const fileCalls = d.calls.filter((c) => c[0] === 'files');
    expect(fileCalls.every((c) => c[1].q.includes("mimeType='application/vnd.google-apps.folder'"))).toBe(true);
    expect(inv.truncated).toBe(false);
  });

  it('records a per-section error instead of failing the whole inventory', async () => {
    const inv = await buildDriveAccessInventory(fakeDrive([[{ id: 'a', name: 'A' }]], [], true), 'x@y', now);
    expect(inv.errors).toEqual(['shared drives: HTTP 403']);
    expect(inv.folders).toHaveLength(1);
  });

  it('caps and flags truncation', async () => {
    const page = Array.from({ length: 600 }, (_, i) => ({ id: String(i), name: 'f' + i }));
    const inv = await buildDriveAccessInventory(fakeDrive([page, page, page]), null, now);
    expect(inv.folders).toHaveLength(1000);
    expect(inv.truncated).toBe(true);
  });
});
