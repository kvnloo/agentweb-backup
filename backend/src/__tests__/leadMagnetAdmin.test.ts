import express from 'express';
import request from 'supertest';

// Mock the db module before importing route
const mockCreate = jest.fn();
const mockListAll = jest.fn();
const mockGetById = jest.fn();
const mockUpdate = jest.fn();
const mockDeleteById = jest.fn();

jest.mock('../services/leadMagnetConfigDb', () => ({
  getLeadMagnetConfigDb: () => ({
    create: mockCreate,
    listAll: mockListAll,
    getById: mockGetById,
    update: mockUpdate,
    deleteById: mockDeleteById,
  }),
}));

import leadMagnetAdmin from '../routes/leadMagnetAdmin';

// Standalone app — no auth middleware (tested separately)
const app = express();
app.use(express.json());
app.use('/api/admin/lead-magnets', leadMagnetAdmin);

describe('Lead Magnet Admin Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  // FAIL test 1: POST missing name → 400
  it('POST / returns 400 when name is missing', async () => {
    const res = await request(app)
      .post('/api/admin/lead-magnets')
      .send({ taskTemplateId: 'tpl-1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('name');
  });

  // FAIL test 2: POST missing taskTemplateId → 400
  it('POST / returns 400 when taskTemplateId is missing', async () => {
    const res = await request(app)
      .post('/api/admin/lead-magnets')
      .send({ name: 'Test' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('taskTemplateId');
  });

  // FAIL test 3: GET /:id returns 404 for missing config
  it('GET /:id returns 404 when not found', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await request(app).get('/api/admin/lead-magnets/nonexistent');
    expect(res.status).toBe(404);
  });

  // FAIL test 4: PUT /:id returns 404 for missing config
  it('PUT /:id returns 404 when not found', async () => {
    mockUpdate.mockRejectedValue(new Error('Config not found: abc'));
    const res = await request(app)
      .put('/api/admin/lead-magnets/abc')
      .send({ name: 'Updated' });
    expect(res.status).toBe(404);
  });

  // SUCCESS test 5: POST creates config
  it('POST / creates config and returns 201', async () => {
    const created = {
      configId: 'cfg-1',
      name: 'Audit',
      taskTemplateId: 'tpl-1',
      resultGate: 'blur',
      createdAt: 'now',
      updatedAt: 'now',
    };
    mockCreate.mockResolvedValue(created);

    const res = await request(app)
      .post('/api/admin/lead-magnets')
      .send({ name: 'Audit', taskTemplateId: 'tpl-1' });

    expect(res.status).toBe(201);
    expect(res.body.configId).toBe('cfg-1');
    expect(mockCreate).toHaveBeenCalled();
  });

  // SUCCESS test 6: GET / lists all configs
  it('GET / lists all configs', async () => {
    mockListAll.mockResolvedValue([{ configId: 'c1' }, { configId: 'c2' }]);
    const res = await request(app).get('/api/admin/lead-magnets');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });

  // SUCCESS test 7: GET /:id returns config
  it('GET /:id returns config when found', async () => {
    mockGetById.mockResolvedValue({ configId: 'c1', name: 'Test' });
    const res = await request(app).get('/api/admin/lead-magnets/c1');
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Test');
  });

  // SUCCESS test 8: PUT /:id updates config
  it('PUT /:id updates config', async () => {
    mockUpdate.mockResolvedValue({ configId: 'c1', name: 'Updated' });
    const res = await request(app)
      .put('/api/admin/lead-magnets/c1')
      .send({ name: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated');
  });

  // SUCCESS test 9: DELETE /:id deletes config
  it('DELETE /:id deletes config', async () => {
    mockDeleteById.mockResolvedValue(undefined);
    const res = await request(app).delete('/api/admin/lead-magnets/c1');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});
