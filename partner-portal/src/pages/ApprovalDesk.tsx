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
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  IconButton,
  LinearProgress,
  Link,
  Stack,
  useMediaQuery,
  useTheme,
  TextField,
  Typography,
} from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import { buildApiUrl } from '../config';
import { useAuth } from '../contexts/AuthContext';

const VIDEO_EXTENSIONS = /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i;
// chatUrl/links are agent-authored strings (the plan_choice producer takes them straight from a
// model tool call); only ever render a clickable link for a plain http(s) URL so a `javascript:`
// value can't run in an admin's session when clicked.
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isVideoUrl(src: string): boolean {
  return VIDEO_EXTENSIONS.test(src);
}

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
  // Optional: an older backend does not send these.
  pendingCount?: number;
  readyToDispatchCount?: number;
  itemPreviews: string[];
  earliestExpiresAt: string;
  // null for a manifest with no meta_write items (e.g. a pure plan_choice
  // packet) — there's no account to group it under.
  accountId: string | null;
  // Optional: an older backend does not send it. More than one = a packet that spans ad accounts.
  accountIds?: string[];
  accountLabel: string | null;
}

function apiMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { message?: string; error?: string } | undefined;
    return data?.message || data?.error || fallback;
  }
  return fallback;
}

const RESOLVED_STATUSES = new Set(['approved', 'rejected', 'edited', 'dispatching', 'executed', 'execution_failed']);

function statusColor(decision: ApprovalDecisionView, answered: boolean): 'error' | 'success' | 'default' {
  return decision.status === 'execution_failed' ? 'error' : answered ? 'success' : 'default';
}

