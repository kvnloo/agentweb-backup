import request from 'supertest';
import app from '../app';

describe('Files routes', () => {
  it('should not expose /api/files/view-external', async () => {
    const response = await request(app)
      .get('/api/files/view-external')
      .query({ url: 'https://example.com' });

    expect(response.status).toBe(404);
  });

  it('should not expose /api/files/content', async () => {
    const response = await request(app)
      .get('/api/files/content')
      .query({ url: 'https://example.com' });

    expect(response.status).toBe(404);
  });
});
