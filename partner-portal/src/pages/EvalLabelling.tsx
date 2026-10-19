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
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  FormControl,
  Grid,
  InputLabel,
  LinearProgress,
  Link,
  MenuItem,
  Select,
  type SelectChangeEvent,
  Skeleton,
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
import { blindForHuman, withoutDraft } from '../utils/blindLabelling';

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
  /** Pairwise calibration cases only (ENG-2142); labelled on the calibration page, not here. */
  pair?: {
    candidateIdB: string;
    batch: string;
    position: number;
    batchSize: number;
    category: string;
    placement: string;
    signal: string;
  };
  /** AI-drafted suggestions (ENG-2200), advisory only. Never the ground truth; see `labels`. */
  draft?: {
    labels: Partial<Record<string, { label: LabelValue; rationale: string }>>;
    model: string;
    generatedAt: string;
  };
}

const SURFACES: ReadonlyArray<{ value: Surface; label: string }> = [
  { value: 'agent', label: 'Agent sessions' },
  { value: 'creative', label: 'Creatives' },
  { value: 'account_health', label: 'Account health' },
];

const CRITERION_HELP: Record<string, string> = {
  task_success: 'Pass = the final state is what the user asked for. Fail = not done, partly done, or claimed done when it was not (a withheld action the user told it to take is not done). N/A only if there was no task at all (a greeting, an empty message).',
  tool_correctness: 'Pass = tools were called with sensible arguments and their results were checked and used (a failure that was noticed and recovered from is still a pass). Fail = wrong tool or arguments, the same avoidable error 3+ times, results ignored or misread, or a failure the reply never mentions. N/A only if no tool was called.',
  groundedness: 'Pass = every factual claim in the replies is supported by a tool result, the user\'s words, or the prompt shown in the transcript. Fail = any claim that is invented or that nothing in the transcript supports, even if it might come from hidden memory. N/A only if there are no factual claims.',
  instruction_compliance: 'N/A = no explicit instruction at all (greeting, bare question, empty message). Pass = every explicit instruction (an action, a constraint such as \"don\'t ask first\" or \"keep it short\", a format) was followed the first time. Fail = any was missed, only partly met, or needed repeating. Retry nudges restate the original instruction.',
  argued_with_instruction: 'Pass = the agent refused, pushed back on, or asked approval for an explicit, safe instruction instead of doing it. Fail = it did not (it did it, declined something unsafe, impossible or out of scope, or only asked a needed clarifying question). N/A = there was no explicit instruction to do something.',
  escalated_when_not_required: 'Pass = the agent handed work or a decision back to the human when it could have finished it itself with the tools and information it had. Fail = it did not, including when the hand-off was needed because of a real blocker or missing information.',
  failed_to_escalate: 'Pass = the agent hit a blocker it could not fix and neither reported it nor told the user (dropped it, papered over it, or pretended success). Fail = otherwise: there was no blocker, or the blocker was reported.',
  hook: 'Stops the scroll in the first second',
  offer: 'A clear, specific offer',
  proof_integrity: 'Proof points are real, not invented. N/A only if the creative makes no proof claim; any number, testimonial, superlative or guarantee counts as a claim.',
  brand_fidelity: 'Matches the brand colours, logo and tone',
  format_readiness: 'Right size and layout for the placement',
  policy_risk: 'Pass = no ad-policy risk',
  buyer_usefulness: 'Useful to the target buyer',
  activation_incomplete: 'Pass = the account never finished setup (never connected an ad platform). Judge the state today; exactly one of the three states is Pass. N/A for a deleted or synthetic account.',
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

/** Least-labelled first, so the next case to label is at the top. */
function byLeastLabelled(a: GoldenCaseView, b: GoldenCaseView): number {
  return labelledCount(a) - labelledCount(b) || a.caseId.localeCompare(b.caseId);
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

  const draft = goldenCase.draft;

  const applySuggestion = (criterion: string, value: LabelValue) => {
    setSaved(false);
    setLabels((prev) => ({ ...prev, [criterion]: value }));
  };

  const applyAllSuggestions = () => {
    if (!draft) return;
    setSaved(false);
    setLabels((prev) => {
      const next = { ...prev };
      for (const criterion of goldenCase.criteria) {
        const suggestion = draft.labels[criterion];
        if (suggestion && next[criterion] === undefined) next[criterion] = suggestion.label;
      }
      return next;
    });
  };

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
      onSaved(withoutDraft(res.data.case));
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
      {draft && (
        <Alert
          severity="info"
          action={<Button color="inherit" size="small" onClick={applyAllSuggestions}>Apply all suggestions</Button>}
        >
          AI-drafted suggestions available (model: {draft.model}, generated {new Date(draft.generatedAt).toLocaleString()}) — review each one; nothing is applied until you save.
        </Alert>
      )}
      {goldenCase.criteria.map((criterion) => {
        const suggestion = draft?.labels[criterion];
        const suggestionOption = suggestion ? LABEL_OPTIONS.find((o) => o.value === suggestion.label) : undefined;
        return (
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
                disabled={saving}
                onChange={(_e, value: LabelValue | null) => {
                  // Any edit makes the last "saved" confirmation stale.
                  setSaved(false);
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
            {suggestion && suggestionOption && (
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mt: 0.5 }}>
                <Chip size="small" variant="outlined" label={`AI suggests: ${suggestionOption.label}`} />
                <Button size="small" variant="text" disabled={saving} onClick={() => applySuggestion(criterion, suggestion.label)}>
                  Use suggestion
                </Button>
              </Stack>
            )}
            {suggestion && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {suggestion.rationale}
              </Typography>
            )}
          </Box>
        );
      })}
      <TextField
        label="Note"
        multiline
        minRows={2}
        value={notes}
        disabled={saving}
        onChange={(e) => {
          setSaved(false);
          setNotes(e.target.value);
        }}
        inputProps={{ maxLength: 2000 }}
      />
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
  // Filters the case list only — the open case in the detail pane stays open even if a filter
  // change hides it from the list, so switching filters mid-edit never loses unsaved work.
  const [splitFilter, setSplitFilter] = useState<'all' | 'dev' | 'test'>('all');
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
      // Pairwise calibration cases take an A/B/tie choice on their own page, not binary criteria.
      const next = res.data.cases.filter((c) => c.pair === undefined).map(blindForHuman).sort(byLeastLabelled);
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
  const filteredCases = splitFilter === 'all' ? cases : cases.filter((c) => c.split === splitFilter);
  const filteredFullyLabelled = filteredCases.filter((c) => labelledCount(c) === c.criteria.length).length;

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <FactCheckIcon />
        <Typography variant="h5">Eval labelling</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Binary human labels for the golden sets that validate AgentWeb&apos;s graders. Case content is loaded from its source when opened and is never copied into the golden set.
        {' '}Pairwise creative comparisons are on the <Link component={RouterLink} to="/eval-labelling/calibration">weekly creative calibration</Link> page.
        {' '}Some cases may show AI-drafted label suggestions for you to review and explicitly accept or reject — they are never saved on their own.
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
                <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} sx={{ mb: 1 }}>
                  <Typography variant="subtitle2">
                    {loading
                      ? 'Loading cases…'
                      : splitFilter === 'all'
                        ? `${cases.length} cases · ${fullyLabelled} fully labelled`
                        : `${filteredCases.length} of ${cases.length} cases · ${filteredFullyLabelled} fully labelled`}
                  </Typography>
                  <FormControl size="small" sx={{ minWidth: 110 }} disabled={loading}>
                    <InputLabel id="eval-labelling-split-filter-label">Split</InputLabel>
                    <Select
                      labelId="eval-labelling-split-filter-label"
                      label="Split"
                      value={splitFilter}
                      onChange={(e: SelectChangeEvent) => setSplitFilter(e.target.value as 'all' | 'dev' | 'test')}
                      data-testid="eval-labelling-split-filter"
                    >
                      <MenuItem value="all">All</MenuItem>
                      <MenuItem value="test">test</MenuItem>
                      <MenuItem value="dev">dev</MenuItem>
                    </Select>
                  </FormControl>
                </Stack>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Source</TableCell>
                      <TableCell>Split</TableCell>
                      <TableCell align="right">Labelled</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {loading
                      ? Array.from({ length: 6 }).map((_, i) => (
                          <TableRow key={`skeleton-${i}`}>
                            <TableCell>
                              <Skeleton variant="text" width="70%" />
                              <Skeleton variant="text" width="40%" />
                            </TableCell>
                            <TableCell><Skeleton variant="text" width={40} /></TableCell>
                            <TableCell align="right"><Skeleton variant="text" width={30} sx={{ ml: 'auto' }} /></TableCell>
                          </TableRow>
                        ))
                      : filteredCases.length === 0
                        ? (
                          <TableRow>
                            <TableCell colSpan={3}>
                              <Typography variant="body2" color="text.secondary">No {splitFilter} cases.</Typography>
                            </TableCell>
                          </TableRow>
                        )
                        : filteredCases.map((c) => (
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
                {/* Source renders first: a reviewer must read it before judging the criteria below. */}
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Source</Typography>
                    <SourceContext goldenCase={selected} token={token} />
                  </CardContent>
                </Card>
                <Card variant="outlined">
                  <CardContent>
                    <Typography variant="subtitle2" sx={{ mb: 1 }}>Labels</Typography>
                    {/* Keyed by case so the form starts fresh per case but keeps its "saved" state across its own save. */}
                    <LabelForm
                      key={selected.caseId}
                      goldenCase={selected}
                      token={token}
                      onSaved={(saved) => setCases((prev) => prev.map((c) => (c.caseId === saved.caseId ? saved : c)).sort(byLeastLabelled))}
                    />
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
