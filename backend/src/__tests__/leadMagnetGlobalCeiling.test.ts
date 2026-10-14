/**
 * ENG-2353: global daily execution ceiling + kill switch for anonymous lead-magnet runs.
 */
jest.mock('../services/db', () => ({
  taskDb: { createTaskExecution: jest.fn(), getTaskExecutionById: jest.fn() },
}));
jest.mock('../services/waitlistDb', () => ({
  waitlistDb: { add: jest.fn(), getByEmail: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import leadMagnetRoutes, {
  dailyEmailTracker,
  dailyIpTracker,
  globalExecutionTimestamps,
} from '../routes/leadMagnet';

const { taskDb } = require('../services/db');
const { waitlistDb } = require('../services/waitlistDb');

function createApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/lead-magnet', leadMagnetRoutes);
  return app;
}

function exec(app: express.Express, i: number) {
  return request(app)
    .post('/api/lead-magnet/execute')
    .set('X-Forwarded-For', `10.0.${Math.floor(i / 250)}.${i % 250}`)
    .send({ email: `user${i}@example.com`, taskInput: 'Build me a page' });
}

describe('lead-magnet global ceiling (ENG-2353)', () => {
  const env = { ...process.env };
  let app: express.Express;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    dailyEmailTracker.clear();
    dailyIpTracker.clear();
    globalExecutionTimestamps.length = 0;
    taskDb.createTaskExecution.mockResolvedValue({});
    waitlistDb.add.mockResolvedValue({});
  });

  afterEach(() => {
    process.env = { ...env };
  });

  it('kill switch returns 503 and writes nothing', async () => {
    process.env.LEAD_MAGNET_EXECUTE_DISABLED = 'true';
    const res = await exec(app, 1);
    expect(res.status).toBe(503);
    expect(taskDb.createTaskExecution).not.toHaveBeenCalled();
    expect(waitlistDb.add).not.toHaveBeenCalled();
  });

  it('caps aggregate executions even across fresh IPs and emails', async () => {
    process.env.LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY = '3';
    for (let i = 0; i < 3; i++) expect((await exec(app, i)).status).toBe(200);
    const res = await exec(app, 99);
    expect(res.status).toBe(429);
    expect(taskDb.createTaskExecution).toHaveBeenCalledTimes(3);
    expect(waitlistDb.add).toHaveBeenCalledTimes(3);
  });

  it('defaults to 50 when env is unset or invalid', async () => {
    process.env.LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY = 'abc';
    const now = Date.now();
    for (let i = 0; i < 50; i++) globalExecutionTimestamps.push(now);
    expect((await exec(app, 1)).status).toBe(429);
    globalExecutionTimestamps.pop();
    expect((await exec(app, 2)).status).toBe(200);
  });

  it('executions older than 24h no longer count', async () => {
    process.env.LEAD_MAGNET_MAX_EXECUTIONS_PER_DAY = '1';
    globalExecutionTimestamps.push(Date.now() - 24 * 60 * 60 * 1000 - 1000);
    expect((await exec(app, 5)).status).toBe(200);
    expect((await exec(app, 6)).status).toBe(429);
  });
});
