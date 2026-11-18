/**
 * For test suites whose subject is NOT the URL guard.
 *
 * Tools fetch a URL a caller chose through `utils/callerUrlFetch.ts` (guarded DNS, redirects re-checked, size cap). That guard has its own
 * suite (`callerUrlFetch.test.ts`) and must never reach real DNS or the network from another suite. These suites used to mock `axios.get`
 * for the download, and their assertions are about what the tool does with the bytes, so this stands in for the wrapper by handing the
 * request to the suite's own `axios.get` mock with the same arguments the tool used to pass. Everything a suite asserted about the
 * download (the URL, `responseType`, `timeout`, rejections, response data) keeps meaning what it meant.
 *
 * Use:
 *   jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
 *   jest.mock('../utils/callerUrlFetch', () => require('./helpers/callerUrlFetchAxiosBridge').callerUrlFetchViaAxiosMock());
 *
 * The real error classes and constants stay real, so a tool's `instanceof` checks still work.
 */
import axios from 'axios';

export function callerUrlFetchViaAxiosMock() {
  const actual = jest.requireActual('../../utils/callerUrlFetch');
  const asBuffer = (data: any): Buffer => (Buffer.isBuffer(data) ? data : Buffer.from(data ?? []));
  return {
    ...actual,
    fetchCallerUrlBuffer: jest.fn(async (url: string, opts: { timeoutMs?: number }) => {
      const response: any = await (axios as any).get(url, { responseType: 'arraybuffer', timeout: opts?.timeoutMs });
      return { buffer: asBuffer(response?.data), contentType: '', finalUrl: url };
    }),
    fetchCallerUrlText: jest.fn(async (url: string, opts: { timeoutMs?: number }) => {
      const response: any = await (axios as any).get(url, { responseType: 'arraybuffer', timeout: opts?.timeoutMs });
      return asBuffer(response?.data).toString('utf8');
    }),
  };
}
