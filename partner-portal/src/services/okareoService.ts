import axios from 'axios';
import { buildApiUrl } from '../config';

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}` };
}

export interface Simulation {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  mut_id?: string;
  scenario_set_id?: string;
  driver_id?: string;
  start_time?: string;
  end_time?: string | null;
  model_metrics?: Record<string, any>;
  test_data_point_count?: number;
  tags?: string[];
}

export interface Target {
  id: string;
  name: string;
  models?: Record<string, any>;
  tags?: string[];
  time_created?: string;
}

export interface Driver {
  id: string;
  name: string;
  model_id?: string;
  temperature?: number;
  time_created?: string;
}

export interface Scenario {
  scenario_id: string;
  name?: string;
  tags?: string[];
  time_created?: string;
  num_rows?: number;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
  result?: unknown;
  duration?: number;
}

export interface ConversationTurn {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
}

export interface DataPoint {
  id: string;
  tags?: string[] | null;
  scenario_data_point_id?: string;
  test_run_id?: string;
  metric_value?: {
    generation_output?: ConversationTurn[];
    [key: string]: unknown;
  };
  checks?: Record<string, unknown>;
}

export interface SimulationResult {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  mut_id?: string;
  scenario_set_id?: string;
  start_time?: string;
  end_time?: string | null;
  model_metrics?: Record<string, any>;
  test_data_point_count?: number;
  app_link?: string;
  datapoints?: DataPoint[];
}

export interface Check {
  name: string;
  description: string;
  output_data_type: string;
}

export const listChecks = async (token: string): Promise<Check[]> => {
  const response = await axios.get(buildApiUrl('/api/okareo/checks'), {
    headers: authHeaders(token),
  });
  const data = response.data;
  // API returns either { checks: [...] } or a plain array
  return (Array.isArray(data) ? data : data?.checks) || [];
};

export const listSimulations = async (token: string, driverId?: string): Promise<Simulation[]> => {
  const response = await axios.get(buildApiUrl('/api/okareo/simulations'), {
    headers: authHeaders(token),
    params: driverId ? { driver_id: driverId } : undefined,
  });
  return response.data || [];
};

export const getSimulationResults = async (token: string, id: string): Promise<SimulationResult> => {
  const response = await axios.get(buildApiUrl(`/api/okareo/simulations/${id}`), {
    headers: authHeaders(token),
  });
  return response.data;
};

export const listTargets = async (token: string): Promise<Target[]> => {
  const response = await axios.get(buildApiUrl('/api/okareo/targets'), {
    headers: authHeaders(token),
  });
  return response.data || [];
};

export const listDrivers = async (token: string): Promise<Driver[]> => {
  const response = await axios.get(buildApiUrl('/api/okareo/drivers'), {
    headers: authHeaders(token),
  });
  return response.data || [];
};

export const listScenarios = async (token: string): Promise<Scenario[]> => {
  const response = await axios.get(buildApiUrl('/api/okareo/scenarios'), {
    headers: authHeaders(token),
  });
  return response.data || [];
};
