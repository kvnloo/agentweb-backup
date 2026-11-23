// ENG-3060: pure validation for AgentModeService.metaCatalogWrite, extracted from the monolith
// so the safety boundary can be tested without loading it.
// ENG-2927: a catalog's external_event_sources edge (connect = POST, disconnect = DELETE).
// ENG-2926: business owned_product_catalogs, a catalog's product_feeds, a feed's uploads / rules.
// ENG-3060: a dataset's events edge, for a Conversions API TEST event only. A send without
// test_event_code would be a production conversion, so it is refused here as well as in the tool.
const POST_PATH = /^\d+(\/(products|product_sets|external_event_sources|owned_product_catalogs|product_feeds|uploads|rules|events))?$/;
const DELETE_PATH = /^\d+(\/external_event_sources)?$/;

export function assertMetaCatalogWriteAllowed(method: string, path: string, params: Record<string, any> | undefined): void {
  const allowed = method === 'POST' ? POST_PATH : DELETE_PATH;
  if (!allowed.test(path)) throw new Error('Unsupported catalog write path.');
  if (path.endsWith('/events') && !String(params?.test_event_code ?? '').trim()) {
    throw new Error('A Conversions API send requires test_event_code.');
  }
}
