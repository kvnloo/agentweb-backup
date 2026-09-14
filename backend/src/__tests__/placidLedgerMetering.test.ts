/** ENG-698 human contract: requesting-user attribution, every egress recorded,
 * fail-open metering, allocated/shared-wallet costs. All external I/O is mocked. */
import axios from 'axios';
import { taskDb, userDb } from '../services/db';
import { getSecret } from '../utils/secretsManager';
import { recordVendorUsage } from '../services/usageRecorderService';
import { computeAllocatedCost } from '../utils/vendorRateCard';
import { getPlacidEditorToken, generateFromTemplateToExecution, listPlacidTemplates } from '../controllers/tasks';

const mockPutObject = jest.fn();
jest.mock('aws-sdk', () => ({ S3: jest.fn(() => ({ putObject: (...args: any[]) => mockPutObject(...args) })) }));
jest.mock('axios');
jest.mock('../services/db', () => ({
  taskDb: { getTaskById: jest.fn(), getTaskExecutionById: jest.fn(), updateTaskExecution: jest.fn() },
  userDb: { getUserById: jest.fn() },
}));
jest.mock('../services/chatbotService', () => ({}));
jest.mock('../services/approvalDb', () => ({}));
jest.mock('../services/orgShareService', () => ({}));
jest.mock('../utils/secretsManager', () => ({ getSecret: jest.fn() }));
jest.mock('../services/usageRecorderService', () => ({ recordVendorUsage: jest.fn() }));
jest.mock('../utils/vendorRateCard', () => ({
  ...jest.requireActual('../utils/vendorRateCard'), computeAllocatedCost: jest.fn(),
}));

const endpoints = [
  ['editor_token', getPlacidEditorToken, 'post', 0],
  ['image_render', generateFromTemplateToExecution, 'get', 0.095],
  ['list_templates', listPlacidTemplates, 'get', 0],
] as const;

function request() {
  return { user: { userId: 'requester', email: 'requester@example.com' },
    params: { id: 'task', executionId: 'execution' }, query: { template_uuid: 'template' },
    body: { template_uuid: 'template', layers: { title: { text: 'Hello' } } } } as any;
}
function response() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res); res.json.mockReturnValue(res);
  return res;
}
beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (getSecret as jest.Mock).mockResolvedValue('secret-token');
  (recordVendorUsage as jest.Mock).mockResolvedValue(undefined);
  (computeAllocatedCost as jest.Mock).mockImplementation(jest.requireActual('../utils/vendorRateCard').computeAllocatedCost);
  (taskDb.getTaskById as jest.Mock).mockResolvedValue({ userId: 'owner' });
  (userDb.getUserById as jest.Mock).mockResolvedValue({ isAdmin: true });
  (taskDb.getTaskExecutionById as jest.Mock).mockResolvedValue({ taskId: 'task', result_files: [] });
  mockPutObject.mockReturnValue({ promise: jest.fn().mockResolvedValue({}) });
  (axios.post as jest.Mock).mockResolvedValue({ data: { access_token: 'editor-token' } });
  (axios.get as jest.Mock).mockResolvedValue({ data: new ArrayBuffer(4), headers: { 'content-type': 'image/png' } });
});
afterEach(() => jest.restoreAllMocks());

describe.each(endpoints)('%s', (operation, handler, method, costUsd) => {
  it('records each call against the requester with allocated cost (AC3/5/7)', async () => {
    await handler(request(), response());
    expect(axios[method]).toHaveBeenCalledTimes(1);
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
    expect(recordVendorUsage).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'requester', provider: 'placid', operation, quantity: 1,
      unit: operation === 'image_render' ? 'render' : 'request', costSource: 'allocated', costUsd,
    }));
  });
  it('records attempted egress even when the vendor rejects (AC5)', async () => {
    (axios[method] as jest.Mock).mockRejectedValue(new Error('vendor failed'));
    const res = response();
    await handler(request(), res);
    expect(recordVendorUsage).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(500);
  });
  it.each(['throw', 'reject', 'pending'])('preserves successful response when metering %s (AC6)', async (failure) => {
    (recordVendorUsage as jest.Mock).mockImplementation(() => {
      if (failure === 'throw') throw new Error('meter failed');
      return failure === 'reject' ? Promise.reject(new Error('meter failed')) : new Promise(() => {});
    });
    const res = response();
    await handler(request(), res);
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(operation === 'image_render'
      ? expect.objectContaining({ resultFile: expect.objectContaining({ file_type: 'image' }) })
      : operation === 'editor_token' ? { token: 'editor-token' } : new ArrayBuffer(4));
  });
  it('does not call the vendor or meter an unauthenticated request', async () => {
    const req = request(); delete req.user;
    const res = response(); await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(axios[method]).not.toHaveBeenCalled();
    expect(recordVendorUsage).not.toHaveBeenCalled();
  });
});

it.each([getPlacidEditorToken, listPlacidTemplates])('uses the migrated Secrets Manager credential', async (handler) => {
  const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  try {
    await handler(request(), response());
    expect(getSecret).toHaveBeenCalledWith('prod/AgentWeb/Placid');
    const calls = [...(axios.post as jest.Mock).mock.calls, ...(axios.get as jest.Mock).mock.calls];
    expect(calls[0].at(-1).headers.Authorization).toBe('Bearer secret-token');
  } finally { process.env.NODE_ENV = previous; }
});

it('returns the render even if the rate card fails (AC6)', async () => {
  (computeAllocatedCost as jest.Mock).mockImplementation(() => { throw new Error('unpriced'); });
  const res = response(); await generateFromTemplateToExecution(request(), res);
  expect(res.status).toHaveBeenCalledWith(200);
  expect(recordVendorUsage).toHaveBeenCalledWith(expect.objectContaining({
    provider: 'placid', operation: 'image_render', costSource: 'allocated', costUsd: 0,
  }));
});

it('retains usage when storage fails after the render (AC3/5)', async () => {
  mockPutObject.mockReturnValue({ promise: jest.fn().mockRejectedValue(new Error('storage failed')) });
  await generateFromTemplateToExecution(request(), response());
  expect(recordVendorUsage).toHaveBeenCalledTimes(1);
});

it.each([getPlacidEditorToken, listPlacidTemplates])('never sends an unconfigured credential to Placid', async (handler) => {
  (getSecret as jest.Mock).mockRejectedValue(new Error('secret unavailable'));
  const res = response(); await handler(request(), res);
  expect(res.status).toHaveBeenCalledWith(500);
  expect(axios.get).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
  expect(recordVendorUsage).not.toHaveBeenCalled();
});

it('does not render or meter when the requester cannot access the task', async () => {
  (userDb.getUserById as jest.Mock).mockResolvedValue({ isAdmin: false });
  const res = response(); await generateFromTemplateToExecution(request(), res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(axios.get).not.toHaveBeenCalled();
  expect(recordVendorUsage).not.toHaveBeenCalled();
});

it('preserves the render URL, upload, and execution attachment', async () => {
  const res = response(); await generateFromTemplateToExecution(request(), res);
  expect(axios.get).toHaveBeenCalledWith(
    'https://api.placid.app/u/template?title%5Btext%5D=Hello', { responseType: 'arraybuffer' },
  );
  expect(mockPutObject).toHaveBeenCalledWith(expect.objectContaining({
    Body: Buffer.from(new Uint8Array(4)), ContentType: 'image/png',
  }));
  expect(taskDb.updateTaskExecution).toHaveBeenCalledWith('execution', {
    result_files: [res.json.mock.calls[0][0].resultFile],
  });
});
