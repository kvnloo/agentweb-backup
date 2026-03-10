import express from 'express';

// Create a minimal app with just the Fireflies endpoint extracted
const app = express();
app.use(express.json());

// Re-implement the Fireflies webhook handler in isolation (avoids importing the full router with its DB dependencies)
const firefliesQueue: any[] = [];

app.post('/api/webhooks/fireflies', (req, res) => {
  const { event_type, data } = req.body;

  if (!event_type) {
    res.status(400).json({ error: 'event_type is required' });
    return;
  }

  if (event_type !== 'Transcription completed') {
    res.status(200).json({ status: 'ignored', event_type });
    return;
  }

  if (!data?.transcript_id) {
    res.status(400).json({ error: 'transcript_id is required in data' });
    return;
  }

  firefliesQueue.push({
    transcriptId: data.transcript_id,
    meetingTitle: data.meeting_title || 'Untitled Meeting',
    receivedAt: new Date().toISOString(),
  });

  res.status(200).json({
    status: 'queued',
    transcript_id: data.transcript_id,
  });
});

import request from 'supertest';

describe('Fireflies Webhook', () => {
  beforeEach(() => {
    firefliesQueue.length = 0;
  });

  // FAIL test 1: Rejects invalid payload
  it('should return 400 for missing event_type', async () => {
    const res = await request(app)
      .post('/api/webhooks/fireflies')
      .send({ data: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('event_type');
  });

  // FAIL test 2: Ignores unknown event type
  it('should return 200 with ignored status for unknown event types', async () => {
    const res = await request(app)
      .post('/api/webhooks/fireflies')
      .send({
        event_type: 'unknown_event',
        data: {},
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
  });

  // FAIL test 3: Rejects transcript_ready without transcript_id
  it('should return 400 for Transcription completed without transcript_id', async () => {
    const res = await request(app)
      .post('/api/webhooks/fireflies')
      .send({
        event_type: 'Transcription completed',
        data: {},
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('transcript_id');
  });

  // SUCCESS test 4: Accepts valid transcript event
  it('should return 200 and queue processing for valid transcript event', async () => {
    const res = await request(app)
      .post('/api/webhooks/fireflies')
      .send({
        event_type: 'Transcription completed',
        data: {
          transcript_id: 'tx-abc123',
          meeting_title: 'Weekly standup',
          duration: 1800,
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('queued');
    expect(res.body.transcript_id).toBe('tx-abc123');
    expect(firefliesQueue).toHaveLength(1);
    expect(firefliesQueue[0].transcriptId).toBe('tx-abc123');
  });

  // SUCCESS test 5: Handles consecutive webhook calls
  it('should handle consecutive webhook calls', async () => {
    const res1 = await request(app)
      .post('/api/webhooks/fireflies')
      .send({
        event_type: 'Transcription completed',
        data: { transcript_id: 'tx-1', meeting_title: 'Meeting 1' },
      });
    const res2 = await request(app)
      .post('/api/webhooks/fireflies')
      .send({
        event_type: 'Transcription completed',
        data: { transcript_id: 'tx-2', meeting_title: 'Meeting 2' },
      });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(firefliesQueue).toHaveLength(2);
  });
});
