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
  evidencePacket: { chatUrl?: string; researchSummary?: string; links?: string[] };
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

function DecisionCard({
  decision,
  disabled,
  onAnswer,
}: {
  decision: ApprovalDecisionView;
  disabled: boolean;
  onAnswer: (verdict: Verdict, freeText?: string) => Promise<void>;
}) {
  const [freeText, setFreeText] = useState('');
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
  const approveLabel = decision.gateType === 'meta_write' ? 'Approve this change' : 'Go with this';
  const rejectLabel = decision.gateType === 'meta_write' ? 'Reject it' : 'Send back';

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Typography variant="subtitle1">{decision.subjectLabel}</Typography>
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

          {answered ? (
            <Alert severity={decision.status === 'execution_failed' ? 'error' : 'success'} sx={{ mt: 1 }}>
              {decision.verdict ? `You chose: ${decision.verdict}.` : ''}
              {decision.executionResult?.message ? ` ${decision.executionResult.message}` : ''}
            </Alert>
          ) : (
            <Stack spacing={1} sx={{ mt: 1 }}>
              <TextField
                label="Correction note (used only if you send this back)"
                size="small"
                multiline
                minRows={1}
                value={freeText}
                disabled={disabled || acting !== null}
                onChange={(e) => setFreeText(e.target.value)}
                inputProps={{ maxLength: 2000 }}
              />
              <Stack direction="row" spacing={1}>
                <Button
                  variant="contained"
                  color="success"
                  disabled={disabled || acting !== null}
                  onClick={() => void act('approve')}
                >
                  {acting === 'approve' ? 'Saving…' : approveLabel}
                </Button>
                <Button
                  variant="outlined"
                  color="error"
                  disabled={disabled || acting !== null}
                  onClick={() => void act('reject')}
                >
                  {acting === 'reject' ? 'Saving…' : rejectLabel}
                </Button>
                {decision.gateType !== 'meta_write' && (
                  <Button
                    variant="outlined"
                    disabled={disabled || acting !== null || !freeText}
                    onClick={() => void act('edit')}
                  >
                    {acting === 'edit' ? 'Saving…' : 'Send back with a correction'}
                  </Button>
                )}
              </Stack>
            </Stack>
          )}
        </Stack>
      </CardContent>
    </Card>
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

      <Stack spacing={2}>
        {decisions.map((d) => (
          <DecisionCard key={d.decisionId} decision={d} disabled={approvingAll} onAnswer={(v, ft) => answer(d.decisionId, v, ft)} />
        ))}
      </Stack>

      {hasMetaWrite && (
        <Box sx={{ position: 'sticky', bottom: 0, mt: 3, py: 2, bgcolor: 'background.paper', borderTop: 1, borderColor: 'divider' }}>
          {approveAllError && <Alert severity="error" sx={{ mb: 1 }}>{approveAllError}</Alert>}
          {approveAllResult && <Alert severity="success" sx={{ mb: 1 }}>{approveAllResult}</Alert>}
          <Button
            variant="contained"
            size="large"
            disabled={!allAnswered || approvingAll}
            onClick={() => void approveAll()}
          >
            {approvingAll ? 'Executing…' : allAnswered ? 'Approve All — dispatch and read back' : 'Answer every item to enable Approve All'}
          </Button>
        </Box>
      )}
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
