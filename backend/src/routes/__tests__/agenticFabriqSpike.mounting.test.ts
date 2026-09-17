import express from 'express';
import request from 'supertest';
import { mountAgenticFabriqSpikeRoutes } from '../mountAgenticFabriqSpikeRoutes';

describe('Agentic Fabriq callback mounting', () => {
  it('lands callbacks while the production spike remains disabled', async () => {
    const app = express();
    const spikeRouter = express.Router().get('/init', (_req, res) => res.sendStatus(204));
    const callbackRouter = express.Router().get('/callback', (_req, res) => res.sendStatus(204));

    mountAgenticFabriqSpikeRoutes(app, {
      enabled: false,
      spikeRouter,
      callbackRouter,
    });

    await request(app).get('/api/agentic-fabriq-spike/callback').expect(204);
    await request(app).get('/api/agentic-fabriq-spike/init').expect(404);
  });
});
