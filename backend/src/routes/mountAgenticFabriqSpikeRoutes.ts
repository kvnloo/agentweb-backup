import type { Application, Router } from 'express';

const SPIKE_ROUTE_PREFIX = '/api/agentic-fabriq-spike';

interface AgenticFabriqRouteMounts {
  enabled: boolean;
  spikeRouter: Router;
  callbackRouter: Router;
}

/**
 * Keeps the bound OAuth landing route present even when the spike's production
 * initiation and tool-dispatch paths remain disabled.
 */
export function mountAgenticFabriqSpikeRoutes(
  app: Application,
  { enabled, spikeRouter, callbackRouter }: AgenticFabriqRouteMounts,
): void {
  app.use(SPIKE_ROUTE_PREFIX, callbackRouter);
  if (enabled) app.use(SPIKE_ROUTE_PREFIX, spikeRouter);
}