// One manifest/packet row — same content whether it's nested inside an
// account accordion or (for accountless plan_choice packets) shown flat.
// Inside an account accordion the account name is already the heading, so the
// row leads with what's IN the packet; a flat accountless row has no such
// heading, so it keeps its own subject label as the title.
function ManifestRow({ m, showSubject }: { m: ManifestSummary; showSubject: boolean }) {
  const more = m.itemCount - (m.itemPreviews?.length ?? 0);
  // Every card answered but Approve All not pressed yet — nothing has been dispatched.
  const readyToDispatch = (m.pendingCount ?? 1) === 0 && (m.readyToDispatchCount ?? 0) > 0;
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={1}>
          <Box sx={{ minWidth: 0 }}>
            {(m.accountIds?.length ?? 0) > 1 && (
              <Chip size="small" color="error" label={`Spans ${m.accountIds!.length} ad accounts: ${m.accountIds!.join(', ')}`} sx={{ mb: 0.5, mr: 0.5 }} />
            )}
            {readyToDispatch && <Chip size="small" color="warning" label="Ready to dispatch — not sent yet" sx={{ mb: 0.5 }} />}
            {showSubject && <Typography variant="subtitle1">{m.subjectLabel || m.manifestId}</Typography>}
            {m.itemPreviews?.map((line, i) => (
              <Typography
                key={i}
                variant={showSubject ? 'body2' : 'subtitle2'}
                sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
              >
                {line}
              </Typography>
            ))}
            {more > 0 && <Typography variant="body2" color="text.secondary">+{more} more</Typography>}
            <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
              {m.itemCount} item{m.itemCount === 1 ? '' : 's'} · earliest expiry {new Date(m.earliestExpiresAt).toLocaleString()}
            </Typography>
          </Box>
          <Button component={RouterLink} to={`/approval-desk/${encodeURIComponent(m.manifestId)}`} variant="contained">
            {readyToDispatch ? 'Review & dispatch' : 'Review'}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}

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

  // Account (Matt's own mental model — "which accounts need me") is the top
  // level; a manifest/packet is what's inside once he expands one. Only
  // accounts with something pending appear at all — this list IS the
  // caller's pending queue, there's no separate "done" state to filter.
  // A manifest with no account (a pure plan_choice packet, no Meta write in
  // it) has nothing to group under, so those stay in their own flat
  // "Other decisions" section instead of being forced into a fake account.
  const byAccount = new Map<string, { label: string; manifests: ManifestSummary[] }>();
  const accountless: ManifestSummary[] = [];
  for (const m of manifests) {
    if (!m.accountId) {
      accountless.push(m);
      continue;
    }
    const entry = byAccount.get(m.accountId) || { label: m.accountLabel || m.accountId, manifests: [] };
    entry.manifests.push(m);
    byAccount.set(m.accountId, entry);
  }
  const accountGroups = [...byAccount.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));

  return (
    <Box sx={{ p: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <FactCheckIcon />
        <Typography variant="h5">Approval Desk</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Your pending decisions, grouped by account — expand an account to see what's waiting on you there.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {!loading && manifests.length === 0 && !error && (
        <Typography color="text.secondary">Nothing waiting on you right now.</Typography>
      )}

      <Stack spacing={1.5}>
        {accountGroups.map(([accountId, { label, manifests: accountManifests }]) => {
          const totalItems = accountManifests.reduce((sum, m) => sum + m.itemCount, 0);
          return (
            <Accordion key={accountId} variant="outlined" disableGutters>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={1} sx={{ width: '100%', pr: 1 }}>
                  <Typography variant="subtitle1">{label}</Typography>
                  <Chip
                    size="small"
                    label={`${totalItems} item${totalItems === 1 ? '' : 's'} · ${accountManifests.length} packet${accountManifests.length === 1 ? '' : 's'}`}
                  />
                </Stack>
              </AccordionSummary>
              <AccordionDetails>
                <Stack spacing={1.5}>
                  {accountManifests.map((m) => <ManifestRow key={m.manifestId} m={m} showSubject={false} />)}
                </Stack>
              </AccordionDetails>
            </Accordion>
          );
        })}

        {accountless.length > 0 && (
          <Box sx={{ mt: accountGroups.length > 0 ? 2 : 0 }}>
            {accountGroups.length > 0 && (
              <Typography variant="overline" color="text.secondary">Not tied to an ad account</Typography>
            )}
            <Stack spacing={1.5} sx={{ mt: 1 }}>
              {accountless.map((m) => <ManifestRow key={m.manifestId} m={m} showSubject />)}
            </Stack>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

// A single creative preview cell — image or video, sized large enough to
// actually judge a crop/legibility problem (not a thumbnail), with a
// hover affordance and click-to-zoom into a full-size dialog. Review fix
// (found live by Manan on the deployed page): the original 160×180
// thumbnail grid was too small to see anything and had no zoom at all.
function CreativeThumb({ src, alt, onZoom }: { src: string; alt: string; onZoom: (src: string) => void }) {
  const video = isVideoUrl(src);
  return (
    <Box
      onClick={() => onZoom(src)}
      role="button"
      tabIndex={0}
      aria-label={`Zoom in on ${alt}`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onZoom(src);
        }
      }}
      sx={{
        position: 'relative',
        width: '100%',
        height: 260,
        bgcolor: 'action.hover',
        borderRadius: 1,
        overflow: 'hidden',
        cursor: 'zoom-in',
        '&:hover .zoom-affordance': { opacity: 1 },
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
      }}
    >
      {video ? (
        <Box component="video" src={src} muted preload="metadata" sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      ) : (
        <Box component="img" src={src} alt={alt} sx={{ width: '100%', height: '100%', objectFit: 'contain' }} />
      )}
      <Box
        className="zoom-affordance"
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'rgba(0,0,0,0.35)',
          opacity: 0,
          transition: 'opacity 0.15s',
          pointerEvents: 'none',
        }}
      >
        <ZoomInIcon sx={{ color: 'common.white', fontSize: 36 }} />
      </Box>
    </Box>
  );
}

