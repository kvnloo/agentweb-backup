import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { evaluationRoutes, evaluationAdminRoutes } from '../routes/evaluation';
import { evaluationHttpBoundary } from '../middleware/evaluation';
import { evaluationStore } from '../services/evaluationStore';

jest.mock('../config/jwt', () => ({ getJwtSecret: () => 'synthetic-route-signing-secret' }));
jest.mock('../services/evaluationService', () => ({ runEvaluation: jest.fn() }));
jest.mock('../services/db', () => ({ userDb: {
  getUserById: jest.fn(async (userId: string) => ({ userId, email: 'test@example.invalid', isAdmin: userId === 'admin' })),
  getUserByEmailConsistent: jest.fn(async () => ({ userId: 'eval_test', email: 'test@example.invalid', isActive: true, isAdmin: false })),
} }));
jest.mock('../services/evaluationStore', () => ({ evaluationStore: { get: jest.fn(), provision: jest.fn(), revoke: jest.fn(), saveArtifact: jest.fn(), getArtifact: jest.fn() } }));

describe('ENG-1870 product lifecycle and artifact routes', () => {
  const app = express();
  app.use(express.json(), evaluationHttpBoundary);
  app.use('/api/evaluation', evaluationRoutes);
  app.use('/api/admin/evaluations', evaluationAdminRoutes);
  const token = (userId: string) => jwt.sign({ userId, email: 'test@example.invalid', isAdmin: userId === 'admin' }, 'synthetic-route-signing-secret');
  beforeEach(() => {
    jest.clearAllMocks();
    (evaluationStore.get as jest.Mock).mockResolvedValue({ userId: 'eval_test', email: 'test@example.invalid', status: 'active', expiresAt: Date.now() + 60000 });
    (evaluationStore.provision as jest.Mock).mockResolvedValue({ userId: 'eval_new' });
    (evaluationStore.saveArtifact as jest.Mock).mockResolvedValue({ artifactId: 'file' });
  });
  it('admin can provision through the product API', async () => {
    const result = await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token('admin')}`).send({ displayName: 'Synthetic' });
    expect(result.status).toBe(201);
    expect(evaluationStore.provision).toHaveBeenCalledWith('admin', { displayName: 'Synthetic' });
  });
  it.each(['customer', 'eval_test'])('%s cannot provision another workspace', async userId => {
    expect((await request(app).post('/api/admin/evaluations').set('Authorization', `Bearer ${token(userId)}`).send({})).status).toBe(403);
    expect(evaluationStore.provision).not.toHaveBeenCalled();
  });
  it('binary artifact upload writes only under the authenticated evaluation identity', async () => {
    const response = await request(app).post('/api/evaluation').set('Authorization', `Bearer ${token('eval_test')}`).send({ action: 'upload_artifact', base64: Buffer.from('opaque synthetic artifact').toString('base64') });
    expect(response.status).toBe(200);
    expect(evaluationStore.saveArtifact).toHaveBeenCalledWith('eval_test', Buffer.from('opaque synthetic artifact'), 'application/octet-stream');
  });
  it('upload rejects another user or storage destination before writing', async () => {
    const response = await request(app).post('/api/evaluation').set('Authorization', `Bearer ${token('eval_test')}`).send({ action: 'upload_artifact', text: 'synthetic', userId: 'other', key: 'production' });
    expect(response.status).toBe(403);
    expect(evaluationStore.saveArtifact).not.toHaveBeenCalled();
  });
  it('download never creates a public URL or executable browser document', async () => {
    (evaluationStore.getArtifact as jest.Mock).mockResolvedValue({ content: Buffer.from('<script>untrusted</script>'), mime: 'text/plain' });
    const response = await request(app).get('/api/evaluation/artifacts/file').set('Authorization', `Bearer ${token('eval_test')}`);
    expect(response.status).toBe(200);
    expect(evaluationStore.getArtifact).toHaveBeenCalledWith('eval_test', 'file');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toBe('attachment');
    expect(response.headers['content-security-policy']).toContain('sandbox');
  });
});
