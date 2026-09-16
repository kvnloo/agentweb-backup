/**
 * ENG-1957 — "Edit with Placid" for an image generated inside an Emma chat.
 *
 * The Images page groups chat images under synthetic ids (`agent-mode-<sessionId>`
 * / `<sessionId>-images`). Nothing in AW-Tasks or AW-TaskExecutions matches those,
 * so every such render used to 404 before Placid was called — which is also why
 * production had zero Placid renders and zero Placid spend events (ENG-698).
 *
 * What these tests pin, in the ticket's terms:
 *   AC1  a chat image renders and is persisted where the Images page reads it
 *   AC2  a caller cannot render against someone else's session
 *   AC3  exactly one Placid ledger event, billed to the session owner
 *   AC4  renders against real task executions are unchanged
 */

const mockPutObject = jest.fn();
jest.mock('aws-sdk', () => {
  const S3 = jest.fn(() => ({
    putObject: (...a: any[]) => ({ promise: () => mockPutObject(...a) }),
  }));
  const SecretsManager = jest.fn(() => ({
    getSecretValue: () => ({ promise: () => Promise.resolve({}) }),
  }));
  const DynamoDB = { DocumentClient: jest.fn(() => ({})) };
  return { __esModule: true, default: { S3, SecretsManager, DynamoDB }, S3, SecretsManager, DynamoDB };
});

import { parseAgentModeImageIds } from '../utils/agentModeAssetIds';

describe('parseAgentModeImageIds (ENG-1957)', () => {
  it('resolves a matching agent-mode image pair to its session id', () => {
    expect(parseAgentModeImageIds('agent-mode-sess-1', 'sess-1-images')).toBe('sess-1');
  });

  it('rejects a pair whose two ids name different sessions', () => {
    // The session-path equivalent of the task path's execution.taskId !== taskId:
    // without it, authorization on one session could aim the write at another.
    expect(parseAgentModeImageIds('agent-mode-sess-1', 'sess-2-images')).toBeNull();
  });

  it('leaves real task ids alone', () => {
    expect(parseAgentModeImageIds('task-1', 'exec-1')).toBeNull();
    expect(parseAgentModeImageIds('task-1', 'sess-1-images')).toBeNull();
    expect(parseAgentModeImageIds('agent-mode-sess-1', 'exec-1')).toBeNull();
  });

  it('strips affixes positionally, so a session id containing "-images" survives', () => {
    // `executionId.replace('-images', '')` — what the favorite/archive endpoints
    // still do — would mangle this one into 'sess'.
    expect(parseAgentModeImageIds('agent-mode-sess-images-9', 'sess-images-9-images')).toBe(
      'sess-images-9',
    );
  });

  it('rejects an empty session id', () => {
    expect(parseAgentModeImageIds('agent-mode-', '-images')).toBeNull();
  });
});

