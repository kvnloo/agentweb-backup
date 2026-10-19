import { useState, useEffect } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
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
const MAX_USD_PER_UNIT = 1000;

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

// Rates are fractions of a cent (e.g. 0.014), so never round to cents.
const priceFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

// Server validation failures arrive as { error: string }.
const serverError = (err: unknown, fallback: string): string =>
  (err as { response?: { data?: { error?: string } } }).response?.data?.error || fallback;

const rowId = (rate: VendorRate) => `${rate.provider}/${rate.key}`;

function parsePrice(draft: string): number | null {
  const trimmed = draft.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 && value <= MAX_USD_PER_UNIT ? value : null;
}

export default function VendorRatesTab() {
  const { token } = useAuth();
  const [loading, setLoading] = useState(true);
  const [savingRow, setSavingRow] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [data, setData] = useState<VendorRatesResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      setLoading(true);
      const { data: res } = await axios.get<VendorRatesResponse>(buildApiUrl('/api/admin/vendor-rates'), { headers });
      setData(res);
    } catch (err) {
      setError(serverError(err, 'Failed to load vendor rates'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (error || success) {
      const t = setTimeout(() => { setError(''); setSuccess(''); }, 4000);
      return () => clearTimeout(t);
    }
  }, [error, success]);

  const put = async (rate: VendorRate, usdPerUnit: number | null) => {
    const id = rowId(rate);
    try {
      setSavingRow(id);
      const { data: res } = await axios.put<VendorRatesResponse>(
        buildApiUrl('/api/admin/vendor-rates'),
        { provider: rate.provider, key: rate.key, usdPerUnit },
        { headers },
      );
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

  const handleSave = (rate: VendorRate) => {
    const value = parsePrice(drafts[rowId(rate)] ?? '');
    if (value === null) {
      setError(`Price must be a number greater than 0 and at most ${MAX_USD_PER_UNIT}`);
      return;
    }
    put(rate, value);
  };

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" p={4}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" sx={{ mb: 2 }}>{success}</Alert>}

      <Typography variant="h6" gutterBottom>Vendor Rates</Typography>
      {data && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }} data-testid="vendor-rates-version">
          Rate card version: {data.version}
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
                  {rates.map((rate) => {
                    const id = rowId(rate);
                    const busy = savingRow !== null;
                    const draft = drafts[id] ?? '';
                    return (
                      <TableRow key={id} data-testid={`vendor-rate-row-${id}`}>
                        <TableCell>{rate.key}</TableCell>
                        <TableCell>{rate.unit}</TableCell>
                        <TableCell align="right">{priceFormatter.format(rate.defaultUsdPerUnit)}</TableCell>
                        <TableCell align="right">
                          {rate.overrideUsdPerUnit === null ? '-' : priceFormatter.format(rate.overrideUsdPerUnit)}
                        </TableCell>
                        <TableCell align="right">{priceFormatter.format(rate.effectiveUsdPerUnit)}</TableCell>
                        <TableCell>
                          <TextField
                            size="small"
                            label={`USD per ${rate.unit}`}
                            value={draft}
                            onChange={(e) => setDrafts({ ...drafts, [id]: e.target.value })}
                            disabled={busy}
                            inputProps={{ 'aria-label': `New price for ${id}`, inputMode: 'decimal' }}
                          />
                        </TableCell>
                        <TableCell>
                          <Box display="flex" gap={1}>
                            <Button
                              variant="contained"
                              size="small"
                              onClick={() => handleSave(rate)}
                              disabled={busy || !draft.trim()}
                            >
                              {savingRow === id ? 'Saving...' : 'Save'}
                            </Button>
                            <Button
                              size="small"
                              onClick={() => put(rate, null)}
                              disabled={busy || rate.overrideUsdPerUnit === null}
                            >
                              Reset to default
                            </Button>
                          </Box>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </Paper>
        );
      })}
    </Box>
  );
}
