import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SyncIcon from '@mui/icons-material/Sync';
import TuneIcon from '@mui/icons-material/Tune';
import { useAuth } from '../../contexts/AuthContext';
import {
  clearTasteProfile,
  getConnectedAccounts,
  getTasteApplication,
  getTasteProfile,
  getTasteSettings,
  importTasteCollection,
  refreshTasteFromX,
  updateTasteSettings,
  type ConnectedAccount,
  type TasteApplication,
  type TasteIntensity,
  type TasteProfile,
  type TasteSettings,
  type TasteSurface,
} from '../../services/tasteService';

const SURFACE_COPY: Array<{
  id: TasteSurface;
  label: string;
  description: string;
  group: 'Creative' | 'Content' | 'Operational';
}> = [
  { id: 'landing_page', label: 'Landing pages', description: 'Layout, type, motion, density, and design-system choices.', group: 'Creative' },
  { id: 'image', label: 'Images', description: 'Art direction, composition, material, and visual rhythm.', group: 'Creative' },
  { id: 'video', label: 'Video', description: 'Pacing, framing, transitions, typography, and visual world.', group: 'Creative' },
  { id: 'brand', label: 'Brand exploration', description: 'Idea generation only; saved brand guidelines still win.', group: 'Creative' },
  { id: 'social', label: 'Social content', description: 'Angles, rhythm, specificity, and presentation.', group: 'Content' },
  { id: 'ad_creative', label: 'Ad creative', description: 'Creative prior only; performance, offer, and policy stay authoritative.', group: 'Content' },
  { id: 'editorial', label: 'Blog & editorial', description: 'Structure, pacing, examples, and visual/editorial character.', group: 'Content' },
  { id: 'research', label: 'Research presentation', description: 'Ranks examples and presentation style; never changes findings.', group: 'Content' },
  { id: 'reply_curation', label: 'Reply curation', description: 'Helps rank complete, fresh candidates; never fabricates one.', group: 'Content' },
  { id: 'email', label: 'Email', description: 'Off by default. Explicit voice and brand guidance are safer.', group: 'Operational' },
  { id: 'crm', label: 'CRM & lifecycle', description: 'Off by default. Customer records and lifecycle stay objective.', group: 'Operational' },
  { id: 'analytics', label: 'Analytics', description: 'Off by default. Measurements and attribution never bend to taste.', group: 'Operational' },
];

function errorMessage(error: any): string {
  return error?.response?.data?.error
    || error?.response?.data?.message
    || error?.message
    || 'Something went wrong.';
}

function parseReferenceLines(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const first = parts[0];
      if (/^https?:\/\//i.test(first)) {
        const text = parts.slice(1).join(' ').trim();
        return { url: first, ...(text ? { text } : {}) };
      }
      return { title: line };
    });
}

