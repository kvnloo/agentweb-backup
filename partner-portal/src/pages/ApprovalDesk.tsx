/**
 * ENG-1853 — the Approval Desk: one authenticated page per manifest (a
 * campaign/account's packet of pending decisions), replacing the noisy
 * #eval-queue Slack stream with a real review surface. Admin only.
 *
 * Two views in one component (mirrors CreativeCalibration.tsx's single-file,
 * route-param-driven shape): a queue of the caller's own pending manifests,
 * and one manifest's full packet with a sticky decision rail — packet on the
 * left (what you need to know), decisions on the right (what you must
 * decide), per the prototype's own information-hierarchy finding
 * (artifact-eng1853-prototype). Approve All only enables once every item the
 * caller can see has its own individual verdict recorded — server-enforced,
 * this is just mirroring that gate in the UI.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useParams } from 'react-router-dom';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  LinearProgress,
  Link,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { buildApiUrl } from '../config';
import { useAuth } from '../contexts/AuthContext';

type Verdict = 'approve' | 'reject' | 'edit';

interface ApprovalDecisionView {
  decisionId: string;
  gateType: 'meta_write' | 'plan_choice' | 'customer_credential' | 'customer_confirmation';
  subjectLabel: string;
  subjectContactEmail?: string;
  businessImpact: string;
  evidencePacket: { chatUrl?: string; researchSummary?: string; links?: string[]; screenshots?: string[] };
  options?: Array<{ id: string; label: string; consequence: string; recommended?: boolean; why?: string }>;
  status: string;
  verdict?: Verdict;
  freeText?: string;
  expiresAt: string;
  executionResult?: { success: boolean; message?: string; appliedObjectId?: string; at: string };
}

interface ManifestSummary {
  manifestId: string;
  subjectLabel?: string;
  itemCount: number;
  earliestExpiresAt: string;
}

function apiMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || fallback;
  }
  return fallback;
}

const RESOLVED_STATUSES = new Set(['approved', 'rejected', 'edited', 'dispatching', 'executed', 'execution_failed']);

function ManifestQueue() {
  const { token, user } = useAuth();
  const [manifests, setManifests] = useState<ManifestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get<{ manifests: ManifestSummary[] }>(buildApiUrl('/api/approval-desk/queue'), {
        headers: { Authorization: `Bearer ${token}` },
      });
      setManifests(res.data.manifests);
    } catch (err) {
      setError(apiMessage(err, 'Failed to load the approval queue.'));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (user?.isAdmin) void load();
  }, [user?.isAdmin, load]);

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <FactCheckIcon />
        <Typography variant="h5">Approval Desk</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Your pending decisions, grouped by campaign/account packet — one page per packet instead of one
        Slack message per item.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {!loading && manifests.length === 0 && !error && (
        <Typography color="text.secondary">Nothing waiting on you right now.</Typography>
      )}

      <Stack spacing={2}>
        {manifests.map((m) => (
          <Card key={m.manifestId} variant="outlined">
            <CardContent>
              <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={1}>
                <Box>
                  <Typography variant="subtitle1">{m.subjectLabel || m.manifestId}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {m.itemCount} item{m.itemCount === 1 ? '' : 's'} · earliest expiry {new Date(m.earliestExpiresAt).toLocaleString()}
                  </Typography>
                </Box>
                <Button component={RouterLink} to={`/approval-desk/${encodeURIComponent(m.manifestId)}`} variant="contained">
                  Review
                </Button>
              </Stack>
            </CardContent>
          </Card>
        ))}
      </Stack>
    </Box>
  );
}

// What you need to know about one call — read-only, lives in the packet
// column (left). Includes the creative compare/preview behavior: every
// screenshot the evidence packet carries renders side by side, per the
// prototype's own "a real crop problem is visible without downloading
// anything" finding (artifact-eng1853-prototype) — this was previously
// collected (evidencePacket.screenshots) but never rendered anywhere.
function EvidenceCard({ index, decision }: { index: number; decision: ApprovalDecisionView }) {
  const answered = RESOLVED_STATUSES.has(decision.status);
  return (
    <Card variant="outlined" id={`call-${decision.decisionId}`}>
      <CardContent>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Typography variant="subtitle1">{index}. {decision.subjectLabel}</Typography>
            <Chip
              size="small"
              label={decision.status.replace(/_/g, ' ')}
              color={
                decision.status === 'execution_failed' ? 'error'
                  : answered ? 'success'
                  : 'default'
              }
            />
          </Stack>
          <Typography variant="body2">{decision.businessImpact}</Typography>
          {decision.evidencePacket?.researchSummary && (
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
              {decision.evidencePacket.researchSummary}
            </Typography>
          )}
          {decision.evidencePacket?.screenshots && decision.evidencePacket.screenshots.length > 0 && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 1 }}>
              {decision.evidencePacket.screenshots.map((src) => (
                <Box
                  key={src}
                  component="img"
                  src={src}
                  alt={`${decision.subjectLabel} — creative preview`}
                  sx={{ width: '100%', height: 180, objectFit: 'contain', bgcolor: 'action.hover', borderRadius: 1 }}
                />
              ))}
            </Box>
          )}
          {decision.evidencePacket?.links?.map((l) => (
            <Link key={l} href={l} target="_blank" rel="noopener">{l}</Link>
          ))}
          {decision.options && decision.options.length > 0 && (
            <Stack spacing={0.5}>
              {decision.options.map((o) => (
                <Typography key={o.id} variant="body2">
                  <strong>{o.label}</strong>{o.recommended ? ' (recommended)' : ''} — {o.consequence}
                </Typography>
              ))}
            </Stack>
          )}
          {answered && (
            <Alert severity={decision.status === 'execution_failed' ? 'error' : 'success'} sx={{ mt: 1 }}>
              {decision.verdict ? `You chose: ${decision.verdict}.` : ''}
              {decision.executionResult?.message ? ` ${decision.executionResult.message}` : ''}
            </Alert>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

// What you must decide about one call — lives in the sticky rail (right),
// compact by design so every call in the packet is visible at once without
// pagination or a per-item modal, per the prototype's own density finding.
function DecisionRailItem({
  index,
  decision,
  disabled,
  onAnswer,
}: {
  index: number;
  decision: ApprovalDecisionView;
  disabled: boolean;
  onAnswer: (verdict: Verdict, freeText?: string) => Promise<void>;
}) {
  const [freeText, setFreeText] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [acting, setActing] = useState<Verdict | null>(null);
  const answered = RESOLVED_STATUSES.has(decision.status);

  const act = async (verdict: Verdict) => {
    setActing(verdict);
    try {
      await onAnswer(verdict, freeText || undefined);
    } finally {
      setActing(null);
    }
  };

  // Approval language states the actual effect, never a generic "Submit" —
  // per the prototype's own taste-gate finding.
  const approveLabel = decision.gateType === 'meta_write' ? 'Approve' : 'Go with this';
  const rejectLabel = decision.gateType === 'meta_write' ? 'Reject' : 'Send back';

  return (
    <Box
      component="a"
      href={`#call-${decision.decisionId}`}
      sx={{ display: 'block', textDecoration: 'none', color: 'inherit', py: 1.25, borderBottom: 1, borderColor: 'divider' }}
    >
      <Stack spacing={0.75}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={1}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {index}. {decision.subjectLabel}
          </Typography>
          <Chip
            size="small"
            label={decision.status.replace(/_/g, ' ')}
            color={decision.status === 'execution_failed' ? 'error' : answered ? 'success' : 'default'}
          />
        </Stack>

        {answered ? (
          <Typography variant="caption" color="text.secondary">
            {decision.verdict ? `Chose: ${decision.verdict}` : ''}
          </Typography>
        ) : (
          <Stack spacing={0.75} onClick={(e) => e.preventDefault()}>
            <Stack direction="row" spacing={1}>
              <Button
                size="small"
                variant="contained"
                color="success"
                disabled={disabled || acting !== null}
                onClick={() => void act('approve')}
              >
                {acting === 'approve' ? 'Saving…' : approveLabel}
              </Button>
              <Button
                size="small"
                variant="outlined"
                color="error"
                disabled={disabled || acting !== null}
                onClick={() => void act('reject')}
              >
                {acting === 'reject' ? 'Saving…' : rejectLabel}
              </Button>
              {decision.gateType !== 'meta_write' && !showNote && (
                <Button size="small" disabled={disabled || acting !== null} onClick={() => setShowNote(true)}>
                  + correction
                </Button>
              )}
            </Stack>
            {showNote && decision.gateType !== 'meta_write' && (
              <Stack spacing={0.5}>
                <TextField
                  label="What exactly should change?"
                  size="small"
                  multiline
                  minRows={1}
                  value={freeText}
                  disabled={disabled || acting !== null}
                  onChange={(e) => setFreeText(e.target.value)}
                  inputProps={{ maxLength: 2000 }}
                  autoFocus
                />
                <Button
                  size="small"
                  variant="outlined"
                  disabled={disabled || acting !== null || !freeText}
                  onClick={() => void act('edit')}
                >
                  {acting === 'edit' ? 'Saving…' : 'Send back with this correction'}
                </Button>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

function ManifestDetail({ manifestId }: { manifestId: string }) {
  const { token } = useAuth();
  const [decisions, setDecisions] = useState<ApprovalDecisionView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvingAll, setApprovingAll] = useState(false);
  const [approveAllError, setApproveAllError] = useState<string | null>(null);
  const [approveAllResult, setApproveAllResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await axios.get<{ decisions: ApprovalDecisionView[] }>(
        buildApiUrl(`/api/approval-desk/manifest/${encodeURIComponent(manifestId)}`),
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setDecisions(res.data.decisions);
    } catch (err) {
      setError(apiMessage(err, 'Failed to load this manifest.'));
    } finally {
      setLoading(false);
    }
  }, [manifestId, token]);

  useEffect(() => { void load(); }, [load]);

  const answer = async (decisionId: string, verdict: Verdict, freeText?: string) => {
    try {
      const res = await axios.post<{ decision: ApprovalDecisionView }>(
        buildApiUrl(`/api/approval-desk/decision/${encodeURIComponent(decisionId)}/verdict`),
        { verdict, freeText },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setDecisions((prev) => prev.map((d) => (d.decisionId === decisionId ? res.data.decision : d)));
    } catch (err) {
      setError(apiMessage(err, 'Failed to record your answer.'));
    }
  };

  const allAnswered = decisions.length > 0 && decisions.every((d) => RESOLVED_STATUSES.has(d.status));
  const answeredCount = decisions.filter((d) => RESOLVED_STATUSES.has(d.status)).length;
  const hasMetaWrite = decisions.some((d) => d.gateType === 'meta_write');

  const approveAll = async () => {
    setApprovingAll(true);
    setApproveAllError(null);
    setApproveAllResult(null);
    try {
      const res = await axios.post<{ outcome: string; summary?: { status: string } }>(
        buildApiUrl(`/api/approval-desk/manifest/${encodeURIComponent(manifestId)}/approve-all`),
        {},
        { headers: { Authorization: `Bearer ${token}` } },
      );
      setApproveAllResult(
        res.data.summary
          ? `Dispatched — ${res.data.summary.status.replace(/_/g, ' ')}.`
          : 'No Meta writes in this packet needed dispatching — already resumed.',
      );
      await load();
    } catch (err) {
      setApproveAllError(apiMessage(err, 'Failed to execute this manifest.'));
    } finally {
      setApprovingAll(false);
    }
  };

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <FactCheckIcon />
        <Typography variant="h5">{decisions[0]?.subjectLabel || 'Approval packet'}</Typography>
      </Stack>
      <Link component={RouterLink} to="/approval-desk" sx={{ display: 'inline-block', mb: 2 }}>← Back to queue</Link>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {/* Packet on the left (what you need to know), decisions on the right
          in a sticky rail (what you must decide) — per the prototype's own
          information-hierarchy finding (artifact-eng1853-prototype). Stacks
          to a single column on small screens. */}
      <Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 3, alignItems: 'flex-start' }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack spacing={2}>
            {decisions.map((d, i) => (
              <EvidenceCard key={d.decisionId} index={i + 1} decision={d} />
            ))}
          </Stack>
        </Box>

        <Box
          sx={{
            width: { xs: '100%', md: 360 },
            flexShrink: 0,
            position: { md: 'sticky' },
            top: { md: 16 },
            maxHeight: { md: 'calc(100vh - 32px)' },
            overflowY: { md: 'auto' },
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            bgcolor: 'background.paper',
          }}
        >
          <Box sx={{ px: 2, pt: 1.5, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
            <Stack direction="row" justifyContent="space-between" alignItems="baseline">
              <Typography variant="subtitle2">The calls</Typography>
              <Typography variant="caption" color="text.secondary">{answeredCount}/{decisions.length} answered</Typography>
            </Stack>
          </Box>
          <Box sx={{ px: 2 }}>
            {decisions.map((d, i) => (
              <DecisionRailItem
                key={d.decisionId}
                index={i + 1}
                decision={d}
                disabled={approvingAll}
                onAnswer={(v, ft) => answer(d.decisionId, v, ft)}
              />
            ))}
          </Box>

          {hasMetaWrite && (
            <Box sx={{ p: 2 }}>
              {approveAllError && <Alert severity="error" sx={{ mb: 1 }}>{approveAllError}</Alert>}
              {approveAllResult && <Alert severity="success" sx={{ mb: 1 }}>{approveAllResult}</Alert>}
              <Button
                fullWidth
                variant="contained"
                disabled={!allAnswered || approvingAll}
                onClick={() => void approveAll()}
              >
                {approvingAll ? 'Executing…' : allAnswered ? 'Approve All — dispatch and read back' : 'Answer every item to enable Approve All'}
              </Button>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export default function ApprovalDesk() {
  const { user } = useAuth();
  const { manifestId } = useParams();

  if (!user?.isAdmin) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <FactCheckIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
        <Typography variant="h6" sx={{ mt: 2 }}>Admin access required</Typography>
      </Box>
    );
  }

  if (manifestId) return <ManifestDetail manifestId={manifestId} />;
  return <ManifestQueue />;
}
