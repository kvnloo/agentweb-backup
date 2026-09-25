/**
 * Golden-set labelling (ENG-2135, ENG-2128 principle 2) — admin only.
 *
 * Lists the golden cases of one surface from /api/admin/eval/golden-cases, shows each case's
 * source (chat session, human-eval candidate or account) by fetching it through the existing
 * admin APIs when the case is opened — nothing here is stored with the case — and saves binary
 * pass / fail / n/a labels per criterion plus a note.
 *
 * Grader verdicts (judge scores, client-health status) are deliberately not shown: the labels
 * are the ground truth those graders are validated against.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Grid,
  LinearProgress,
  Link,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import { buildApiUrl } from '../config';
import { useAuth } from '../contexts/AuthContext';

type Surface = 'agent' | 'creative' | 'account_health';
type LabelValue = 'pass' | 'fail' | 'na';

export interface GoldenCaseView {
  caseId: string;
  surface: Surface;
  taskType: string;
  sourceRef: { kind: 'sessionId' | 'candidateId' | 'userId'; id: string };
  criteria: string[];
  labels: Partial<Record<string, LabelValue>>;
  notes?: string;
  labeller?: string;
  labelledAt?: string;
  split: 'dev' | 'test';
  version: number;
}

const SURFACES: ReadonlyArray<{ value: Surface; label: string }> = [
  { value: 'agent', label: 'Agent sessions' },
  { value: 'creative', label: 'Creatives' },
  { value: 'account_health', label: 'Account health' },
];

const CRITERION_HELP: Record<string, string> = {
  task_success: 'The task the user asked for was actually done',
  tool_correctness: 'Tools were called correctly and their results were checked',
  groundedness: 'Every claim in the reply is backed by a tool result',
  instruction_compliance: 'Explicit user instructions were followed on the first attempt',
  hook: 'Stops the scroll in the first second',
  offer: 'A clear, specific offer',
  proof_integrity: 'Proof points are real, not invented',
  brand_fidelity: 'Matches the brand colours, logo and tone',
  format_readiness: 'Right size and layout for the placement',
  policy_risk: 'Pass = no ad-policy risk',
  buyer_usefulness: 'Useful to the target buyer',
  activation_incomplete: 'Pass = the account never finished setup (never connected)',
  at_risk: 'Pass = was working, now at risk (expired, revoked, stopped)',
  healthy: 'Pass = connected and working',
};

const LABEL_OPTIONS: ReadonlyArray<{ value: LabelValue; label: string }> = [
  { value: 'pass', label: 'Pass' },
  { value: 'fail', label: 'Fail' },
  { value: 'na', label: 'N/A' },
];

const MAX_MESSAGE_CHARS = 4000;

function apiMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || fallback;
  }
  return fallback;
}

function isNotProvisioned(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 503;
}

function labelledCount(c: GoldenCaseView): number {
  return c.criteria.filter((criterion) => c.labels[criterion] !== undefined).length;
}

interface ChatMessageView {
  role: string;
  content?: unknown;
}

interface SessionView {
  title?: string;
  messages?: ChatMessageView[];
}

interface CandidateView {
  reviewType?: string;
  originalRequest?: string;
  outputSummary?: string;
  artifactUrl?: string;
  feedback?: Array<{ slackUserDisplayName?: string; text?: string; createdAt?: string }>;
}

type UserView = Record<string, unknown>;

const ACCOUNT_FIELDS: ReadonlyArray<[string, string]> = [
  ['companyName', 'Company'],
  ['subscription_status', 'Subscription status'],
  ['subscriptionType', 'Subscription type'],
  ['createdAt', 'Created'],
  ['lastLoginTime', 'Last login'],
  ['lastActiveAt', 'Last active'],
  ['funnelStatus', 'Funnel status'],
];

function SourceContext({ goldenCase, token }: { goldenCase: GoldenCaseView; token: string | null }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [candidate, setCandidate] = useState<CandidateView | null>(null);
  const [account, setAccount] = useState<UserView | null>(null);

  useEffect(() => {
    let cancelled = false;
    const headers = { Authorization: `Bearer ${token}` };
    const id = goldenCase.sourceRef.id;
    setLoading(true);
    setError(null);
    setSession(null);
    setCandidate(null);
    setAccount(null);
    const load = async () => {
      try {
        if (goldenCase.surface === 'agent') {
          const res = await axios.get<{ sessions: SessionView[] }>(buildApiUrl(`/api/admin/chat-sessions?sessionId=${encodeURIComponent(id)}`), { headers });
          if (!cancelled) setSession(res.data.sessions[0] ?? null);
        } else if (goldenCase.surface === 'creative') {
          const res = await axios.get<{ candidate: CandidateView }>(buildApiUrl(`/api/human-eval/candidates/${encodeURIComponent(id)}`), { headers });
          if (!cancelled) setCandidate(res.data.candidate);
        } else {
          const res = await axios.get<UserView>(buildApiUrl(`/api/admin/users/${encodeURIComponent(id)}`), { headers });
          if (!cancelled) setAccount(res.data);
        }
      } catch (err) {
        if (!cancelled) setError(apiMessage(err, 'Failed to load the source for this case.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [goldenCase.surface, goldenCase.sourceRef.id, token]);

  if (loading) return <LinearProgress />;
  if (error) return <Alert severity="error">{error}</Alert>;

  if (goldenCase.surface === 'agent') {
    if (!session) return <Alert severity="warning">Session not found or has no user messages.</Alert>;
    const messages = (session.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    return (
      <Stack spacing={1}>
        <Typography variant="subtitle2">{session.title || 'Untitled session'}</Typography>
        <Link href={`/agent-runs?sessionId=${encodeURIComponent(goldenCase.sourceRef.id)}`} underline="hover">
          Open tool runs in the AgentRun Inspector
        </Link>
        <Box sx={{ maxHeight: 480, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, p: 1 }}>
          {messages.map((m, i) => {
            const text = typeof m.content === 'string' ? m.content : '';
            return (
              <Box key={i} sx={{ mb: 1.5 }}>
                <Chip size="small" label={m.role} color={m.role === 'user' ? 'primary' : 'default'} sx={{ mb: 0.5 }} />
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                  {text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… (${text.length} chars)` : text}
                </Typography>
              </Box>
            );
          })}
        </Box>
      </Stack>
    );
  }

  if (goldenCase.surface === 'creative') {
    if (!candidate) return <Alert severity="warning">Candidate not found.</Alert>;
    return (
      <Stack spacing={1}>
        <Typography variant="subtitle2">{candidate.reviewType}</Typography>
        {candidate.originalRequest && <Typography variant="body2"><strong>Request:</strong> {candidate.originalRequest}</Typography>}
        {candidate.outputSummary && <Typography variant="body2"><strong>Output:</strong> {candidate.outputSummary}</Typography>}
        {candidate.artifactUrl && (candidate.reviewType === 'creative_image'
          ? <Box component="img" src={candidate.artifactUrl} alt="Generated creative" sx={{ maxWidth: '100%', maxHeight: 420, objectFit: 'contain' }} />
          : <Link href={candidate.artifactUrl} target="_blank" rel="noopener noreferrer">Open the artifact</Link>)}
        <Typography variant="subtitle2">Reviewer feedback</Typography>
        {(candidate.feedback ?? []).map((f, i) => (
          <Typography key={i} variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
            <strong>{f.slackUserDisplayName || 'Reviewer'}:</strong> {f.text}
          </Typography>
        ))}
      </Stack>
    );
  }

  if (!account) return <Alert severity="warning">Account not found.</Alert>;
  return (
    <Stack spacing={1}>
      <Table size="small">
        <TableBody>
          {ACCOUNT_FIELDS.map(([field, label]) => (
            <TableRow key={field}>
              <TableCell>{label}</TableCell>
              <TableCell>{account[field] == null || account[field] === '' ? '—' : String(account[field])}</TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell>Meta ad account on record</TableCell>
            <TableCell>{account.adAccount ? 'Yes' : 'No'}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <Link href={`/profile/${encodeURIComponent(goldenCase.sourceRef.id)}`} underline="hover">
        Open the account profile
      </Link>
    </Stack>
  );
}

function LabelForm({ goldenCase, token, onSaved }: { goldenCase: GoldenCaseView; token: string | null; onSaved: (saved: GoldenCaseView) => void }) {
  const [labels, setLabels] = useState<Partial<Record<string, LabelValue>>>(goldenCase.labels);
  const [notes, setNotes] = useState(goldenCase.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await axios.put<{ case: GoldenCaseView }>(
        buildApiUrl(`/api/admin/eval/golden-cases/${encodeURIComponent(goldenCase.caseId)}/labels`),
        { labels, notes, expectedVersion: goldenCase.version },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      onSaved(res.data.case);
      setSaved(true);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setError('Someone saved this case after you opened it. Reload the list and label it again.');
      } else {
        setError(apiMessage(err, 'Failed to save labels.'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      {goldenCase.criteria.map((criterion) => (
        <Box key={criterion}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Box>
              <Typography variant="body2" fontWeight={600}>{criterion.replace(/_/g, ' ')}</Typography>
              <Typography variant="caption" color="text.secondary">{CRITERION_HELP[criterion] ?? ''}</Typography>
            </Box>
            <ToggleButtonGroup
              size="small"
              exclusive
              value={labels[criterion] ?? null}
              onChange={(_e, value: LabelValue | null) => {
                setLabels((prev) => {
                  const next = { ...prev };
                  if (value) next[criterion] = value;
                  else delete next[criterion];
                  return next;
                });
              }}
              aria-label={`${criterion} label`}
            >
              {LABEL_OPTIONS.map((o) => (
                <ToggleButton key={o.value} value={o.value} aria-label={`${criterion} ${o.value}`}>{o.label}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Stack>
        </Box>
      ))}
      <TextField label="Note" multiline minRows={2} value={notes} onChange={(e) => setNotes(e.target.value)} inputProps={{ maxLength: 2000 }} />
      {error && <Alert severity="error">{error}</Alert>}
      {saved && <Alert severity="success">Labels saved.</Alert>}
      <Box>
        <Button variant="contained" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save labels'}
        </Button>
      </Box>
      {goldenCase.labeller && (
        <Typography variant="caption" color="text.secondary">
          Last labelled by {goldenCase.labeller}{goldenCase.labelledAt ? ` at ${new Date(goldenCase.labelledAt).toLocaleString()}` : ''} (version {goldenCase.version})
        </Typography>
      )}
    </Stack>
  );
}

export default function EvalLabelling() {
  const { token, user } = useAuth();
  const [provisioned, setProvisioned] = useState<boolean | null>(null);
  const [surface, setSurface] = useState<Surface>('agent');
  const [cases, setCases] = useState<GoldenCaseView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each load gets a sequence number; a load that is no longer the latest (the admin switched
  // surface meanwhile) must not overwrite the current surface's cases.
  const loadSeq = useRef(0);

  const fetchCases = useCallback(async (which: Surface) => {
    const seq = ++loadSeq.current;
    const isCurrent = () => seq === loadSeq.current;
    setLoading(true);
    setError(null);
    setCases([]);
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const status = await axios.get<{ provisioned: boolean }>(buildApiUrl('/api/admin/eval/golden-cases/status'), { headers });
      if (!isCurrent()) return;
      setProvisioned(status.data.provisioned);
      if (!status.data.provisioned) return;
      const res = await axios.get<{ cases: GoldenCaseView[] }>(buildApiUrl(`/api/admin/eval/golden-cases?surface=${which}`), { headers });
      if (!isCurrent()) return;
      const next = [...res.data.cases].sort((a, b) => labelledCount(a) - labelledCount(b) || a.caseId.localeCompare(b.caseId));
      setCases(next);
      setSelectedId((current) => (current && next.some((c) => c.caseId === current) ? current : next[0]?.caseId ?? null));
    } catch (err) {
      if (!isCurrent()) return;
      if (isNotProvisioned(err)) setProvisioned(false);
      else setError(apiMessage(err, 'Failed to load golden cases.'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    if (user?.isAdmin) void fetchCases(surface);
  }, [user?.isAdmin, surface, fetchCases]);

  if (!user?.isAdmin) {
    return (
      <Box sx={{ textAlign: 'center', py: 10 }}>
        <FactCheckIcon sx={{ fontSize: 56, color: 'text.disabled' }} />
        <Typography variant="h6" sx={{ mt: 2 }}>Admin access required</Typography>
      </Box>
    );
  }

  const selected = cases.find((c) => c.caseId === selectedId) ?? null;
  const fullyLabelled = cases.filter((c) => labelledCount(c) === c.criteria.length).length;

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <FactCheckIcon />
        <Typography variant="h5">Eval labelling</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Binary human labels for the golden sets that validate AgentWeb&apos;s graders. Case content is loaded from its source when opened and is never copied into the golden set.
      </Typography>

      {provisioned === false && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The golden-set store is not provisioned yet (OPS-2, ENG-2147). Cases and labels will appear here once it is.
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Tabs value={surface} onChange={(_e, value: Surface) => setSurface(value)} sx={{ mb: 2 }}>
        {SURFACES.map((s) => <Tab key={s.value} value={s.value} label={s.label} />)}
      </Tabs>
      {loading && <LinearProgress sx={{ mb: 2 }} />}

      {provisioned && (
        <Grid container spacing={2}>
          <Grid item xs={12} md={4}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle2" sx={{ mb: 1 }}>
                  {cases.length} cases · {fullyLabelled} fully labelled
                </Typography>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Source</TableCell>
                      <TableCell>Split</TableCell>
                      <TableCell align="right">Labelled</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {cases.map((c) => (
                      <TableRow
                        key={c.caseId}
                        hover
                        selected={c.caseId === selectedId}
                        aria-selected={c.caseId === selectedId}
                        tabIndex={0}
                        onClick={() => setSelectedId(c.caseId)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setSelectedId(c.caseId);
                          }
                        }}
                        sx={{ cursor: 'pointer' }}
                      >
                        <TableCell>
                          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{c.sourceRef.id.slice(0, 12)}</Typography>
                          <Typography variant="caption" color="text.secondary">{c.taskType}</Typography>
                        </TableCell>
                        <TableCell>{c.split}</TableCell>
                        <TableCell align="right">{labelledCount(c)}/{c.criteria.length}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </Grid>
          <Grid item xs={12} md={8}>
            {selected ? (
              <Stack spacing={2}>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Labels</Typography>
                    {/* Keyed by case so the form starts fresh per case but keeps its "saved" state across its own save. */}
                    <LabelForm
                      key={selected.caseId}
                      goldenCase={selected}
                      token={token}
                      onSaved={(saved) => setCases((prev) => prev.map((c) => (c.caseId === saved.caseId ? saved : c)))}
                    />
                  </CardContent>
                </Card>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Source</Typography>
                    <SourceContext goldenCase={selected} token={token} />
                  </CardContent>
                </Card>
              </Stack>
            ) : (
              !loading && <Typography color="text.secondary">No cases for this surface yet.</Typography>
            )}
          </Grid>
        </Grid>
      )}
    </Box>
  );
}
