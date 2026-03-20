import { useState, useEffect } from 'react';
import axios from 'axios';
import { buildApiUrl } from '../config';
import { useAuth } from '../contexts/AuthContext';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  LinearProgress,
  Skeleton,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CampaignIcon from '@mui/icons-material/Campaign';
import LanguageIcon from '@mui/icons-material/Language';
import PeopleIcon from '@mui/icons-material/People';
import PaletteIcon from '@mui/icons-material/Palette';
import TrendingUpIcon from '@mui/icons-material/TrendingUp';
import AccessTimeIcon from '@mui/icons-material/AccessTime';
import ShieldIcon from '@mui/icons-material/Shield';

// ------------------------------------------------------------------
// Types
// ------------------------------------------------------------------

type HealthStatus = 'healthy' | 'mediocre' | 'at-risk' | 'blocked' | 'onboarding';

interface ClientSummary {
  userId: string;
  email: string;
  displayName: string;
  roles: string[];
  has_ads: boolean;
  has_lander: boolean;
  has_crm: boolean;
  last_activity: string | null;
}

interface AdsLayerHealth {
  connected: boolean;
  ad_account_id?: string;
  active_campaigns: number;
  campaigns?: Array<{ id: string; name: string; status: string; objective: string }>;
}

interface LanderLayerHealth {
  has_lander: boolean;
  platforms: string[];
}

interface LeadQualityLayerHealth {
  has_crm: boolean;
  platforms: string[];
}

interface CreativeVariety {
  distinct_creatives: number;
  cannibalization_warning: boolean;
  fatigue_warning: boolean;
  top_creatives?: Array<{ id: string; name: string; spend_pct: number }>;
}

interface ClientHealthDetail {
  client: { userId: string; email: string; displayName: string };
  ads_layer: AdsLayerHealth;
  lander_layer: LanderLayerHealth;
  lead_quality_layer: LeadQualityLayerHealth;
  creative_variety: CreativeVariety;
  status: HealthStatus;
  status_reasons: string[];
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

const STATUS_CONFIG: Record<
  HealthStatus,
  { label: string; color: 'success' | 'warning' | 'error' | 'default' | 'info' }
> = {
  healthy: { label: 'Healthy', color: 'success' },
  mediocre: { label: 'Mediocre', color: 'warning' },
  'at-risk': { label: 'At Risk', color: 'error' },
  blocked: { label: 'Blocked', color: 'default' },
  onboarding: { label: 'Onboarding', color: 'info' },
};

function deriveQuickStatus(client: ClientSummary): HealthStatus {
  if (!client.has_ads && !client.has_lander && !client.has_crm) return 'blocked';
  if (!client.has_ads) return 'at-risk';
  const issues = [!client.has_lander, !client.has_crm].filter(Boolean).length;
  if (issues === 0) return 'healthy';
  return 'mediocre';
}

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function quickSummary(client: ClientSummary): string {
  const parts: string[] = [];
  if (!client.has_ads) parts.push('No ads');
  if (!client.has_lander) parts.push('No lander');
  if (!client.has_crm) parts.push('No CRM');
  if (parts.length === 0) return 'All layers connected';
  return parts.join(' \u00B7 ');
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
  ) : (
    <CancelIcon sx={{ fontSize: 16, color: 'error.main' }} />
  );
}

// ------------------------------------------------------------------
// Component
// ------------------------------------------------------------------