const TasteCenter: React.FC = () => {
  const { token } = useAuth();
  const [profile, setProfile] = useState<TasteProfile | null>(null);
  const [settings, setSettings] = useState<TasteSettings | null>(null);
  const [preview, setPreview] = useState<TasteApplication | null>(null);
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [selectedX, setSelectedX] = useState('');
  const [references, setReferences] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const xAccounts = useMemo(
    () => accounts.filter((account) => (
      account.platform === 'twitter'
      && account.status !== 'disconnected'
      && account.owned !== false
    )),
    [accounts],
  );

  const load = async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const [nextProfile, nextSettings, nextAccounts, nextPreview] = await Promise.all([
        getTasteProfile(token),
        getTasteSettings(token),
        getConnectedAccounts(token),
        getTasteApplication(token, 'landing_page'),
      ]);
      setProfile(nextProfile);
      setSettings(nextSettings);
      setAccounts(nextAccounts);
      setPreview(nextPreview);
      const firstX = nextAccounts.find((account) => (
        account.platform === 'twitter'
        && account.status !== 'disconnected'
        && account.owned !== false
      ));
      if (firstX) setSelectedX((current) => current || firstX.account_id);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const refreshPreview = async () => {
    if (!token) return;
    try {
      setPreview(await getTasteApplication(token, 'landing_page'));
    } catch {
      // Preview is secondary; profile/settings remain usable if it fails.
    }
  };

  const handleXRefresh = async () => {
    if (!token || !selectedX) return;
    setBusy('x');
    setError('');
    setNotice('');
    try {
      const nextProfile = await refreshTasteFromX(token, selectedX);
      setProfile(nextProfile);
      setNotice('Taste refreshed from your X bookmarks. Raw bookmark text was not saved.');
      await refreshPreview();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleReferenceImport = async () => {
    if (!token) return;
    const items = parseReferenceLines(references);
    if (items.length === 0) {
      setError('Add at least one reference or note.');
      return;
    }
    setBusy('references');
    setError('');
    setNotice('');
    try {
      const nextProfile = await importTasteCollection(token, items, 'manual-references');
      setProfile(nextProfile);
      setReferences('');
      setNotice('References added. Emma retained only aggregate taste signals.');
      await refreshPreview();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const handleIntensity = async (surface: TasteSurface, value: TasteIntensity | null) => {
    if (!token || !settings || !value) return;
    const previous = settings;
    const optimistic: TasteSettings = {
      ...settings,
      surfaces: { ...settings.surfaces, [surface]: value },
    };
    setSettings(optimistic);
    setError('');
    try {
      const saved = await updateTasteSettings(token, { [surface]: value });
      setSettings(saved);
      if (surface === 'landing_page') await refreshPreview();
    } catch (err) {
      setSettings(previous);
      setError(errorMessage(err));
    }
  };

  const handleClear = async () => {
    if (!token) return;
    setBusy('clear');
    setError('');
    setNotice('');
    try {
      await clearTasteProfile(token);
      setConfirmClear(false);
      setNotice('Learned Taste signals cleared. Your per-surface defaults are unchanged.');
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  if (loading) {
    return (
      <Box sx={{ minHeight: '60vh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress aria-label="Loading Taste" />
      </Box>
    );
  }

  const hasTaste = Boolean(profile && profile.sourceCount > 0);
  const signalNames = profile?.styleSignals?.map((signal) => signal.name) || [];
  const dials = preview?.dials;

  return (
    <Container maxWidth="md" sx={{ py: { xs: 4, md: 7 } }}>
      <Stack spacing={1.5} sx={{ mb: 5 }}>
        <Stack direction="row" spacing={1.25} alignItems="center">
          <AutoAwesomeIcon aria-hidden />
          <Typography variant="h3" component="h1" fontWeight={700}>
            Taste
          </Typography>
        </Stack>
        <Typography variant="h6" color="text.secondary" fontWeight={400}>
          Emma learns what you like. Your brief, brand, audience, accessibility, and facts still win.
        </Typography>
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>}
      {notice && <Alert severity="success" sx={{ mb: 3 }}>{notice}</Alert>}

      <Stack spacing={3}>
        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 2.5, md: 3.5 } }}>
            <Stack spacing={3}>
              <Box>
                <Typography variant="overline" color="text.secondary">Your creative fingerprint</Typography>
                <Typography variant="h5" fontWeight={650}>
                  {hasTaste
                    ? String(profile?.itemCount || 0) + ' references across ' + String(profile?.sourceCount || 0) + ' sources'
                    : 'No learned Taste yet'}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                  Emma stores aggregate signals only. It does not keep raw bookmark text in your Taste Profile.
                </Typography>
              </Box>

              {signalNames.length > 0 ? (
                <Stack direction="row" gap={1} flexWrap="wrap">
                  {signalNames.map((signal) => (
                    <Chip key={signal} label={signal} size="small" />
                  ))}
                </Stack>
              ) : (
                <Typography variant="body2" color="text.secondary">
                  Add sources below. Repeated signals become stronger; one-off private phrases are intentionally ignored.
                </Typography>
              )}

              {dials && hasTaste && (
                <>
                  <Divider />
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3}>
                    <Box>
                      <Typography variant="caption" color="text.secondary">Design variance</Typography>
                      <Typography variant="h6">{dials.designVariance}/10</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">Motion</Typography>
                      <Typography variant="h6">{dials.motionIntensity}/10</Typography>
                    </Box>
                    <Box>
                      <Typography variant="caption" color="text.secondary">Visual density</Typography>
                      <Typography variant="h6">{dials.visualDensity}/10</Typography>
                    </Box>
                  </Stack>
                </>
              )}
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 2.5, md: 3.5 } }}>
            <Typography variant="h5" fontWeight={650} sx={{ mb: 0.75 }}>Teach Emma</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              Import is always explicit. Connecting an account alone never teaches Taste.
            </Typography>

            <Stack spacing={3}>
              <Box>
                <Typography variant="subtitle1" fontWeight={650}>X bookmarks</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Learn recurring visual and editorial preferences from an X account you already connected.
                </Typography>

                {xAccounts.length > 0 ? (
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                    <FormControl size="small" sx={{ minWidth: 220 }}>
                      <InputLabel id="taste-x-account-label">X account</InputLabel>
                      <Select
                        labelId="taste-x-account-label"
                        label="X account"
                        value={selectedX}
                        onChange={(event) => setSelectedX(String(event.target.value))}
                      >
                        {xAccounts.map((account) => (
                          <MenuItem key={account.account_id} value={account.account_id}>
                            {account.account_handle || account.account_name || 'Connected X account'}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <Button
                      variant="contained"
                      startIcon={busy === 'x' ? <CircularProgress size={16} /> : <SyncIcon />}
                      onClick={handleXRefresh}
                      disabled={!selectedX || busy !== null}
                    >
                      Learn from bookmarks
                    </Button>
                  </Stack>
                ) : (
                  <Alert severity="info">
                    Connect an X account in Connected Accounts first. Emma will never ask you to paste an access token here.
                  </Alert>
                )}
              </Box>

              <Divider />

              <Box>
                <Typography variant="subtitle1" fontWeight={650}>Reference collection</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                  Paste links or short notes, one per line. For a link, add a few words after it if you want to describe what you like.
                </Typography>
                <TextField
                  value={references}
                  onChange={(event) => setReferences(event.target.value)}
                  multiline
                  minRows={4}
                  fullWidth
                  placeholder={'https://example.com/reference minimal type, calm motion\neditorial spacing and asymmetry\nstrong product photography'}
                  inputProps={{ 'aria-label': 'Taste references' }}
                />
                <Stack direction="row" justifyContent="flex-end" sx={{ mt: 1.5 }}>
                  <Button
                    variant="outlined"
                    onClick={handleReferenceImport}
                    disabled={!references.trim() || busy !== null}
                    startIcon={busy === 'references' ? <CircularProgress size={16} /> : <AutoAwesomeIcon />}
                  >
                    Add references
                  </Button>
                </Stack>
              </Box>
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 2.5, md: 3.5 } }}>
            <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 0.75 }}>
              <TuneIcon aria-hidden />
              <Typography variant="h5" fontWeight={650}>Where Emma uses Taste</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
              These are persistent defaults. In chat you can still say “more like me” or “neutral for this one” without changing them.
            </Typography>

            {(['Creative', 'Content', 'Operational'] as const).map((group, groupIndex) => (
              <Box key={group}>
                {groupIndex > 0 && <Divider sx={{ my: 3 }} />}
                <Typography variant="overline" color="text.secondary">{group}</Typography>
                <Stack spacing={2} sx={{ mt: 0.5 }}>
                  {SURFACE_COPY.filter((surface) => surface.group === group).map((surface) => (
                    <Stack
                      key={surface.id}
                      direction={{ xs: 'column', sm: 'row' }}
                      spacing={2}
                      justifyContent="space-between"
                      alignItems={{ sm: 'center' }}
                    >
                      <Box sx={{ minWidth: 0, pr: { sm: 2 } }}>
                        <Typography variant="subtitle2">{surface.label}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {surface.description}
                        </Typography>
                      </Box>
                      <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={settings?.surfaces?.[surface.id] || 'off'}
                        onChange={(_event, value) => void handleIntensity(surface.id, value)}
                        aria-label={surface.label + ' Taste intensity'}
                      >
                        <ToggleButton value="off" aria-label={surface.label + ' Taste off'}>Off</ToggleButton>
                        <ToggleButton value="subtle" aria-label={surface.label + ' Taste subtle'}>Subtle</ToggleButton>
                        <ToggleButton value="strong" aria-label={surface.label + ' Taste strong'}>Strong</ToggleButton>
                      </ToggleButtonGroup>
                    </Stack>
                  ))}
                </Stack>
              </Box>
            ))}
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent sx={{ p: { xs: 2.5, md: 3.5 } }}>
            <Typography variant="h6" fontWeight={650}>Privacy & control</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75, mb: 2 }}>
              Taste is preference, not truth. It never changes CRM records, analytics, factual research, or platform rules. Clearing learned Taste does not disconnect any account.
            </Typography>
            <Button
              color="error"
              variant="text"
              startIcon={<DeleteOutlineIcon />}
              onClick={() => setConfirmClear(true)}
              disabled={!hasTaste || busy !== null}
            >
              Clear learned Taste
            </Button>
          </CardContent>
        </Card>
      </Stack>

      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)}>
        <DialogTitle>Clear learned Taste?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This removes aggregate Taste signals learned from imported sources. It does not disconnect accounts, delete bookmarks, or reset your per-surface defaults.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmClear(false)}>Cancel</Button>
          <Button color="error" onClick={handleClear} disabled={busy !== null}>
            Clear Taste
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  );
};

export default TasteCenter;
