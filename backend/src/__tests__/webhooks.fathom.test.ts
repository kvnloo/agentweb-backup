/**
 * Tests for the Fathom webhook handler at /api/webhooks/fathom.
 *
 * When Fathom sends a webhook for a completed meeting, we:
 * 1. Validate the payload
 * 2. Extract action items from the meeting data
 * 3. Route them via processActionItems
 */

// Mock meetingIntakeService before imports
jest.mock('../services/meetingIntakeService', () => ({
  processActionItems: jest.fn().mockResolvedValue({
    meetingTitle: 'Test Meeting',
    processedAt: '2026-03-16T10:00:00Z',
    created: [],
    skipped: [],
  }),
  classifyActionItem: jest.requireActual('../services/meetingIntakeService').classifyActionItem,
  computeSimilarity: jest.requireActual('../services/meetingIntakeService').computeSimilarity,
  _deps: {
    createNotionTask: jest.fn(),
    createClickUpTask: jest.fn(),
    searchExistingTasks: jest.fn(),
  },
}));

import express from 'express';
import request from 'supertest';
import { processActionItems } from '../services/meetingIntakeService';
import fathomWebhookRouter from '../routes/fathomWebhook';

const mockedProcessActionItems = processActionItems as jest.MockedFunction<typeof processActionItems>;

// Create a minimal Express app for testing
const app = express();
app.use(express.json());
app.use('/api/webhooks/fathom', fathomWebhookRouter);

describe('POST /api/webhooks/fathom', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const validPayload = {
    event: 'recording.ready',
    data: {
      recording_id: 101,
      meeting: {
        id: 1,
        title: 'Sprint Planning',
        created_at: '2026-03-16T10:00:00Z',
        participants: [
          { name: 'Harsha', email: 'harsha@agentweb.pro' },
          { name: 'Rui', email: 'ruiw@agentweb.pro' },
        ],
        action_items: [
          { text: 'Fix the login bug' },
          { text: 'Send proposal to client' },
        ],
      },
    },
  };

  it('processes a valid recording.ready webhook', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'Sprint Planning',
      processedAt: '2026-03-16T10:00:00Z',
      created: [
        { description: 'Fix the login bug', type: 'eng-task', destination: 'notion', externalId: 'n-1' },
      ],
      skipped: [
        { description: 'Send proposal to client', reason: 'ignored' },
      ],
    });

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send(validPayload)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.message).toContain('processed');
    expect(mockedProcessActionItems).toHaveBeenCalledTimes(1);
    expect(mockedProcessActionItems).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingTitle: 'Sprint Planning',
        actionItems: ['Fix the login bug', 'Send proposal to client'],
      })
    );
  });

  it('ignores non-recording.ready events', async () => {
    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send({ event: 'meeting.started', data: {} })
      .expect(200);

    expect(res.body.message).toContain('ignored');
    expect(mockedProcessActionItems).not.toHaveBeenCalled();
  });

  it('returns 400 for missing event field', async () => {
    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send({ data: {} })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it('returns 400 when meeting data is missing', async () => {
    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send({ event: 'recording.ready', data: {} })
      .expect(400);

    expect(res.body.error).toBeDefined();
  });

  it('handles meetings with no action items gracefully', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'Quick Sync',
      processedAt: '2026-03-16T10:00:00Z',
      created: [],
      skipped: [],
    });

    const payload = {
      event: 'recording.ready',
      data: {
        recording_id: 102,
        meeting: {
          id: 2,
          title: 'Quick Sync',
          created_at: '2026-03-16T11:00:00Z',
          participants: [],
          action_items: [],
        },
      },
    };

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send(payload)
      .expect(200);

    expect(res.body.success).toBe(true);
  });

  it('returns 500 when processActionItems throws', async () => {
    mockedProcessActionItems.mockRejectedValue(new Error('Notion API down'));

    const res = await request(app)
      .post('/api/webhooks/fathom')
      .send(validPayload)
      .expect(500);

    expect(res.body.error).toContain('Failed to process');
  });

  it('extracts participant emails correctly', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'Sprint Planning',
      processedAt: '2026-03-16T10:00:00Z',
      created: [],
      skipped: [],
    });

    await request(app)
      .post('/api/webhooks/fathom')
      .send(validPayload)
      .expect(200);

    const callArgs = mockedProcessActionItems.mock.calls[0][0];
    expect(callArgs.participants).toEqual(['harsha@agentweb.pro', 'ruiw@agentweb.pro']);
  });

  it('handles participants without emails', async () => {
    mockedProcessActionItems.mockResolvedValue({
      meetingTitle: 'External Call',
      processedAt: '2026-03-16T10:00:00Z',
      created: [],
      skipped: [],
    });

    const payload = {
      event: 'recording.ready',
      data: {
        recording_id: 103,
        meeting: {
          id: 3,
          title: 'External Call',
          created_at: '2026-03-16T12:00:00Z',
          participants: [
            { name: 'John' },
            { name: 'Jane', email: 'jane@example.com' },
          ],
          action_items: [{ text: 'Follow up on proposal' }],
        },
      },
    };

    await request(app)
      .post('/api/webhooks/fathom')
      .send(payload)
      .expect(200);

    const callArgs = mockedProcessActionItems.mock.calls[0][0];
    expect(callArgs.participants).toEqual(['John', 'jane@example.com']);
  });
});
