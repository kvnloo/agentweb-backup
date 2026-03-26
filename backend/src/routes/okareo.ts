/**
 * Okareo Routes — Read-only endpoints for the Okareo dashboard in the partner portal.
 *
 * Uses the okareo-ts-sdk where methods are available. Raw axios is kept for:
 *  - GET /v0/drivers        — no SDK method exists
 *  - POST /v0/find_test_data_points — not exposed on the Okareo class; needed for
 *                             metric_value.generation_output (conversation transcripts)
 */

import { Router, Request, Response } from 'express';
import axios from 'axios';
import { Okareo } from 'okareo-ts-sdk';
import { authenticateToken } from '../middleware/auth';

const router = Router();
router.use(authenticateToken);

const OKAREO_BASE_URL = 'https://api.okareo.com';

let okareoClient: Okareo | null = null;

function getOkareoClient(): Okareo {
  if (!okareoClient) {
    okareoClient = new Okareo({ api_key: process.env.OKAREO_API_KEY || '' });
  }
  return okareoClient;
}

// Used only for endpoints not covered by the SDK
function okareoHeaders() {
  return { 'api-key': process.env.OKAREO_API_KEY || '' };
}

// Cache the Global project ID per process lifetime to avoid repeated lookups
let cachedProjectId: string | null = null;

async function getProjectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const okareo = getOkareoClient();
  const projects = await okareo.getProjects() as { id: string; name: string }[];
  const global = projects.find((p) => p.name === 'Global');
  if (!global) throw new Error('No "Global" project found in Okareo account.');
  cachedProjectId = global.id;
  return global.id;
}

// ─── Simulations ─────────────────────────────────────────────────────────────

router.get('/simulations', async (req: Request, res: Response) => {
  try {
    const project_id = await getProjectId();
    const okareo = getOkareoClient();
    const runs = await okareo.find_test_runs({ project_id, return_model_metrics: true }) as Record<string, unknown>[];
    // SDK has no type filter — restrict to MULTI_TURN (simulations) client-side
    let filtered = runs.filter((r) => r.type === 'MULTI_TURN');
    // Optional driver filter — reduces payload sent to frontend
    const { driver_id } = req.query;
    if (driver_id && typeof driver_id === 'string') {
      filtered = filtered.filter((r) => r.driver_id === driver_id);
    }
    res.json(filtered);
  } catch (err: any) {
    console.error('Error fetching simulations:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── Single Simulation Results ────────────────────────────────────────────────

router.get('/simulations/:id', async (req: Request, res: Response) => {
  try {
    const okareo = getOkareoClient();
    const run = await okareo.get_test_run(req.params.id) as Record<string, unknown>;

    // find_test_data_points is not on the Okareo class — use raw axios.
    // We need metric_value.generation_output for conversation transcripts.
    let datapoints: unknown[] = [];
    try {
      const project_id = await getProjectId();
      const dpRes = await axios.post(
        `${OKAREO_BASE_URL}/v0/find_test_data_points`,
        { project_id, test_run_id: req.params.id },
        { headers: okareoHeaders() }
      );
      const dpData = dpRes.data as { data_points?: unknown[] } | unknown[];
      datapoints = Array.isArray(dpData) ? dpData : ((dpData as { data_points?: unknown[] }).data_points ?? []);
    } catch (dpErr: any) {
      console.warn('Could not fetch data points for simulation:', dpErr.message);
    }

    res.json({ ...run, datapoints });
  } catch (err: any) {
    console.error('Error fetching simulation results:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── Targets ─────────────────────────────────────────────────────────────────

router.get('/targets', async (req: Request, res: Response) => {
  try {
    const project_id = await getProjectId();
    const okareo = getOkareoClient();
    const all = await okareo.get_all_models(project_id) as Record<string, unknown>[];
    // Only surface targets that have a voice or custom_endpoint model config
    const targets = all.filter((m) => {
      const models = (m.models as Record<string, unknown>) || {};
      return 'voice' in models || 'custom_endpoint' in models;
    });
    res.json(targets);
  } catch (err: any) {
    console.error('Error fetching targets:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── Drivers ─────────────────────────────────────────────────────────────────
// No SDK method exists for drivers — raw axios only.

router.get('/drivers', async (req: Request, res: Response) => {
  try {
    const project_id = await getProjectId();
    const response = await axios.get(`${OKAREO_BASE_URL}/v0/drivers`, {
      headers: okareoHeaders(),
      params: { project_id },
    });
    res.json(response.data);
  } catch (err: any) {
    console.error('Error fetching drivers:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── Checks ──────────────────────────────────────────────────────────────────

router.get('/checks', async (req: Request, res: Response) => {
  try {
    const response = await axios.get(`${OKAREO_BASE_URL}/v0/checks`, {
      headers: okareoHeaders(),
    });
    res.json(response.data);
  } catch (err: any) {
    console.error('Error fetching checks:', err.message);
    res.status(500).json({ message: err.message });
  }
});

// ─── Scenarios ────────────────────────────────────────────────────────────────

router.get('/scenarios', async (req: Request, res: Response) => {
  try {
    const project_id = await getProjectId();
    const okareo = getOkareoClient();
    res.json(await okareo.get_scenario_sets({ project_id }));
  } catch (err: any) {
    console.error('Error fetching scenarios:', err.message);
    res.status(500).json({ message: err.message });
  }
});

export default router;
