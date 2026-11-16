import { browseDrive, clampDrivePageSize, isValidDriveId, DriveListClient } from '../services/integrationAccessService';

const now = () => new Date('2026-10-22T00:00:00Z');
const FOLDER = 'application/vnd.google-apps.folder';

function fakeDrive(opts: { files?: any[]; drives?: any[]; driveNext?: string[]; next?: string; failFiles?: boolean; failDrives?: boolean } = {}): DriveListClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    drives: {
      list: async (p: any) => {
        calls.push(['drives', p]);
        if (opts.failDrives) throw Object.assign(new Error('x'), { response: { status: 403 } });
        const idx = p.pageToken ? Number(p.pageToken) : 0;
        const pages = opts.driveNext ? (opts.driveNext as unknown as any[][]) : [opts.drives || []];
        return { data: { drives: pages[idx] || [], nextPageToken: idx + 1 < pages.length ? String(idx + 1) : undefined } };
      },
    },
    files: {
      list: async (p: any) => {
        calls.push(['files', p]);
        if (opts.failFiles) throw Object.assign(new Error('x'), { response: { status: 403 } });
        return { data: { files: opts.files || [], nextPageToken: opts.next } };
      },
    },
  };
}

describe('ENG-2118 Drive browse', () => {
  it('reports disconnected without provider calls', async () => {
    const r = await browseDrive(null, null, {}, now);
    expect(r).toMatchObject({ connected: false, items: [], nextPageToken: null });
  });

  it('top level: shared drives first, then root + shared-with-me items, tagged by origin, name fields only', async () => {
    const d = fakeDrive({
      drives: [{ id: 'sd', name: 'Marketing' }],
      files: [
        { id: 'f1', name: 'Mine', mimeType: FOLDER, ownedByMe: true, shared: false },
        { id: 'f2', name: 'From a teammate', mimeType: FOLDER, ownedByMe: false, shared: true },
        { id: 'f3', name: 'I shared this', mimeType: 'application/pdf', ownedByMe: true, shared: true },
      ],
      next: 'tok2',
    });
    const r = await browseDrive(d, 'a@b.com', { pageSize: 100 }, now);
    expect(r.items).toEqual([
      { id: 'sd', name: 'Marketing', kind: 'drive' },
      { id: 'f1', name: 'Mine', kind: 'folder' },
      { id: 'f2', name: 'From a teammate', kind: 'folder', shared: 'with_me' },
      { id: 'f3', name: 'I shared this', kind: 'file', shared: 'by_me' },
    ]);
    expect(r.nextPageToken).toBe('tok2');
    expect(r.identity).toEqual({ email: 'a@b.com' });
    const files = d.calls.find((c) => c[0] === 'files')![1];
    expect(files.q).toBe("('root' in parents or sharedWithMe=true) and trashed=false");
    expect(files.pageSize).toBe(100);
    expect(files).toMatchObject({ orderBy: 'folder,name', corpora: 'allDrives', supportsAllDrives: true, includeItemsFromAllDrives: true });
    expect(files.fields).toBe('nextPageToken, files(id, name, mimeType, ownedByMe, shared)');
  });

  it('pages through every shared drive on the first page, up to the cap', async () => {
    const mk = (n: number, off: number) => Array.from({ length: n }, (_, i) => ({ id: 'd' + (off + i), name: 'Drive ' + (off + i) }));
    const r = await browseDrive(fakeDrive({ driveNext: [mk(100, 0), mk(30, 100)] as any, files: [] }), null, {}, now);
    expect(r.items.filter((i) => i.kind === 'drive')).toHaveLength(130);
    expect(r.errors).toEqual([]);
    const many = await browseDrive(fakeDrive({ driveNext: Array.from({ length: 6 }, (_, i) => mk(100, i * 100)) as any, files: [] }), null, {}, now);
    expect(many.items.filter((i) => i.kind === 'drive')).toHaveLength(500);
    expect(many.errors).toEqual(['shared drives: showing the first 500']);
  });

  it('later top-level pages skip shared drives', async () => {
    const d = fakeDrive({ drives: [{ id: 'sd', name: 'Marketing' }], files: [{ id: 'f', name: 'F', mimeType: FOLDER }] });
    const r = await browseDrive(d, null, { pageToken: 'tok2' }, now);
    expect(d.calls.some((c) => c[0] === 'drives')).toBe(false);
    expect(r.items.map((i) => i.id)).toEqual(['f']);
  });

  it('opens a folder by id', async () => {
    const d = fakeDrive();
    await browseDrive(d, null, { parent: 'abc_123' }, now);
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0][1].q).toBe("'abc_123' in parents and trashed=false");
  });

  it('a shared-drives failure does not hide the rest of the top level', async () => {
    const r = await browseDrive(fakeDrive({ failDrives: true, files: [{ id: 'f', name: 'F', mimeType: FOLDER }] }), null, {}, now);
    expect(r.errors).toEqual(['shared drives: HTTP 403']);
    expect(r.items.map((i) => i.id)).toEqual(['f']);
  });

  it('records a listing failure instead of throwing', async () => {
    const r = await browseDrive(fakeDrive({ failFiles: true }), null, { parent: 'p1' }, now);
    expect(r.errors).toEqual(['folder: HTTP 403']);
    expect(r.items).toEqual([]);
  });

  it('only allows 50/100/200 and safe ids', () => {
    expect(clampDrivePageSize(100)).toBe(100);
    expect(clampDrivePageSize('200')).toBe(200);
    expect(clampDrivePageSize(5000)).toBe(50);
    expect(clampDrivePageSize(undefined)).toBe(50);
    expect(isValidDriveId('1AbC-_x')).toBe(true);
    expect(isValidDriveId("x' or '1'='1")).toBe(false);
    expect(isValidDriveId('')).toBe(false);
  });

  it('never puts a provider message into errors[] (it is logged, not returned)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d: DriveListClient = {
      drives: { list: async () => ({ data: {} }) },
      files: { list: async () => { throw new Error('invalid_grant: token has been revoked for aseth@argusoft.com'); } },
    };
    const r = await browseDrive(d, null, { parent: 'p1' }, now);
    expect(r.errors).toEqual(['folder: request failed']);
    expect(JSON.stringify(r)).not.toContain('invalid_grant');
    expect(warn).toHaveBeenCalledWith('[IntegrationAccess] provider call failed:', expect.stringContaining('invalid_grant'));
    warn.mockRestore();
  });

  it('keeps a bare network error code, which carries no provider text', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const d: DriveListClient = {
      drives: { list: async () => ({ data: {} }) },
      files: { list: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND www.googleapis.com'), { code: 'ENOTFOUND' }); } },
    };
    const r = await browseDrive(d, null, {}, now);
    expect(r.errors).toEqual(['top level: ENOTFOUND']);
    warn.mockRestore();
  });
});