export default function ClientHealth() {
  const { token, user } = useAuth();

  const [clients, setClients] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedClient, setSelectedClient] = useState<ClientSummary | null>(null);
  const [detail, setDetail] = useState<ClientHealthDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [notes, setNotes] = useState<Record<string, string>>({});
  const [savingNote, setSavingNote] = useState(false);

  useEffect(() => {
    if (user?.isAdmin) {
      fetchClients();
    }
  }, [token, user?.isAdmin]);

  const fetchClients = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get(buildApiUrl('/api/client-health'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (response.data.success) {
        setClients(response.data.clients || []);
      } else {
        setError(response.data.message || 'Failed to load data');
      }
    } catch {
      setError('Failed to load client health data. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const fetchClientDetail = async (client: ClientSummary) => {
    setSelectedClient(client);
    setDetailLoading(true);
    setDetailError(null);
    setDetail(null);
    try {
      const response = await axios.get(
        buildApiUrl(`/api/client-health/${encodeURIComponent(client.email)}`),
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (response.data.success) {
        setDetail(response.data.health);
        if (response.data.health?.notes) {
          setNotes((prev) => ({
            ...prev,
            [client.userId]: response.data.health.notes,
          }));
        }
      } else {
        setDetailError(response.data.message || 'Failed to load detail');
      }
    } catch {
      setDetailError('Failed to load client health detail.');
    } finally {
      setDetailLoading(false);
    }
  };

  const handleSaveNote = async (clientId: string) => {
    setSavingNote(true);
    try {
      await axios.post(
        buildApiUrl(`/api/client-health/${clientId}/notes`),
        { note: notes[clientId] || '' },
        { headers: { Authorization: `Bearer ${token}` } }
      );
    } catch {
      // silent
    } finally {
      setSavingNote(false);
    }
  };

  // Admin gate — AdminRoute already handles this, but belt-and-suspenders
  if (!user?.isAdmin) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <ShieldIcon sx={{ fontSize: 64, color: 'text.disabled' }} />
        <Typography variant="h5" sx={{ mt: 2 }}>
          Admin Access Required
        </Typography>
        <Typography color="text.secondary" sx={{ mt: 1 }}>
          The Client Health dashboard is only available to admin users.
        </Typography>
      </Box>
    );
  }

  // ------------------------------------------------------------------
  // Detail View
  // ------------------------------------------------------------------
  if (selectedClient) {
    return (
      <Box>
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 3 }}>
          <IconButton
            onClick={() => {
              setSelectedClient(null);
              setDetail(null);
            }}
          >
            <ArrowBackIcon />
          </IconButton>
          <Box sx={{ flex: 1 }}>
            <Typography variant="h5" fontWeight={700}>
              {selectedClient.displayName}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {selectedClient.email}
            </Typography>
          </Box>
          {detail && (
            <Chip
              label={STATUS_CONFIG[detail.status]?.label}
              color={STATUS_CONFIG[detail.status]?.color}
              size="small"
            />
          )}
        </Box>

        {detailLoading && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {[1, 2, 3].map((i) => (
              <Skeleton key={i} variant="rounded" height={160} />
            ))}
          </Box>
        )}

        {detailError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {detailError}
          </Alert>
        )}

        {detail && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Status Reasons */}
            {detail.status_reasons.length > 0 && (
              <Alert severity="warning">
                <ul style={{ margin: 0, paddingLeft: 20 }}>
                  {detail.status_reasons.map((reason, i) => (
                    <li key={i}>{reason}</li>
                  ))}
                </ul>
              </Alert>
            )}

            {/* Funnel Visualization */}
            <Card>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <TrendingUpIcon fontSize="small" />
                  <Typography variant="h6">Funnel Overview</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Meta Ads &rarr; Site / Lander &rarr; Lead Capture
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  {/* Ads */}
                  <Box
                    sx={{
                      flex: 1,
                      textAlign: 'center',
                      p: 2,
                      borderRadius: 2,
                      border: 2,
                      borderColor: detail.ads_layer.connected ? 'success.light' : 'error.light',
                      bgcolor: detail.ads_layer.connected ? 'success.50' : 'error.50',
                    }}
                  >
                    <CampaignIcon sx={{ mb: 0.5 }} />
                    <Typography variant="subtitle2">Meta Ads</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {detail.ads_layer.connected
                        ? `${detail.ads_layer.active_campaigns} active`
                        : 'Not connected'}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="disabled" />
                  {/* Lander */}
                  <Box
                    sx={{
                      flex: 1,
                      textAlign: 'center',
                      p: 2,
                      borderRadius: 2,
                      border: 2,
                      borderColor: detail.lander_layer.has_lander ? 'success.light' : 'error.light',
                      bgcolor: detail.lander_layer.has_lander ? 'success.50' : 'error.50',
                    }}
                  >
                    <LanguageIcon sx={{ mb: 0.5 }} />
                    <Typography variant="subtitle2">Site / Lander</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {detail.lander_layer.has_lander
                        ? detail.lander_layer.platforms.join(', ')
                        : 'None detected'}
                    </Typography>
                  </Box>
                  <ChevronRightIcon color="disabled" />
                  {/* Lead Capture */}
                  <Box
                    sx={{
                      flex: 1,
                      textAlign: 'center',
                      p: 2,
                      borderRadius: 2,
                      border: 2,
                      borderColor: detail.lead_quality_layer.has_crm ? 'success.light' : 'error.light',
                      bgcolor: detail.lead_quality_layer.has_crm ? 'success.50' : 'error.50',
                    }}
                  >
                    <PeopleIcon sx={{ mb: 0.5 }} />
                    <Typography variant="subtitle2">Lead Capture</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {detail.lead_quality_layer.has_crm
                        ? detail.lead_quality_layer.platforms.join(', ')
                        : 'Not configured'}
                    </Typography>
                  </Box>
                </Box>
              </CardContent>
            </Card>

            {/* Three Layer Breakdown */}
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 2 }}>
              {/* Campaign KPIs */}
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <CampaignIcon fontSize="small" />
                    <Typography variant="subtitle1" fontWeight={600}>Campaign KPIs</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="body2" color="text.secondary">Ad Account</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <StatusIcon ok={detail.ads_layer.connected} />
                      <Typography variant="body2">
                        {detail.ads_layer.connected ? 'Connected' : 'Disconnected'}
                      </Typography>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="body2" color="text.secondary">Active Campaigns</Typography>
                    <Typography variant="body2" fontWeight={600}>
                      {detail.ads_layer.active_campaigns}
                    </Typography>
                  </Box>
                  {detail.ads_layer.campaigns && detail.ads_layer.campaigns.length > 0 && (
                    <Box sx={{ borderTop: 1, borderColor: 'divider', pt: 1, mt: 1 }}>
                      <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase' }}>
                        Campaigns
                      </Typography>
                      {detail.ads_layer.campaigns.map((c) => (
                        <Box key={c.id} sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                          <Typography variant="caption" noWrap sx={{ maxWidth: 150 }}>
                            {c.name}
                          </Typography>
                          <Chip label={c.objective} size="small" variant="outlined" sx={{ height: 18, fontSize: 10 }} />
                        </Box>
                      ))}
                    </Box>
                  )}
                </CardContent>
              </Card>

              {/* Lander / Website */}
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <LanguageIcon fontSize="small" />
                    <Typography variant="subtitle1" fontWeight={600}>Lander / Website</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="body2" color="text.secondary">Has Lander</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <StatusIcon ok={detail.lander_layer.has_lander} />
                      <Typography variant="body2">
                        {detail.lander_layer.has_lander ? 'Yes' : 'No'}
                      </Typography>
                    </Box>
                  </Box>
                  {detail.lander_layer.platforms.length > 0 && (
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="body2" color="text.secondary">Platforms</Typography>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        {detail.lander_layer.platforms.map((p) => (
                          <Chip key={p} label={p.replace('_', ' ')} size="small" />
                        ))}
                      </Box>
                    </Box>
                  )}
                  {!detail.lander_layer.has_lander && (
                    <Typography variant="caption" color="text.secondary" fontStyle="italic">
                      No landing page or website detected. Conversion tracking unavailable.
                    </Typography>
                  )}
                </CardContent>
              </Card>

              {/* Lead Quality */}
              <Card>
                <CardContent>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                    <PeopleIcon fontSize="small" />
                    <Typography variant="subtitle1" fontWeight={600}>Lead Quality</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                    <Typography variant="body2" color="text.secondary">CRM Connected</Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                      <StatusIcon ok={detail.lead_quality_layer.has_crm} />
                      <Typography variant="body2">
                        {detail.lead_quality_layer.has_crm ? 'Yes' : 'No'}
                      </Typography>
                    </Box>
                  </Box>
                  {detail.lead_quality_layer.platforms.length > 0 && (
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                      <Typography variant="body2" color="text.secondary">Channels</Typography>
                      <Box sx={{ display: 'flex', gap: 0.5 }}>
                        {detail.lead_quality_layer.platforms.map((p) => (
                          <Chip key={p} label={p.replace('_', ' ')} size="small" />
                        ))}
                      </Box>
                    </Box>
                  )}
                  {!detail.lead_quality_layer.has_crm && (
                    <Typography variant="caption" color="text.secondary" fontStyle="italic">
                      No CRM or lead capture integration detected.
                    </Typography>
                  )}
                </CardContent>
              </Card>
            </Box>

            {/* Creative Variety */}
            <Card>
              <CardContent>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <PaletteIcon fontSize="small" />
                  <Typography variant="h6">Creative Variety</Typography>
                </Box>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Diversity of ad creatives and spend distribution
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 2 }}>
                  <Box sx={{ textAlign: 'center', p: 1.5, bgcolor: 'action.hover', borderRadius: 2 }}>
                    <Typography variant="h5" fontWeight={700}>
                      {detail.creative_variety.distinct_creatives}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Distinct Creatives
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: 'center', p: 1.5, bgcolor: 'action.hover', borderRadius: 2 }}>
                    <Typography
                      variant="h5"
                      fontWeight={700}
                      color={detail.creative_variety.cannibalization_warning ? 'warning.main' : 'success.main'}
                    >
                      {detail.creative_variety.cannibalization_warning ? 'Yes' : 'No'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Cannibalization Risk
                    </Typography>
                  </Box>
                  <Box sx={{ textAlign: 'center', p: 1.5, bgcolor: 'action.hover', borderRadius: 2 }}>
                    <Typography
                      variant="h5"
                      fontWeight={700}
                      color={detail.creative_variety.fatigue_warning ? 'warning.main' : 'success.main'}
                    >
                      {detail.creative_variety.fatigue_warning ? 'Yes' : 'No'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      Fatigue Warning
                    </Typography>
                  </Box>
                </Box>
                {detail.creative_variety.top_creatives &&
                  detail.creative_variety.top_creatives.length > 0 && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
                        Top Creatives by Spend
                      </Typography>
                      {detail.creative_variety.top_creatives.map((c) => (
                        <Box key={c.id} sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                          <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                            {c.name}
                          </Typography>
                          <Box sx={{ width: 100 }}>
                            <LinearProgress
                              variant="determinate"
                              value={Math.min(c.spend_pct, 100)}
                              sx={{ height: 8, borderRadius: 4 }}
                            />
                          </Box>
                          <Typography variant="caption" color="text.secondary" sx={{ width: 40, textAlign: 'right' }}>
                            {c.spend_pct}%
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  )}
              </CardContent>
            </Card>

            {/* Notes */}
            <Card>
              <CardContent>
                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 0.5 }}>
                  Quick Notes
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                  Add context or status updates for this client
                </Typography>
                <TextField
                  multiline
                  rows={3}
                  fullWidth
                  placeholder="e.g. Transitioning to DIY, awaiting lander pivot..."
                  value={notes[selectedClient.userId] || ''}
                  onChange={(e) =>
                    setNotes((prev) => ({ ...prev, [selectedClient.userId]: e.target.value }))
                  }
                  sx={{ mb: 2 }}
                />
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<SaveIcon />}
                  onClick={() => handleSaveNote(selectedClient.userId)}
                  disabled={savingNote}
                >
                  {savingNote ? 'Saving...' : 'Save Note'}
                </Button>
              </CardContent>
            </Card>
          </Box>
        )}
      </Box>
    );
  }

  // ------------------------------------------------------------------
  // List View
  // ------------------------------------------------------------------
  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3 }}>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Client Health
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Monitor client health across ads, landers, and lead capture
          </Typography>
        </Box>
        <Button
          variant="outlined"
          size="small"
          startIcon={<RefreshIcon />}
          onClick={fetchClients}
          disabled={loading}
        >
          Refresh
        </Button>
      </Box>

      {/* Loading */}
      {loading && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} variant="rounded" height={64} />
          ))}
        </Box>
      )}

      {/* Error */}
      {error && !loading && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {/* Empty */}
      {!loading && !error && clients.length === 0 && (
        <Box sx={{ textAlign: 'center', py: 8, color: 'text.disabled' }}>
          <PeopleIcon sx={{ fontSize: 48 }} />
          <Typography variant="h6" sx={{ mt: 1 }}>
            No clients found
          </Typography>
          <Typography variant="body2">There are no client accounts to display.</Typography>
        </Box>
      )}

      {/* Summary + List */}
      {!loading && !error && clients.length > 0 && (
        <>
          {/* Summary cards */}
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, mb: 3 }}>
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 2, '&:last-child': { pb: 2 } }}>
                <Typography variant="h4" fontWeight={700}>{clients.length}</Typography>
                <Typography variant="caption" color="text.secondary">Total Clients</Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 2, '&:last-child': { pb: 2 } }}>
                <Typography variant="h4" fontWeight={700} color="success.main">
                  {clients.filter((c) => deriveQuickStatus(c) === 'healthy').length}
                </Typography>
                <Typography variant="caption" color="text.secondary">Healthy</Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 2, '&:last-child': { pb: 2 } }}>
                <Typography variant="h4" fontWeight={700} color="warning.main">
                  {clients.filter((c) => deriveQuickStatus(c) === 'mediocre').length}
                </Typography>
                <Typography variant="caption" color="text.secondary">Mediocre</Typography>
              </CardContent>
            </Card>
            <Card>
              <CardContent sx={{ textAlign: 'center', py: 2, '&:last-child': { pb: 2 } }}>
                <Typography variant="h4" fontWeight={700} color="error.main">
                  {clients.filter(
                    (c) => deriveQuickStatus(c) === 'at-risk' || deriveQuickStatus(c) === 'blocked'
                  ).length}
                </Typography>
                <Typography variant="caption" color="text.secondary">At Risk / Blocked</Typography>
              </CardContent>
            </Card>
          </Box>

          {/* Client rows */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {clients.map((client) => {
              const status = deriveQuickStatus(client);
              const config = STATUS_CONFIG[status];

              return (
                <Card
                  key={client.userId}
                  sx={{ cursor: 'pointer', '&:hover': { boxShadow: 3 }, transition: 'box-shadow 0.2s' }}
                  onClick={() => fetchClientDetail(client)}
                >
                  <CardContent sx={{ py: 1.5, px: 2, '&:last-child': { pb: 1.5 } }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      {/* Name */}
                      <Box sx={{ minWidth: 0, flex: 1 }}>
                        <Typography variant="subtitle2" noWrap>
                          {client.displayName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap component="div">
                          {client.email}
                        </Typography>
                      </Box>

                      {/* Status chip */}
                      <Chip label={config.label} color={config.color} size="small" />

                      {/* Quick indicators */}
                      <Box sx={{ display: { xs: 'none', sm: 'flex' }, gap: 1.5, alignItems: 'center' }}>
                        <Tooltip title={client.has_ads ? 'Ads connected' : 'No ad account'}>
                          <CampaignIcon
                            fontSize="small"
                            sx={{ color: client.has_ads ? 'success.main' : 'error.light' }}
                          />
                        </Tooltip>
                        <Tooltip title={client.has_lander ? 'Lander detected' : 'No lander'}>
                          <LanguageIcon
                            fontSize="small"
                            sx={{ color: client.has_lander ? 'success.main' : 'error.light' }}
                          />
                        </Tooltip>
                        <Tooltip title={client.has_crm ? 'CRM connected' : 'No CRM'}>
                          <PeopleIcon
                            fontSize="small"
                            sx={{ color: client.has_crm ? 'success.main' : 'error.light' }}
                          />
                        </Tooltip>
                      </Box>

                      {/* Summary */}
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        noWrap
                        sx={{ display: { xs: 'none', md: 'block' }, width: 180 }}
                      >
                        {quickSummary(client)}
                      </Typography>

                      {/* Last activity */}
                      <Box
                        sx={{
                          display: { xs: 'none', lg: 'flex' },
                          alignItems: 'center',
                          gap: 0.5,
                        }}
                      >
                        <AccessTimeIcon sx={{ fontSize: 14, color: 'text.disabled' }} />
                        <Typography variant="caption" color="text.secondary">
                          {formatRelativeTime(client.last_activity)}
                        </Typography>
                      </Box>

                      <ChevronRightIcon fontSize="small" color="disabled" />
                    </Box>
                  </CardContent>
                </Card>
              );
            })}
          </Box>
        </>
      )}
    </Box>
  );
}
