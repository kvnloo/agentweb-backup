import { useState, useEffect, useCallback } from 'react';
import {
  Card,
  CardContent,
  CircularProgress,
  IconButton,
  Tooltip,
  Typography,
} from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';
import axios from 'axios';
import { buildApiUrl } from '../../config';
import { useAuth } from '../../contexts/AuthContext';

/** Mirrors the backend V0CreditsDto (services/v0BillingService.ts). */
export interface V0Credits {
  plan: string;
  billingCycle: { start: number; end: number } | null;
  monthly: { remaining: number; total: number };
  onDemand: { remaining: number; total: number };
  totalSpendableUsd: number;
  rateLimits: {
    limit: number | null;
    remaining: number | null;
    reset: number | null;
    daily: { limit: number; remaining: number; reset: number } | null;
  } | null;
  warnLevel: 'ok' | 'low' | 'critical';
  fetchedAt: string;
}

const WARN_COLORS: Record<V0Credits['warnLevel'], string> = {
  ok: 'success.main',
  low: 'warning.main',
  critical: 'error.main',
};

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * Compact v0 (Vercel v0 platform) credit balance card for the admin dashboard.
 * Landing-page generation burns v0 credits — this card is the visibility layer
 * so a runaway consumer can never silently drain the account again.
 *
 * On fetch failure it shows a plain error state — never fabricated numbers.
 */
export default function V0CreditsCard() {
  const { token } = useAuth();
  const [credits, setCredits] = useState<V0Credits | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (refresh = false) => {
      try {
        setLoading(true);
        setError('');
        const { data } = await axios.get(
          buildApiUrl(`/api/admin/v0/credits${refresh ? '?refresh=1' : ''}`),
          { headers: { Authorization: `Bearer ${token}` } }
        );
        setCredits(data);
      } catch (err: any) {
        setCredits(null);
        setError(err.response?.data?.error || "Couldn't reach v0 billing");
      } finally {
        setLoading(false);
      }
    },
    [token]
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          v0 Credits
          <Tooltip title="Refresh from v0">
            <span>
              <IconButton
                size="small"
                aria-label="refresh v0 credits"
                onClick={() => load(true)}
                disabled={loading}
                sx={{ ml: 1 }}
              >
                {loading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        </Typography>
        {error && (
          <Typography variant="body2" color="error" data-testid="v0-credits-error">
            {error}
          </Typography>
        )}
        {credits && (
          <>
            <Typography
              variant="h4"
              data-testid="v0-total-spendable"
              sx={{ color: WARN_COLORS[credits.warnLevel] }}
            >
              {usd(credits.totalSpendableUsd)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Total spendable
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Plan: {credits.plan}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Monthly: {usd(credits.monthly.remaining)} / {usd(credits.monthly.total)}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              On-demand: {usd(credits.onDemand.remaining)} / {usd(credits.onDemand.total)}
            </Typography>
            {credits.warnLevel !== 'ok' && (
              <Typography
                variant="body2"
                data-testid="v0-warn-label"
                sx={{ color: WARN_COLORS[credits.warnLevel], fontWeight: 'bold' }}
              >
                {credits.warnLevel === 'critical' ? 'Credits critical' : 'Credits low'}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Last checked: {new Date(credits.fetchedAt).toLocaleString()}
            </Typography>
          </>
        )}
      </CardContent>
    </Card>
  );
}