describe('Placid render for agent-mode images (ENG-1957)', () => {
  let generateFromTemplateToExecution: any;
  const mockRecordVendorUsage = jest.fn();
  const mockAxiosGet = jest.fn();
  const mockGetTask = jest.fn();
  const mockGetExecution = jest.fn();
  const mockUpdateExecution = jest.fn();
  const mockGetUser = jest.fn();
  const mockGetChatSession = jest.fn();
  const mockAddMessageToSession = jest.fn();
  const mockUploadFileToS3 = jest.fn();

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('../services/usageRecorderService', () => ({
        recordVendorUsage: (...a: any[]) => mockRecordVendorUsage(...a),
      }));
      jest.doMock('../utils/secretsManager', () => ({ getPlacidPrivateToken: jest.fn() }));
      jest.doMock('axios', () => ({
        __esModule: true,
        default: { get: (...a: any[]) => mockAxiosGet(...a), post: jest.fn() },
      }));
      jest.doMock('../services/db', () => ({
        taskDb: {
          getTaskById: (...a: any[]) => mockGetTask(...a),
          getTaskExecutionById: (...a: any[]) => mockGetExecution(...a),
          updateTaskExecution: (...a: any[]) => mockUpdateExecution(...a),
        },
        userDb: { getUserById: (...a: any[]) => mockGetUser(...a) },
        orgDb: {}, scheduleDb: {}, taskTemplateDb: {},
      }));
      jest.doMock('../services/chatbotService', () => ({
        chatbotDb: {
          getChatSession: (...a: any[]) => mockGetChatSession(...a),
          addMessageToSession: (...a: any[]) => mockAddMessageToSession(...a),
        },
      }));
      jest.doMock('../utils/s3Utils', () => ({
        uploadFileToS3: (...a: any[]) => mockUploadFileToS3(...a),
      }));
      jest.doMock('../services/approvalDb', () => ({ getAssetTypeFromFilename: jest.fn() }));
      jest.doMock('../services/orgShareService', () => ({ canViewItem: jest.fn(), canEditItem: jest.fn() }));
      const ctrl = require('../controllers/tasks');
      generateFromTemplateToExecution = ctrl.generateFromTemplateToExecution;
    });
  });

  const res = () => {
    const r: any = {};
    r.status = jest.fn(() => r);
    r.json = jest.fn(() => r);
    return r;
  };
  const agentModeReq = (userId = 'owner-1', sessionId = 'sess-1') =>
    ({
      user: { userId },
      params: { id: `agent-mode-${sessionId}`, executionId: `${sessionId}-images` },
      body: {
        template_uuid: 'tpl-abcdef12',
        layers: {},
        source_image_url: 'https://example.invalid/source.png',
        original_filename: 'ad.png',
      },
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockGetUser.mockResolvedValue({ userId: 'owner-1', isAdmin: false });
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'owner-1' });
    mockAddMessageToSession.mockResolvedValue({});
    mockUploadFileToS3.mockResolvedValue({
      success: true,
      url: 'https://bucket.s3.us-west-2.amazonaws.com/users/owner-1/files/1/ad-placid-tpl-abcd.png',
    });
    mockAxiosGet.mockResolvedValue({ data: new ArrayBuffer(8), headers: { 'content-type': 'image/png' } });
    mockGetTask.mockResolvedValue({ taskId: 'task-1', userId: 'owner-1' });
    mockGetExecution.mockResolvedValue({ taskId: 'task-1', result_files: [] });
    mockUpdateExecution.mockResolvedValue(undefined);
    mockPutObject.mockResolvedValue({});
  });

  // AC1
  it('renders a chat image and persists it where the Images page reads it', async () => {
    const r = res();
    await generateFromTemplateToExecution(agentModeReq(), r);

    expect(r.status).toHaveBeenCalledWith(200);
    // The synthetic id is never looked up as a task — that lookup is the 404.
    expect(mockGetTask).not.toHaveBeenCalled();
    expect(mockGetExecution).not.toHaveBeenCalled();
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);

    // Filed under the session OWNER, so it lands on their Images page.
    expect(mockUploadFileToS3).toHaveBeenCalledWith(
      expect.any(Buffer),
      'ad-placid-tpl-abcd.png',
      'owner-1',
      'image/png',
    );

    // Agent-mode images are derived by scanning session messages, so the render
    // is persisted as one, in the shape scanMessagesForAssets recognizes.
    expect(mockAddMessageToSession).toHaveBeenCalledTimes(1);
    const [sessionId, message] = mockAddMessageToSession.mock.calls[0];
    expect(sessionId).toBe('sess-1');
    const toolCall = message.metadata.toolCalls[0];
    expect(toolCall.name).toBe('upload_image');
    expect(toolCall.result.success).toBe(true);
    expect(toolCall.result.imageUrl).toBe(
      'https://bucket.s3.us-west-2.amazonaws.com/users/owner-1/files/1/ad-placid-tpl-abcd.png',
    );
    expect(message.metadata.portalType).toBe('agent');

    // No task execution is written for a chat image.
    expect(mockUpdateExecution).not.toHaveBeenCalled();

    // The response carries the URL the dialog previews.
    const body = r.json.mock.calls[0][0];
    expect(body.resultFile.url).toBe(toolCall.result.imageUrl);
    expect(body.resultFile.source).toBe('agent-mode');
    expect(body.resultFile.sessionId).toBe('sess-1');
  });

  // AC3
  it('records exactly one render, billed to the session owner', async () => {
    const r = res();
    await generateFromTemplateToExecution(agentModeReq('owner-1'), r);

    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'owner-1',
        billingUserId: 'owner-1',
        sessionId: 'sess-1',
        provider: 'placid',
        operation: 'image_render',
        unit: 'render',
        quantity: 1,
        rateKey: 'image_render',
      }),
    );
    expect(mockRecordVendorUsage.mock.calls[0][0].onBehalfOf).toBeUndefined();
  });

  it('bills the session owner, not the admin who rendered it for them', async () => {
    mockGetUser.mockResolvedValue({ userId: 'admin-1', isAdmin: true });
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'customer-1' });
    const r = res();
    await generateFromTemplateToExecution(agentModeReq('admin-1'), r);

    expect(r.status).toHaveBeenCalledWith(200);
    const ctx = mockRecordVendorUsage.mock.calls[0][0];
    expect(ctx.billingUserId).toBe('customer-1');
    expect(ctx.userId).toBe('admin-1');
    expect(ctx.onBehalfOf).toBe('admin-1');
    // The image belongs to the customer's chat, not the admin's file space.
    expect(mockUploadFileToS3.mock.calls[0][2]).toBe('customer-1');
  });

  // AC2
  it('refuses to render against another user\'s session, before calling Placid', async () => {
    mockGetUser.mockResolvedValue({ userId: 'intruder-1', isAdmin: false });
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: 'owner-1' });
    const r = res();
    await generateFromTemplateToExecution(agentModeReq('intruder-1'), r);

    expect(r.status).toHaveBeenCalledWith(403);
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
    expect(mockAddMessageToSession).not.toHaveBeenCalled();
  });

  it('404s when the session does not exist', async () => {
    mockGetChatSession.mockResolvedValue(undefined);
    const r = res();
    await generateFromTemplateToExecution(agentModeReq(), r);

    expect(r.status).toHaveBeenCalledWith(404);
    expect(r.json).toHaveBeenCalledWith({ message: 'Session not found' });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it('does not treat a mismatched id pair as an agent-mode render', async () => {
    // Authorized for sess-1, aimed at sess-2: must not resolve to either session.
    const r = res();
    mockGetTask.mockResolvedValue(undefined);
    await generateFromTemplateToExecution(
      {
        user: { userId: 'owner-1' },
        params: { id: 'agent-mode-sess-1', executionId: 'sess-2-images' },
        body: { template_uuid: 'tpl-abcdef12', layers: {} },
      } as any,
      r,
    );

    expect(mockGetChatSession).not.toHaveBeenCalled();
    expect(r.status).toHaveBeenCalledWith(404);
    expect(r.json).toHaveBeenCalledWith({ message: 'Task not found' });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  // AC4
  it('leaves the real-task render path unchanged', async () => {
    const r = res();
    await generateFromTemplateToExecution(
      {
        user: { userId: 'owner-1' },
        params: { id: 'task-1', executionId: 'exec-1' },
        body: { template_uuid: 'tpl-abcdef12', layers: {}, original_filename: 'ad.png' },
      } as any,
      r,
    );

    expect(r.status).toHaveBeenCalledWith(200);
    // Still S3-put under the task key and appended to result_files...
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    expect(mockPutObject.mock.calls[0][0].Key).toContain('tasks/task-1/executions/exec-1/edits/');
    expect(mockUpdateExecution).toHaveBeenCalledTimes(1);
    expect(mockUpdateExecution.mock.calls[0][1].result_files).toHaveLength(1);
    // ...and no chat session is touched.
    expect(mockGetChatSession).not.toHaveBeenCalled();
    expect(mockAddMessageToSession).not.toHaveBeenCalled();
    expect(mockUploadFileToS3).not.toHaveBeenCalled();
    expect(mockRecordVendorUsage.mock.calls[0][0].sessionId).toBeUndefined();
  });

  // CodeRabbit, PR #2935. An owner-less session row would otherwise sail past the
  // owner comparison for an admin caller and become both the S3 folder and the
  // billing subject: `users/undefined/...`, billed to "undefined".
  it.each([
    ['missing', undefined],
    ['null', null],
    ['blank', '   '],
    ['non-string', 42],
  ])('refuses to render against a session whose owner is %s', async (_label, owner) => {
    mockGetUser.mockResolvedValue({ userId: 'admin-1', isAdmin: true });
    mockGetChatSession.mockResolvedValue({ sessionId: 'sess-1', userId: owner as any });
    const r = res();
    await generateFromTemplateToExecution(agentModeReq('admin-1'), r);

    expect(r.status).toHaveBeenCalledWith(500);
    expect(mockAxiosGet).not.toHaveBeenCalled();
    expect(mockRecordVendorUsage).not.toHaveBeenCalled();
    expect(mockUploadFileToS3).not.toHaveBeenCalled();
  });

  // Greptile, PR #2935. Past the render the customer has already been billed, so
  // a lost attach must not be reported as an anonymous 500.
  it('retries a transient attach failure rather than orphaning a billed render', async () => {
    const transient: any = new Error('throughput exceeded');
    transient.code = 'ProvisionedThroughputExceededException';
    mockAddMessageToSession.mockRejectedValueOnce(transient).mockResolvedValueOnce({});
    const r = res();
    await generateFromTemplateToExecution(agentModeReq(), r);

    expect(mockAddMessageToSession).toHaveBeenCalledTimes(2);
    expect(r.status).toHaveBeenCalledWith(200);
    // One render, one charge — the retry is of the write, not of Placid.
    expect(mockAxiosGet).toHaveBeenCalledTimes(1);
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });

  it('reports the image when it could not be attached, instead of a bare 500', async () => {
    mockAddMessageToSession.mockRejectedValue(new Error('Session not found'));
    const r = res();
    await generateFromTemplateToExecution(agentModeReq(), r);

    // A permanent failure is not retried — a slower failure helps nobody.
    expect(mockAddMessageToSession).toHaveBeenCalledTimes(1);
    expect(r.status).toHaveBeenCalledWith(500);
    const body = r.json.mock.calls[0][0];
    expect(body.message).toMatch(/could not be saved/i);
    // The URL of the paid render still reaches the caller for recovery.
    expect(body.resultFile.url).toContain('ad-placid-tpl-abcd.png');
  });

  it('serves no image when the S3 upload fails', async () => {
    mockUploadFileToS3.mockResolvedValue({ success: false, error: 'denied' });
    const r = res();
    await generateFromTemplateToExecution(agentModeReq(), r);

    expect(r.status).toHaveBeenCalledWith(500);
    expect(mockAddMessageToSession).not.toHaveBeenCalled();
    // The render still happened upstream, so it stays metered (ENG-698's rule:
    // a returned Placid image is a billed image).
    expect(mockRecordVendorUsage).toHaveBeenCalledTimes(1);
  });
});
