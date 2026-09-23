import { useEffect, useState } from 'react';
import { Alert, Box, Button, Paper, Typography } from '@mui/material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

type Source = { id: string; provider: string; identity: string | null; scope: string };
type Item = { id: string; name: string; kind: string; parentId: string | null };
type Inventory = { identity: string | null; checkedAt: string; complete: boolean; items: Item[] };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown) => value === null || typeof value === 'string';
function isInventory(value: unknown): value is Inventory {
  return record(value) && identity(value.identity) && typeof value.checkedAt === 'string' &&
    Number.isFinite(Date.parse(value.checkedAt)) && typeof value.complete === 'boolean' &&
    Array.isArray(value.items) && value.items.length <= 2000 && value.items.every(item => record(item) &&
      typeof item.id === 'string' && typeof item.name === 'string' && typeof item.kind === 'string' && identity(item.parentId));
}
function isSources(value: unknown): value is { sources: Source[] } {
  return record(value) && Array.isArray(value.sources) && value.sources.every(source => record(source) &&
    typeof source.id === 'string' && ['clickup', 'google_drive'].includes(String(source.provider)) &&
    typeof source.scope === 'string' && identity(source.identity));
}

/** Render every item, including roots whose parents were unavailable or capped.
 * Iterative traversal bounds stack use even for malformed/cyclic provider trees.
 */
function InventoryTree({ items }: { items: Item[] }) {
  const keys = new Set(items.map(item => `${item.kind}:${item.id}`));
  const children = new Map<string | null, Item[]>();
  for (const item of items) {
    const parent = item.parentId && keys.has(item.parentId) ? item.parentId : null;
    const bucket = children.get(parent) ?? [];
    bucket.push(item);
    children.set(parent, bucket);
  }
  const visited = new Set<string>();
  const rows: { item: Item; depth: number; path: string }[] = [];
  const walk = (root: Item) => {
    const stack = [{ item: root, depth: 0, path: '' }];
    while (stack.length) {
      const row = stack.pop()!;
      const key = `${row.item.kind}:${row.item.id}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const path = `${row.path}/${row.item.name}`;
      rows.push({ ...row, path });
      for (const child of [...(children.get(key) ?? [])].reverse()) stack.push({ item: child, depth: row.depth + 1, path });
    }
  };
  for (const root of children.get(null) ?? []) walk(root);
  for (const item of items) walk(item);
  return <Box component="ul" aria-label="Reachable items" sx={{ maxHeight: 420, overflow: 'auto', listStyle: 'none', pl: 0 }}>
    {rows.map(({ item, depth, path }) => <Box component="li" key={`${item.kind}:${item.id}`} sx={{ ml: Math.min(depth, 12) * 2, py: 0.5 }}>
      <Typography component="span" title={path}>{item.name}</Typography>
      <Typography component="span" variant="caption" color="text.secondary"> — {item.kind} · {item.id}</Typography>
      {item.parentId && !keys.has(item.parentId) && <Typography variant="caption" display="block">Parent not in this listing: {item.parentId}</Typography>}
    </Box>)}
  </Box>;
}

function SourceCard({ source, token }: { source: Source; token: string }) {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const refresh = async () => {
    setLoading(true);
    setError(false);
    setInventory(null);
    try {
      const { data } = await axios.get<Inventory>(buildApiUrl('/api/source-access'), {
        headers: { Authorization: `Bearer ${token}` }, params: { source: source.id }, timeout: 40000,
      });
      if (!isInventory(data)) throw new Error('Invalid inventory');
      setInventory(data);
      setLastChecked(data.checkedAt);
    } catch { setError(true); } finally { setLoading(false); }
  };
  return <Paper variant="outlined" sx={{ p: 2, my: 2 }}>
    <Typography variant="h6">{source.provider === 'clickup' ? 'ClickUp' : 'Google Drive'}</Typography>
    <Typography>Connected identity: {inventory?.identity ?? source.identity ?? 'Check access to identify the connected account'}</Typography>
    <Typography variant="body2">{source.scope} · Last checked: {lastChecked ? new Date(lastChecked).toLocaleString() : 'Not checked'}</Typography>
    <Button onClick={refresh} disabled={loading} aria-label={`Refresh ${source.provider === 'clickup' ? 'ClickUp' : 'Google Drive'} access`}>
      {loading ? 'Checking…' : 'Refresh'}
    </Button>
    {error && <Alert severity="error">Unable to check source access. Try refreshing again.</Alert>}
    {inventory && <>
      {!inventory.complete && <Alert severity="warning">Incomplete listing: a provider limit, unavailable response, or safety cap stopped the check. Items below are only the confirmed portion.</Alert>}
      {inventory.items.length === 0 && inventory.complete && <Typography>No reachable items returned by the provider.</Typography>}
      <InventoryTree items={inventory.items} />
    </>}
  </Paper>;
}

function Panel({ token, embedded }: { token: string; embedded: boolean }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'denied' | 'error'>('loading');
  useEffect(() => {
    const controller = new AbortController();
    axios.get<{ sources: Source[] }>(buildApiUrl('/api/source-access'), {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    }).then(({ data }) => {
      if (!isSources(data)) throw new Error('Invalid sources');
      setSources(data.sources); setStatus('ready');
    }).catch(error => {
      if (!controller.signal.aborted) setStatus(error.response?.status === 403 ? 'denied' : 'error');
    });
    return () => controller.abort();
  }, [token]);
  if (embedded && status === 'denied') return null;
  return <Box sx={{ p: 2 }}>
    <Typography variant="h5">Source access</Typography>
    <Typography variant="body2">Live metadata visible to each connected token. Names and IDs only; document contents are never returned. This listing includes provider-accessible items beyond imported Brand Knowledge. Deleted items are excluded.</Typography>
    {status === 'loading' && <Typography role="status">Loading connected sources…</Typography>}
    {status === 'denied' && <Alert severity="error">Organization admin access required.</Alert>}
    {status === 'error' && <Alert severity="error">Unable to load connected sources. Reload this page to retry.</Alert>}
    {status === 'ready' && sources.length === 0 && <Typography>No ClickUp or Google Drive token connections available for this organization.</Typography>}
    {sources.map(source => <SourceCard key={source.id} source={source} token={token} />)}
  </Box>;
}

export default function SourceAccessPanel({ embedded = false }: { embedded?: boolean }) {
  const { token } = useAuth();
  // Remount on account/token changes so inventory from a previous org cannot linger.
  return token ? <Panel key={token} token={token} embedded={embedded} /> : null;
}
