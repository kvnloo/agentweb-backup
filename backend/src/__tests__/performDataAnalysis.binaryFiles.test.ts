/**
 * ENG-3151: perform_data_analysis hands every file to Gemini's code-execution sandbox labelled `text/csv`, and Google documents that
 * tool as working best with text and CSV. PDF and Excel files sent this way were answered with HTTP 400 `invalid_argument` after seconds
 * to minutes of upload (4 of the 5 such failures in the 2026-11-11..18 window). They are now refused up front, before any download
 * (by extension) or before the model call (by the file's first bytes), with a message that says what to do instead.
 *
 * The cause of the 400 itself is not proven (no key was available to reproduce it); the refusal is safe either way because those
 * files already fail. Everything is mocked and every fixture is synthetic.
 */
import axios from 'axios';
import { getSecret } from '../utils/secretsManager';
import { getS3ObjectAsString } from '../utils/s3Utils';

jest.mock('../utils/callerUrlFetch', () => require('./helpers/callerUrlFetchAxiosBridge').callerUrlFetchViaAxiosMock());
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../utils/s3Utils', () => ({
  uploadFileToS3: jest.fn().mockResolvedValue({ success: true, url: 'https://example.com/u.png' }),
  getS3ObjectAsString: jest.fn(),
}));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));
jest.mock('../services/storageAccessPolicy', () => ({
  ...jest.requireActual('../services/storageAccessPolicy'),
  decideStorageAccess: jest.fn().mockResolvedValue({ allow: true }),
}));

import { performDataAnalysis, __resetDataAnalysisConsistencyCacheForTests } from '../emma/impl/searchResearch';

const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;
const readS3 = getS3ObjectAsString as jest.Mock;

const SESSION = '11111111-1111-4111-8111-111111111111';
const geminiOk = () => post.mockResolvedValue({
  data: { candidates: [{ content: { parts: [{ text: 'Analysis complete.' }, { codeExecutionResult: { output: 'ok' } }] } }] },
});
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n');
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('xl/workbook.xml')]);
const OLE = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('Workbook')]);

const refused = (r: any, kind: RegExp) => {
  expect(r.success).toBe(false);
  expect(r.errorClass).toBe('invalid_args');
  expect(r.message).toMatch(kind);
  expect(r.message).toMatch(/CSV/);
  expect(post).not.toHaveBeenCalled(); // never reaches the model
};

describe('perform_data_analysis: files the sandbox cannot read', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getSecret as jest.Mock).mockResolvedValue('test-key');
    readS3.mockResolvedValue('a,b\n1,2');
    geminiOk();
    __resetDataAnalysisConsistencyCacheForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  describe('by file name, before anything is downloaded or read', () => {
    it.each([
      ['https://agentweb-user-files.s3.us-west-2.amazonaws.com/users/u/files/1/h/Target_Lists.xlsx', /Excel/],
      ['https://example.com/report.XLSX?X-Amz-Signature=abc', /Excel/],
      ['https://example.com/old.xls', /Excel/],
      ['https://example.com/deck.pdf', /PDF/],
      ['https://example.com/deck.PDF#page=2', /PDF/],
      ['https://example.com/notes.docx', /Word/],
      ['https://example.com/archive.zip', /zip/i],
    ])('refuses %s without downloading it', async (url, kind) => {
      const r = await performDataAnalysis([url], 'summarise', 'me');
      refused(r, kind);
      expect(get).not.toHaveBeenCalled();
    });

    it('refuses an s3:// key and a tool-responses key by name, without reading them', async () => {
      refused(await performDataAnalysis(['s3://agentweb-user-files/users/me/files/1/h/data.xlsx'], 'x', 'me'), /Excel/);
      refused(await performDataAnalysis([`tool-responses/${SESSION}/report.pdf`], 'x', 'me'), /PDF/);
      expect(readS3).not.toHaveBeenCalled();
    });

    it('names the offending entry and keeps checking the others (one bad entry refuses the call)', async () => {
      const r = await performDataAnalysis(['https://example.com/ok.csv', 'https://example.com/bad.pdf'], 'x', 'me');
      refused(r, /bad\.pdf/);
    });
  });

  describe('by the first bytes, when the name says nothing', () => {
    it.each([
      ['a PDF', PDF, /PDF/],
      ['a zip-based Office file', ZIP, /Excel|Word|zip/i],
      ['a legacy Office file', OLE, /Office|Excel/i],
    ])('refuses %s served from an extensionless URL, before the model call', async (_n, body, kind) => {
      get.mockResolvedValue({ data: body, status: 200, headers: {} });
      const r = await performDataAnalysis(['https://example.com/download?id=42'], 'summarise', 'me');
      refused(r, kind);
      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  describe('what must keep working', () => {
    it('analyses a CSV', async () => {
      get.mockResolvedValue({ data: Buffer.from('a,b\n1,2\n'), status: 200, headers: {} });
      const r = await performDataAnalysis(['https://example.com/data.csv'], 'summarise', 'me');
      expect(r.success).not.toBe(false);
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not read ".pdf" in a query string or a folder name as the file type', async () => {
      get.mockResolvedValue({ data: Buffer.from('a,b\n1,2\n'), status: 200, headers: {} });
      await performDataAnalysis(['https://example.com/pdf-exports/data.csv?src=report.pdf'], 'summarise', 'me');
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('does not mistake text that merely starts with "PK" or mentions %PDF for a binary file', async () => {
      get.mockResolvedValue({ data: Buffer.from('PK,name\n1,x\n'), status: 200, headers: {} });
      await performDataAnalysis(['https://example.com/data'], 'summarise', 'me');
      expect(post).toHaveBeenCalledTimes(1);
    });

    it('still lets inline data through with no files', async () => {
      const r = await performDataAnalysis([], 'sum 1,2,3', 'me');
      expect(r.success).not.toBe(false);
    });
  });
});
