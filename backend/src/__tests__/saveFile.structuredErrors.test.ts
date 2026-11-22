/**
 * ENG-1608: save_file returns structured, actionable errors (error_code +
 * message) for each handler-error class, validates before any storage write,
 * and leaves the success payload unchanged. Storage is mocked; nothing real
 * is written.
 */
const mockUpload = jest.fn();
jest.mock('../utils/s3Utils', () => ({ uploadFileToS3: (...a: any[]) => mockUpload(...a) }));

import { saveFile, SAVE_FILE_MAX_BYTES } from '../emma/impl/misc';

const run = (name: any, content: any) => saveFile(name, content, 'u-test', 's-test', new Map(), () => {});

describe('ENG-1608 save_file structured errors', () => {
  beforeEach(() => mockUpload.mockReset());

  it.each([
    [undefined, 'x', 'MISSING_FILE_NAME'],
    ['   ', 'x', 'MISSING_FILE_NAME'],
    ['../etc/passwd', 'x', 'INVALID_FILE_NAME'],
    ['dir/report.html', 'x', 'INVALID_FILE_NAME'],
    ['a'.repeat(201) + '.txt', 'x', 'INVALID_FILE_NAME'],
    ['r.txt', undefined, 'MISSING_FILE_CONTENT'],
    ['r.txt', { a: 1 }, 'INVALID_FILE_CONTENT'],
    ['r.txt', '   \n', 'EMPTY_FILE_CONTENT'],
  ])('rejects (%p, %p) with %s before any storage write', async (name, content, code) => {
    const r = await run(name, content);
    expect(r).toMatchObject({ success: false, error_code: code });
    expect(typeof r.message).toBe('string');
    expect(r.message.length).toBeGreaterThan(20);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('rejects oversize content before any storage write', async () => {
    const r = await run('big.txt', 'a'.repeat(SAVE_FILE_MAX_BYTES + 1));
    expect(r).toMatchObject({ success: false, error_code: 'FILE_TOO_LARGE' });
    expect(mockUpload).not.toHaveBeenCalled();
  });

  it('maps a storage write failure to STORAGE_WRITE_FAILED', async () => {
    mockUpload.mockResolvedValue({ success: false, error: 'AccessDenied' });
    const r = await run('r.txt', 'hello');
    expect(r).toMatchObject({ success: false, error_code: 'STORAGE_WRITE_FAILED' });
    expect(r.message).toContain('AccessDenied');
  });

  it('maps a thrown storage error to STORAGE_WRITE_FAILED', async () => {
    mockUpload.mockRejectedValue(new Error('socket hang up'));
    const r = await run('r.txt', 'hello');
    expect(r).toMatchObject({ success: false, error_code: 'STORAGE_WRITE_FAILED' });
    expect(r.message).toContain('socket hang up');
  });

  it('control: a valid payload saves and returns the file reference unchanged', async () => {
    mockUpload.mockResolvedValue({ success: true, url: 'https://bucket.s3/u-test/r.md' });
    const r = await run('r.md', '# hi');
    expect(mockUpload).toHaveBeenCalledWith('# hi', 'r.md', 'u-test', 'text/markdown');
    expect(r).toMatchObject({ success: true, file_url: 'https://bucket.s3/u-test/r.md', file_name: 'r.md', file_size: 4 });
    expect(r.error_code).toBeUndefined();
  });
});
