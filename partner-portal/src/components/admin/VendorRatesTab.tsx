import { useState, useEffect, useRef } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

// Same bounds the backend enforces (vendor-rate override contract).
const MAX_USD_PER_UNIT = 10;

interface VendorRate {
  provider: string;
  key: string;
  unit: string;
  defaultUsdPerUnit: number;
  overrideUsdPerUnit: number | null;
  effectiveUsdPerUnit: number;
}

interface VendorRatesResponse {
  version: string;
  editableProviders: string[];
  rates: VendorRate[];
  updatedAt: string | null;
  updatedBy: string | null;
}

// Show exactly what is stored: up to 6 decimals, trailing zeros trimmed but
// never fewer than 2 (0.014 -> $0.014, 12 -> $12.00). A positive value is never
// shown as $0.00, even if it somehow has more than 6 decimals.
function formatPrice(n: number): string {
  let fixed = n.toFixed(6);
  if (n > 0 && Number(fixed) === 0) fixed = n.toFixed(20);
  const [whole, frac = ''] = fixed.split('.');
  const trimmed = frac.replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${trimmed}`;
}

// "x2.5" / "/4.0" relative to the current effective rate.
function formatMultiple(from: number, to: number): string {
  const m = to / from;
  return m >= 1 ? `x${m.toFixed(1)}` : `/${(1 / m).toFixed(1)}`;
}

// Server validation failures arrive as { error: string }.
const serverError = (err: unknown, fallback: string): string => {
  // A gateway may answer { error: { message } }; only a plain string is safe to render.
  const e = (err as { response?: { data?: { error?: unknown } } }).response?.data?.error;
  return typeof e === 'string' && e ? e : fallback;
};

const rowId = (rate: VendorRate) => `${rate.provider}/${rate.key}`;

// Plain decimals only (no sign, exponent, hex/binary/octal, separators) with at
// most 6 decimal places, so Number() never sees a form it would reinterpret.
const PLAIN_DECIMAL = /^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/;

function parsePrice(draft: string): number | null {
  const trimmed = draft.trim();
  if (!PLAIN_DECIMAL.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 && value <= MAX_USD_PER_UNIT ? value : null;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function isVendorRate(r: unknown): r is VendorRate {
  const o = r as Record<string, unknown> | null;
  return (
    typeof o === 'object' && o !== null &&
    typeof o.provider === 'string' && typeof o.key === 'string' && typeof o.unit === 'string' &&
    isNumber(o.defaultUsdPerUnit) && isNumber(o.effectiveUsdPerUnit) &&
    (o.overrideUsdPerUnit === null || isNumber(o.overrideUsdPerUnit))
  );
}

function isVendorRatesResponse(d: unknown): d is VendorRatesResponse {
  const o = d as Record<string, unknown> | null;
  return (
    typeof o === 'object' && o !== null &&
    typeof o.version === 'string' &&
    (o.updatedAt === null || typeof o.updatedAt === 'string') &&
    (o.updatedBy === null || typeof o.updatedBy === 'string') &&
    Array.isArray(o.editableProviders) && o.editableProviders.every((p) => typeof p === 'string') &&
    Array.isArray(o.rates) && o.rates.every(isVendorRate)
  );
}

interface PendingChange {
  rate: VendorRate;
  // null = reset to default
  usdPerUnit: number | null;
}

/** Loads the rates and saves one change at a time; every message the tab shows comes from here. */
function useVendorRates(token: string | null | undefined) {
  const [loading, setLoading] = useState(true);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [data, setData] = useState<VendorRatesResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      setLoading(true);
      setLoadError('');
      const { data: res } = await axios.get<unknown>(buildApiUrl('/api/admin/vendor-rates'), { headers });
      if (!isVendorRatesResponse(res)) {
        setLoadError('Failed to load vendor rates: unexpected response from server');
        return;
      }
      setData(res);
    } catch (err) {
      setLoadError(serverError(err, 'Failed to load vendor rates'));
    } finally {
      setLoading(false);
    }
  };

  // Load once on mount: `load` is recreated every render and only reads state it sets itself, so listing it would refetch in a loop.
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(''), 4000);
      return () => clearTimeout(t);
    }
  }, [success]);

  const put = async (rate: VendorRate, usdPerUnit: number | null) => {
    const id = rowId(rate);
    try {
      setSavingRow(id);
      setError('');
      setSuccess('');
      const { data: res } = await axios.put<unknown>(
        buildApiUrl('/api/admin/vendor-rates'),
        { provider: rate.provider, key: rate.key, usdPerUnit },
        { headers },
      );
      if (!isVendorRatesResponse(res)) {
        setError('Failed to save vendor rate: unexpected response from server');
        return;
      }
      setData(res);
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSuccess(usdPerUnit === null ? `${id} reset to default` : `${id} saved`);
    } catch (err) {
      setError(serverError(err, 'Failed to save vendor rate'));
    } finally {
      setSavingRow(null);
    }
  };

  return { loading, savingRow, loadError, error, setError, success, setSuccess, data, drafts, setDrafts, load, put };
}

interface RateRowProps {
  rate: VendorRate;
  draft: string;
  /** Some row is being saved: every row is read-only meanwhile. */
  busy: boolean;
  saving: boolean;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onReset: () => void;
}

function RateRow({ rate, draft, busy, saving, onDraftChange, onSave, onReset }: RateRowProps) {
  const id = rowId(rate);
  return (
    <TableRow data-testid={`vendor-rate-row-${id}`}>
      <TableCell>{rate.key}</TableCell>
      <TableCell>{rate.unit}</TableCell>
      <TableCell align="right">{formatPrice(rate.defaultUsdPerUnit)}</TableCell>
      <TableCell align="right">{rate.overrideUsdPerUnit === null ? '-' : formatPrice(rate.overrideUsdPerUnit)}</TableCell>
      <TableCell align="right">{formatPrice(rate.effectiveUsdPerUnit)}</TableCell>
      <TableCell>
        <TextField
          size="small"
          label={`USD per ${rate.unit}`}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy && draft.trim()) onSave(); }}
          inputProps={{ 'aria-label': `New price for ${id}`, inputMode: 'decimal', readOnly: busy }}
        />
      </TableCell>
      <TableCell>
        <Box display="flex" gap={1}>
          <Button
            variant="contained"
            size="small"
            onClick={onSave}
            aria-label={`Save ${rate.provider} ${rate.key}`}
            disabled={busy || !draft.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button
            size="small"
            onClick={onReset}
            aria-label={`Reset ${rate.provider} ${rate.key} to default`}
            disabled={busy || rate.overrideUsdPerUnit === null}
          >
            Reset to default
          </Button>
        </Box>
      </TableCell>
    </TableRow>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  /** The change to confirm; kept after closing so the close transition keeps its text. */
  change: PendingChange | null;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmRateDialog({ open, change, onCancel, onConfirm }: ConfirmDialogProps) {
  const target = change && (change.usdPerUnit ?? change.rate.defaultUsdPerUnit);
  // Rounded so exact 10x / 0.1x (which float division misses by an ulp) sit on the boundary.
  const multiple = change && target !== null ? Math.round((target / change.rate.effectiveUsdPerUnit) * 1e6) / 1e6 : 1;
  return (
    <Dialog open={open} onClose={onCancel}>
      <DialogTitle>{change?.usdPerUnit === null ? 'Confirm reset to default' : 'Confirm rate change'}</DialogTitle>
      <DialogContent>
        {change && target !== null && (
          <>
            <DialogContentText>
              {`${rowId(change.rate)}: ${formatPrice(change.rate.effectiveUsdPerUnit)} -> ${formatPrice(target)} per ${change.rate.unit} (${formatMultiple(change.rate.effectiveUsdPerUnit, target)})`}
            </DialogContentText>
            {change.usdPerUnit === null && (
              <DialogContentText>
                {`Returns to the default rate of ${formatPrice(change.rate.defaultUsdPerUnit)} per ${change.rate.unit}.`}
              </DialogContentText>
            )}
            {(multiple > 10 || multiple < 0.1) && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                This changes the rate by more than 10x (up or down). Check the value before confirming; it affects recorded vendor spend.
              </Alert>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onConfirm} color="primary" variant="contained">Confirm</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function VendorRatesTab() {
  const { token } = useAuth();
  const { loading, savingRow, loadError, error, setError, success, setSuccess, data, drafts, setDrafts, load, put } = useVendorRates(token);
  const [pending, setPending] = useState<PendingChange | null>(null);

  const requestSave = (rate: VendorRate) => {
    const value = parsePrice(drafts[rowId(rate)] ?? '');
    if (value === null) {
      setError(`Price must be a plain decimal greater than 0 and at most ${MAX_USD_PER_UNIT}, with at most 6 decimal places`);
      return;
    }
    setError('');
    setSuccess('');
    setPending({ rate, usdPerUnit: value });
  };

  const requestReset = (rate: VendorRate) => {
    setError('');
    setSuccess('');
    setPending({ rate, usdPerUnit: null });
  };

  const confirmPending = () => {
    if (!pending) return;
    const { rate, usdPerUnit } = pending;
    setPending(null);
    put(rate, usdPerUnit);
  };

  // Dialog content renders from the last non-null change so the close
  // transition keeps its title and body instead of flashing an empty dialog.
  const lastPending = useRef<PendingChange | null>(null);
  if (pending) lastPending.current = pending;

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress aria-label="Loading vendor rates" />
      </Box>
    );
  }

  return (
    <Box>
      {loadError && (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}
        >
          {loadError}
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Typography variant="h6" gutterBottom>Vendor Rates</Typography>
      {data && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }} data-testid="vendor-rates-version">
          Rate card version (overridden rates): {data.version}
          {data.updatedBy && data.updatedAt && ` · Last changed by ${data.updatedBy} at ${data.updatedAt}`}
        </Typography>
      )}

      {data && data.editableProviders.length === 0 && (
        <Typography variant="body2" color="text.secondary">No editable vendor rates.</Typography>
      )}

      {data && data.editableProviders.map((provider) => {
        const rates = data.rates.filter((r) => r.provider === provider);
        return (
          <Paper key={provider} variant="outlined" sx={{ p: 3, mb: 3 }}>
            <Typography variant="subtitle1" fontWeight={600} gutterBottom sx={{ textTransform: 'capitalize' }}>
              {provider}
            </Typography>
            {rates.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No editable rates.</Typography>
            ) : (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Rate key</TableCell>
                    <TableCell>Unit</TableCell>
                    <TableCell align="right">Default</TableCell>
                    <TableCell align="right">Override</TableCell>
                    <TableCell align="right">Effective</TableCell>
                    <TableCell>New price</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rates.map((rate) => (
                    <RateRow
                      key={rowId(rate)}
                      rate={rate}
                      draft={drafts[rowId(rate)] ?? ''}
                      busy={savingRow !== null}
                      saving={savingRow === rowId(rate)}
                      onDraftChange={(value) => setDrafts((prev) => ({ ...prev, [rowId(rate)]: value }))}
                      onSave={() => requestSave(rate)}
                      onReset={() => requestReset(rate)}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </Paper>
        );
      })}

      <ConfirmRateDialog open={pending !== null} change={pending ?? lastPending.current} onCancel={() => setPending(null)} onConfirm={confirmPending} />
    </Box>
  );
}
