/**
 * Weekly creative calibration (ENG-2142, ENG-2128 T10) — admin only.
 *
 * Shows one pair of generated ad creatives at a time from the week's calibration batch (pairwise
 * golden cases drawn by the backend's weekly job) and records which is the better ad with one
 * click: left, tie or right, plus an optional note. The choice is saved through the golden-set
 * label route as A / B / tie and the next unlabelled pair opens.
 *
 * Each creative's image and generation request are loaded from the existing admin human-eval API
 * when the pair is shown. Judge verdicts, reviewer feedback, dates and which creative is newer are
 * deliberately not shown, and the sides are shuffled per pair: the choice is the ground truth the
 * rubric judge's pairwise mode is validated against.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Grid,
  LinearProgress,
  Link,
  MenuItem,
  Skeleton,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import CompareIcon from '@mui/icons-material/Compare';
import { buildApiUrl } from '../config';
import { useAuth } from '../contexts/AuthContext';
import { newerOnRight } from '../utils/calibrationSides';
import { blindForHuman } from '../utils/blindLabelling';
import type { GoldenCaseView } from './EvalLabelling';

type Choice = 'A' | 'B' | 'tie';

const PAIRWISE_CRITERION = 'pairwise_preference';
const MAX_REQUEST_CHARS = 600;

interface CandidateView {
  reviewType?: string;
  originalRequest?: string;
  artifactUrl?: string;
}

function apiMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || fallback;
  }
  return fallback;
}

function choiceOf(c: GoldenCaseView): Choice | undefined {
  const label = c.labels[PAIRWISE_CRITERION] as string | undefined;
  return label === 'A' || label === 'B' || label === 'tie' ? label : undefined;
}

function byPosition(a: GoldenCaseView, b: GoldenCaseView): number {
  return (a.pair?.position ?? 0) - (b.pair?.position ?? 0);
}

/** Height the image / iframe preview area renders at, and what the loading skeleton matches. */
const PREVIEW_HEIGHT = 520;