// One call, one card: evidence AND the controls to decide it live in the
// same place. Review fix (found live by Manan): the earlier split — evidence
// cards in a center column, a separate rail of matching controls on the
// right — made matching card N's evidence to its own controls a manual
// counting exercise once a packet had more than a handful of items. A
// single column removes the second list entirely; there's nothing to match.
// Still no pagination/modal per item (the prototype's own density finding)
// — just one list, not two.
function DecisionCard({
  index,
  decision,
  disabled,
  fullScreenZoom,
  onAnswer,
}: {
  index: number;
  decision: ApprovalDecisionView;
  disabled: boolean;
  fullScreenZoom: boolean;
  onAnswer: (verdict: Verdict, freeText?: string) => Promise<void>;
}) {
  const answered = RESOLVED_STATUSES.has(decision.status);
  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  const [freeText, setFreeText] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [acting, setActing] = useState<Verdict | null>(null);

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
    <Card variant="outlined" id={`call-${decision.decisionId}`}>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
            <Typography variant="subtitle1">{index}. {decision.subjectLabel}</Typography>
            <Chip size="small" label={decision.status.replace(/_/g, ' ')} color={statusColor(decision, answered)} />
          </Stack>
          <Typography variant="body2">{decision.businessImpact}</Typography>
          {isHttpUrl(decision.evidencePacket?.chatUrl) && (
            // Real producers (e.g. ask_user_question) populate this — the
            // exact conversation that led to this decision — but it was
            // never rendered anywhere (found live: a plan_choice decision
            // with no account and a one-line question gave a reviewer zero
            // way to see the context behind it). This is that context.
            <Link href={decision.evidencePacket.chatUrl} target="_blank" rel="noopener noreferrer" variant="body2">
              View the full conversation this came from →
            </Link>
          )}
          {decision.evidencePacket?.researchSummary && (
            <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
              {decision.evidencePacket.researchSummary}
            </Typography>
          )}
          {decision.evidencePacket?.screenshots && decision.evidencePacket.screenshots.length > 0 && (
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 1.5 }}>
              {decision.evidencePacket.screenshots.filter(isHttpUrl).map((src) => (
                <CreativeThumb key={src} src={src} alt={`${decision.subjectLabel} — creative preview`} onZoom={setZoomedSrc} />
              ))}
            </Box>
          )}
          {decision.evidencePacket?.links?.filter(isHttpUrl).map((l) => (
            <Link key={l} href={l} target="_blank" rel="noopener noreferrer">{l}</Link>
          ))}
          {decision.options && decision.options.length > 0 && (
            <Stack spacing={1}>
              {decision.options.map((o) => (
                <Box key={o.id}>
                  <Typography variant="body2">
                    <strong>{o.label}</strong>{o.recommended ? ' (recommended)' : ''} — {o.consequence}
                  </Typography>
                  {/* why is a REQUIRED field on the recommended option (see
                      emma/tools.ts's own tool schema) — the actual reasoning
                      behind the recommendation, previously collected and
                      silently dropped. */}
                  {o.why && (
                    <Typography variant="body2" color="text.secondary" sx={{ pl: 2 }}>
                      Why: {o.why}
                    </Typography>
                  )}
                </Box>
              ))}
            </Stack>
          )}

          {answered ? (
            <Alert severity={decision.status === 'execution_failed' ? 'error' : 'success'} sx={{ mt: 1 }}>
              {decision.verdict ? `You chose: ${decision.verdict}.` : ''}
              {decision.executionResult?.message ? ` ${decision.executionResult.message}` : ''}
            </Alert>
          ) : (
            <Stack spacing={1} sx={{ mt: 1, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
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
                {!showNote && (
                  <Button disabled={disabled || acting !== null} onClick={() => setShowNote(true)}>
                    + note
                  </Button>
                )}
              </Stack>
              {showNote && (
                <Stack spacing={0.75} sx={{ mt: 0.5, pt: 1, borderTop: 1, borderColor: 'divider' }}>
                  {/* A note attaches to Approve/Reject above regardless of gate
                      type — claimDecision persists freeText and it's surfaced
                      back to the agent session either way (ENG-1853 review
                      fix: an earlier version of this hid the note entirely for
                      meta_write, silently dropping a reviewer's "wrong
                      account, use $50 not $100" context on a real ad-spend
                      reject). Only the dedicated edit-verdict submit below
                      stays non-meta_write — meta_write has no 'edited' state. */}
                  <TextField
                    label={decision.gateType === 'meta_write' ? 'Note (optional)' : 'What exactly should change?'}
                    size="small"
                    multiline
                    minRows={2}
                    fullWidth
                    value={freeText}
                    disabled={disabled || acting !== null}
                    onChange={(e) => setFreeText(e.target.value)}
                    inputProps={{ maxLength: 2000 }}
                    helperText={decision.gateType === 'meta_write' ? 'Attaches to Approve/Reject above.' : undefined}
                    autoFocus
                  />
                  {decision.gateType !== 'meta_write' && (
                    <Button
                      variant="outlined"
                      disabled={disabled || acting !== null || !freeText}
                      onClick={() => void act('edit')}
                      sx={{ alignSelf: 'flex-start' }}
                    >
                      {acting === 'edit' ? 'Saving…' : 'Send back with this correction'}
                    </Button>
                  )}
                </Stack>
              )}
            </Stack>
          )}
        </Stack>
      </CardContent>

      <Dialog open={zoomedSrc !== null} onClose={() => setZoomedSrc(null)} maxWidth="lg" fullWidth fullScreen={fullScreenZoom}>
        <Box sx={{ position: 'relative', bgcolor: 'common.black', height: fullScreenZoom ? '100%' : 'auto', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <IconButton
            onClick={() => setZoomedSrc(null)}
            sx={{ position: 'absolute', top: 8, right: 8, color: 'common.white', bgcolor: 'rgba(0,0,0,0.4)', '&:hover': { bgcolor: 'rgba(0,0,0,0.6)' }, zIndex: 1 }}
          >
            <CloseIcon />
          </IconButton>
          {zoomedSrc && (isVideoUrl(zoomedSrc) ? (
            <Box component="video" src={zoomedSrc} controls sx={{ width: '100%', maxHeight: '85vh', display: 'block' }} />
          ) : (
            <Box component="img" src={zoomedSrc} alt="Creative, full size" sx={{ width: '100%', maxHeight: '85vh', objectFit: 'contain', display: 'block' }} />
          ))}
        </Box>
      </Dialog>
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
  const theme = useTheme();
  // Review fix: compute once per packet, not once per decision — an
  // EvidenceCard per decision each running its own useMediaQuery would
  // register N redundant matchMedia listeners for the same breakpoint.
  const fullScreenZoom = useMediaQuery(theme.breakpoints.down('sm'));

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

  const answeredCount = decisions.filter((d) => RESOLVED_STATUSES.has(d.status)).length;
  const allAnswered = decisions.length > 0 && answeredCount === decisions.length;
  const hasMetaWrite = decisions.some((d) => d.gateType === 'meta_write');
  // Dispatched = at least one item ran and every other item is only rejected (the server 409s a repeat anyway).
  const alreadyDispatched =
    decisions.some((d) => d.status === 'executed' || d.status === 'execution_failed') &&
    decisions.every((d) => d.status === 'executed' || d.status === 'execution_failed' || d.status === 'rejected');

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
    <Box sx={{ p: 3, pb: hasMetaWrite ? 12 : 3 }}>
      {/* Review fix (found live: the header row spanned the full page width
          while the cards below were capped narrower, so the answered-count
          floated disconnected from its own content, with a large dead zone
          on the right). Everything — header, back link, counter, cards,
          sticky bar — now shares ONE centered column instead of each piece
          picking its own width. */}
      <Box sx={{ maxWidth: 760, mx: 'auto' }}>
        <Stack direction="row" alignItems="flex-start" spacing={1} sx={{ mb: 1 }}>
          <FactCheckIcon sx={{ mt: 0.5, flexShrink: 0 }} />
          <Typography variant="h5">{decisions[0]?.subjectLabel || 'Approval packet'}</Typography>
        </Stack>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Link component={RouterLink} to="/approval-desk" sx={{ display: 'inline-block' }}>← Back to queue</Link>
          {decisions.length > 0 && (
            <Typography variant="body2" color="text.secondary">{answeredCount}/{decisions.length} answered</Typography>
          )}
        </Stack>

        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {loading && <LinearProgress sx={{ mb: 2 }} />}

        {/* One column: every card carries its own evidence AND its own
            controls — no separate rail to match against (review fix, found
            live by Manan: matching card N on the left to control N on the
            right became a manual counting exercise past a handful of items).
            Every item still renders at once, no pagination/modal, per the
            prototype's own density finding — just one list instead of two. */}
        <Stack spacing={2}>
          {decisions.map((d, i) => (
            <DecisionCard
              key={d.decisionId}
              index={i + 1}
              decision={d}
              disabled={approvingAll}
              fullScreenZoom={fullScreenZoom}
              onAnswer={(v, ft) => answer(d.decisionId, v, ft)}
            />
          ))}
        </Stack>

        {hasMetaWrite && (
          <Box
            sx={{
              position: 'sticky',
              bottom: 0,
              mt: 3,
              py: 2,
              bgcolor: 'background.paper',
              borderTop: 1,
              borderColor: 'divider',
            }}
          >
            {approveAllError && <Alert severity="error" sx={{ mb: 1 }}>{approveAllError}</Alert>}
            {approveAllResult && <Alert severity="success" sx={{ mb: 1 }}>{approveAllResult}</Alert>}
            <Button
              variant="contained"
              size="large"
              disabled={!allAnswered || approvingAll || alreadyDispatched}
              onClick={() => void approveAll()}
            >
              {approvingAll ? 'Executing…' : alreadyDispatched ? 'Already dispatched' : allAnswered ? `Approve All — dispatch and read back (${decisions.length}/${decisions.length})` : `Answer every item to enable Approve All (${answeredCount}/${decisions.length})`}
            </Button>
          </Box>
        )}
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