function CreativePanel({ candidateId, side, token }: { candidateId: string; side: string; token: string | null }) {
  const [candidate, setCandidate] = useState<CandidateView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Whether the actual image/iframe payload has finished loading, separate from `loading`
  // (which only covers the metadata fetch above) — without this the card goes straight from
  // a progress bar to a blank/broken-looking box for the ~3s the image or landing page itself
  // takes to fetch.
  const [assetLoaded, setAssetLoaded] = useState(false);
  // The generation prompt is implementation detail (hex codes, layout/font specs for ad images;
  // a long generation brief for landing pages) that a reviewer doesn't need to pick a winner, so
  // it stays collapsed unless someone asks for it.
  const [showRequest, setShowRequest] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCandidate(null);
    setAssetLoaded(false);
    setShowRequest(false);
    axios
      .get<{ candidate: CandidateView }>(buildApiUrl(`/api/human-eval/candidates/${encodeURIComponent(candidateId)}`), {
        headers: { Authorization: `Bearer ${token}` },
      })
      .then((res) => {
        if (!cancelled) setCandidate(res.data.candidate);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(apiMessage(err, 'Failed to load this creative.'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [candidateId, token]);

  const request = candidate?.originalRequest ?? '';
  const isLandingPage = candidate?.reviewType === 'landing_page';
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Typography variant="subtitle2" sx={{ mb: 1 }}>{side}</Typography>
        {loading && <LinearProgress />}
        {error && <Alert severity="error">{error}</Alert>}
        {candidate && (
          <Stack spacing={1}>
            {candidate.artifactUrl && isLandingPage ? (
              // ENG-2220: an inline preview so a reviewer can compare landing pages without
              // leaving the page. Confirmed live (curl -I) that generated pages on
              // *.agentwebforms.com / *.vercel.app send neither X-Frame-Options nor a
              // frame-ancestors CSP, so framing them directly is not blocked. No allow-forms /
              // allow-top-navigation / allow-popups: a reviewer scrolling the preview must not
              // be able to submit the page's real lead-capture form or navigate away.
              // No allow-same-origin: these are uncurated AI-generated pages loaded inside an
              // authenticated admin surface — allow-scripts alone still renders and runs
              // client-side JS for the preview, it just can't use its own origin's cookies,
              // storage or same-origin XHR, which a visual preview never needs.
              <Box sx={{ position: 'relative', width: '100%', height: PREVIEW_HEIGHT, bgcolor: 'action.hover', borderRadius: 1 }}>
                {!assetLoaded && <Skeleton variant="rectangular" width="100%" height={PREVIEW_HEIGHT} sx={{ position: 'absolute', inset: 0, borderRadius: 1 }} />}
                <Box
                  component="iframe"
                  src={candidate.artifactUrl}
                  title={`${side} landing page preview`}
                  sandbox="allow-scripts"
                  onLoad={() => setAssetLoaded(true)}
                  onError={() => setAssetLoaded(true)}
                  sx={{ width: '100%', height: '100%', border: 0, borderRadius: 1, opacity: assetLoaded ? 1 : 0, transition: 'opacity 0.15s' }}
                />
              </Box>
            ) : candidate.artifactUrl ? (
              <Box sx={{ position: 'relative', width: '100%' }}>
                {!assetLoaded && <Skeleton variant="rectangular" width="100%" height={PREVIEW_HEIGHT} sx={{ position: 'absolute', inset: 0, borderRadius: 1 }} />}
                <Box
                  component="img"
                  src={candidate.artifactUrl}
                  alt={`${side} creative`}
                  onLoad={() => setAssetLoaded(true)}
                  onError={() => setAssetLoaded(true)}
                  sx={{ width: '100%', maxHeight: PREVIEW_HEIGHT, objectFit: 'contain', bgcolor: 'action.hover', borderRadius: 1, opacity: assetLoaded ? 1 : 0, transition: 'opacity 0.15s' }}
                />
              </Box>
            ) : (
              <Alert severity="warning">This creative has no image.</Alert>
            )}
            {candidate.artifactUrl && isLandingPage && (
              <Button variant="outlined" size="small" href={candidate.artifactUrl} target="_blank" rel="noopener noreferrer">
                Open landing page in new tab
              </Button>
            )}
            {request && (
              <Box>
                <Button size="small" onClick={() => setShowRequest((v) => !v)} sx={{ textTransform: 'none', pl: 0 }}>
                  {showRequest ? 'Hide generation prompt' : 'Show generation prompt'}
                </Button>
                <Collapse in={showRequest} unmountOnExit>
                  <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                    <strong>Request:</strong> {request.length > MAX_REQUEST_CHARS ? `${request.slice(0, MAX_REQUEST_CHARS)}…` : request}
                  </Typography>
                </Collapse>
              </Box>
            )}
          </Stack>
        )}
      </CardContent>
    </Card>
  );
}

export default function CreativeCalibration() {
  const { token, user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [provisioned, setProvisioned] = useState<boolean | null>(null);
  const [cases, setCases] = useState<GoldenCaseView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ position: number; choice: Choice; newerOnRight: boolean } | null>(null);
  // A second click while a save is in flight must not send a second save.
  const savingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const status = await axios.get<{ provisioned: boolean }>(buildApiUrl('/api/admin/eval/golden-cases/status'), { headers });
      setProvisioned(status.data.provisioned);
      if (!status.data.provisioned) return;
      const res = await axios.get<{ cases: GoldenCaseView[] }>(buildApiUrl('/api/admin/eval/golden-cases?surface=creative'), { headers });
      setCases(res.data.cases.filter((c) => c.pair !== undefined).map(blindForHuman));
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 503) setProvisioned(false);
      else setError(apiMessage(err, 'Failed to load the calibration batch.'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (user?.isAdmin) void load();
  }, [user?.isAdmin, load]);

  const batches = useMemo(() => [...new Set(cases.map((c) => c.pair?.batch ?? ''))].filter(Boolean).sort().reverse(), [cases]);
  const requested = searchParams.get('batch');
  const batch = requested && batches.includes(requested) ? requested : batches[0];
  const batchCases = useMemo(() => cases.filter((c) => c.pair?.batch === batch).sort(byPosition), [cases, batch]);
  const current = batchCases.find((c) => c.caseId === currentId) ?? batchCases.find((c) => !choiceOf(c)) ?? batchCases[0] ?? null;
  const labelledCount = batchCases.filter((c) => choiceOf(c)).length;

  if (!user?.isAdmin) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <CompareIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
        <Typography variant="h6" sx={{ mt: 2 }}>Admin access required</Typography>
      </Box>
    );
  }

  const save = async (target: GoldenCaseView, choice: Choice) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaved(null);
    try {
      const res = await axios.put<{ case: GoldenCaseView }>(
        buildApiUrl(`/api/admin/eval/golden-cases/${encodeURIComponent(target.caseId)}/labels`),
        { labels: { [PAIRWISE_CRITERION]: choice }, notes: notes[target.caseId] ?? target.notes ?? '', expectedVersion: target.version },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const updated = blindForHuman(res.data.case);
      const nextCases = cases.map((c) => (c.caseId === updated.caseId ? updated : c));
      setCases(nextCases);
      setSaved({ position: target.pair?.position ?? 0, choice, newerOnRight: newerOnRight(target.caseId) });
      // Auto-advance to the next unlabelled pair after this one, wrapping round; stay when none is left.
      const ordered = nextCases.filter((c) => c.pair?.batch === batch).sort(byPosition);
      const at = ordered.findIndex((c) => c.caseId === updated.caseId);
      const next = [...ordered.slice(at + 1), ...ordered.slice(0, at)].find((c) => !choiceOf(c));
      setCurrentId(next ? next.caseId : updated.caseId);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setSaveError('Someone saved this pair after you opened it. Reload the page and choose again.');
      } else {
        setSaveError(apiMessage(err, 'Failed to save your choice.'));
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const open = (caseId: string) => {
    setCurrentId(caseId);
    setSaveError(null);
  };

  const sideLabel = (choice: Choice, onRight: boolean): string => {
    if (choice === 'tie') return 'a tie';
    const right = choice === 'A' ? onRight : !onRight;
    return right ? 'right is better' : 'left is better';
  };

  const onRight = current ? newerOnRight(current.caseId) : false;
  const leftChoice: Choice = onRight ? 'B' : 'A';
  const rightChoice: Choice = onRight ? 'A' : 'B';
  const currentChoice = current ? choiceOf(current) : undefined;

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <CompareIcon />
        <Typography variant="h5">Weekly creative calibration</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Two ads made for the same account: pick the one you would rather run. Your choices go to the golden set that
        checks the creative judge; they do not approve or block anything.{' '}
        <Link component={RouterLink} to="/eval-labelling">Eval labelling</Link>
      </Typography>

      {provisioned === false && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The golden-set store is not provisioned yet (OPS-2, ENG-2147). Calibration pairs will appear here once it is.
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {provisioned && !loading && batchCases.length === 0 && (
        <Typography color="text.secondary">No calibration batch yet. A batch of about 20 pairs is drawn each week.</Typography>
      )}

      {provisioned && batch && current && (
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}>
            {batches.length > 1 && (
              <TextField
                select
                size="small"
                label="Batch"
                value={batch}
                disabled={saving}
                onChange={(e) => {
                  setSearchParams({ batch: e.target.value });
                  setCurrentId(null);
                  setSaved(null);
                  setSaveError(null);
                }}
                sx={{ minWidth: 140 }}
              >
                {batches.map((b) => <MenuItem key={b} value={b}>{b}</MenuItem>)}
              </TextField>
            )}
            <Typography variant="subtitle2">
              {batches.length > 1 ? '' : `${batch} · `}{labelledCount} / {batchCases.length} pairs labelled
            </Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {batchCases.map((c) => (
                <Chip
                  key={c.caseId}
                  size="small"
                  label={(c.pair?.position ?? 0) + 1}
                  color={choiceOf(c) ? 'success' : 'default'}
                  variant={c.caseId === current.caseId ? 'filled' : 'outlined'}
                  onClick={saving ? undefined : () => open(c.caseId)}
                  aria-label={`Pair ${(c.pair?.position ?? 0) + 1}${choiceOf(c) ? ' (labelled)' : ''}`}
                  aria-current={c.caseId === current.caseId ? 'true' : undefined}
                />
              ))}
            </Stack>
          </Stack>

          {labelledCount === batchCases.length && (
            <Alert severity="success">All {batchCases.length} pairs in {batch} are labelled. Thank you — you can still change any choice.</Alert>
          )}
          {saved && (
            <Alert severity="success">
              Saved pair {saved.position + 1}: {sideLabel(saved.choice, saved.newerOnRight)}.
            </Alert>
          )}
          {saveError && <Alert severity="error">{saveError}</Alert>}

          <Typography variant="body2">
            <strong>Pair {(current.pair?.position ?? 0) + 1}</strong> · {current.pair?.category.replace(/_/g, ' ')} ·
            placement {current.pair?.placement.replace(/_/g, ' ')}
            {currentChoice ? ` · your choice: ${sideLabel(currentChoice, onRight)}` : ''}
          </Typography>

          <Grid container spacing={2}>
            <Grid item xs={12} md={6}>
              <CreativePanel candidateId={onRight ? current.pair?.candidateIdB ?? '' : current.sourceRef.id} side="Left" token={token} />
            </Grid>
            <Grid item xs={12} md={6}>
              <CreativePanel candidateId={onRight ? current.sourceRef.id : current.pair?.candidateIdB ?? ''} side="Right" token={token} />
            </Grid>
          </Grid>

          <TextField
            label="Note (optional)"
            size="small"
            multiline
            minRows={1}
            value={notes[current.caseId] ?? current.notes ?? ''}
            disabled={saving}
            onChange={(e) => {
              // Any edit makes the last "saved" confirmation stale.
              setSaved(null);
              const value = e.target.value;
              setNotes((prev) => ({ ...prev, [current.caseId]: value }));
            }}
            inputProps={{ maxLength: 2000 }}
          />
          <Stack direction="row" spacing={2} justifyContent="center">
            {([
              ['Left is better', leftChoice],
              ['Tie', 'tie'],
              ['Right is better', rightChoice],
            ] as const).map(([label, choice]) => (
              <Button
                key={label}
                size="large"
                variant={currentChoice === choice ? 'contained' : 'outlined'}
                aria-pressed={currentChoice === choice}
                disabled={saving}
                onClick={() => void save(current, choice)}
              >
                {label}
              </Button>
            ))}
          </Stack>
          {saving && <LinearProgress />}
        </Stack>
      )}
    </Box>
  );
}
