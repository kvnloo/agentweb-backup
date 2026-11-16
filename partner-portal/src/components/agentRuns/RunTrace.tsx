import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  IconButton,
  Link,
  List,
  ListItemButton,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ReplayIcon from '@mui/icons-material/Replay';
import TuneIcon from '@mui/icons-material/Tune';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { formatChars, formatDuration, formatOffset, formatTime } from './agentRunFormat';
import type { AgentRunTrace, TraceCall, TraceStep } from './types';

const MONO = '"JetBrains Mono", "SFMono-Regular", Menlo, Consolas, monospace';
const URL_PATTERN = /(https?:\/\/[^\s"'<>]+[^\s"'<>.,;:!?)\]])/g;

/** Plain text with its http(s) URLs as links that open in a new tab. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_PATTERN);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <Link key={i} href={part} target="_blank" rel="noopener noreferrer" color="secondary.dark" sx={{ wordBreak: 'break-all' }}>
            {part}
          </Link>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </>
  );
}

export function CopyButton({ value, label, onCopied }: { value: string; label: string; onCopied?: (label: string) => void }) {
  return (
    <Tooltip title={label}>
      <IconButton
        size="small"
        aria-label={label}
        onClick={(event) => {
          event.stopPropagation();
          void navigator.clipboard?.writeText(value).then(() => onCopied?.(label));
        }}
      >
        <ContentCopyIcon sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, minHeight: 32, flexWrap: 'wrap', rowGap: 1 }}>
      <Typography variant="subtitle2" component="h2" color="text.secondary" sx={{ flex: '1 1 200px', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {children}
      </Typography>
      {action}
    </Box>
  );
}

/** The user's ask, once; follow-ups only when they differ. */
export function AskCard({ trace, fallback }: { trace?: AgentRunTrace | null; fallback?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);
  const text = trace?.ask?.text ?? fallback;
  useLayoutEffect(() => {
    const el = textRef.current;
    if (el && !expanded) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);
  if (!text) return null;
  return (
    <Card variant="outlined">
      <CardContent>
        <SectionTitle>What the user asked</SectionTitle>
        <Typography
          ref={textRef}
          variant="body2"
          sx={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            ...(!expanded ? { display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' } : {}),
          }}
        >
          <Linkified text={text} />
        </Typography>
        {(clamped || expanded) && (
          <Button size="small" color="secondary" onClick={() => setExpanded((v) => !v)} sx={{ mt: 0.5, px: 0 }}>
            {expanded ? 'Show less' : 'Show full ask'}
          </Button>
        )}
        {trace?.followUpAsks.map((ask, i) => (
          <Box key={i} sx={{ mt: 1.5, pl: 1.5, borderLeft: 2, borderColor: 'divider' }}>
            <Typography variant="caption" color="text.secondary">Follow-up</Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              <Linkified text={ask} />
            </Typography>
          </Box>
        ))}
      </CardContent>
    </Card>
  );
}

function StepStatusIcon({ status }: { status: string }) {
  const title = `Step ${status}`;
  if (status === 'completed') return <CheckCircleIcon titleAccess={title} sx={{ color: 'success.main', fontSize: 20 }} />;
  if (status === 'failed') return <CancelIcon titleAccess={title} sx={{ color: 'error.dark', fontSize: 20 }} />;
  if (status === 'skipped') return <RemoveCircleOutlineIcon titleAccess={title} sx={{ color: 'text.disabled', fontSize: 20 }} />;
  return <RadioButtonUncheckedIcon titleAccess={title} sx={{ color: 'text.disabled', fontSize: 20 }} />;
}

function CallStatusIcon({ call }: { call: TraceCall }) {
  if (call.status === 'failed') {
    return <CancelIcon titleAccess={call.recoveredByCallId ? 'Failed, recovered later' : 'Failed'} sx={{ color: 'error.dark', fontSize: 18 }} />;
  }
  if (call.status === 'no_result') return <HelpOutlineIcon titleAccess="No result recorded" sx={{ color: 'text.disabled', fontSize: 18 }} />;
  return <CheckCircleIcon titleAccess="Succeeded" sx={{ color: 'success.main', fontSize: 18 }} />;
}

function CodeBlock({ label, value, note, onCopied }: { label: string; value: string; note?: string; onCopied?: (label: string) => void }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
          {label}
          {note ? ` · ${note}` : ''}
        </Typography>
        <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} onCopied={onCopied} />
      </Box>
      <Box
        component="pre"
        sx={(theme) => ({
          m: 0,
          p: 1.25,
          maxHeight: 280,
          overflow: 'auto',
          borderRadius: 1,
          bgcolor: alpha(theme.palette.text.primary, 0.04),
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        })}
      >
        {value ? <Linkified text={value} /> : '(empty)'}
      </Box>
    </Box>
  );
}

interface CallListContext {
  byId: Map<string, TraceCall>;
  runStartedAt?: string;
  expanded: Set<string>;
  toggle: (id: string) => void;
  jumpTo: (id: string) => void;
  onCopied?: (label: string) => void;
}

function CallRow({ call, ctx }: { call: TraceCall; ctx: CallListContext }) {
  const failed = call.status === 'failed';
  const expanded = ctx.expanded.has(call.id);
  const recoveredBy = call.recoveredByCallId ? ctx.byId.get(call.recoveredByCallId) : undefined;
  const endedMs = call.endedAt ? Date.parse(call.endedAt) : undefined;
  const startedMs = endedMs != null && call.durationMs != null ? endedMs - call.durationMs : endedMs;
  const offset = formatOffset(ctx.runStartedAt, startedMs);
  const panelId = `call-panel-${call.id}`;
  return (
    <Box
      component="li"
      id={`call-${call.id}`}
      sx={(theme) => ({
        listStyle: 'none',
        minWidth: 0,
        borderLeft: 3,
        borderColor: failed ? 'error.main' : 'transparent',
        bgcolor: failed ? alpha(theme.palette.error.main, 0.08) : 'transparent',
        borderRadius: 1,
      })}
    >
      <ListItemButton
        onClick={() => ctx.toggle(call.id)}
        aria-expanded={expanded}
        aria-controls={panelId}
        sx={{ gap: 1.25, py: 0.75, px: 1, borderRadius: 1, alignItems: 'flex-start', minWidth: 0 }}
      >
        <Box sx={{ pt: '2px', display: 'flex' }}><CallStatusIcon call={call} /></Box>
        <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, minWidth: 0 }}>
            <Typography
              variant="body2"
              title={call.name}
              sx={{ fontFamily: MONO, fontWeight: 600, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: { xs: 1, sm: 0 } }}
            >
              {call.name}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: '1 1 0', display: { xs: 'none', sm: 'block' } }}
            >
              {call.argsPreview}
            </Typography>
          </Box>
          {failed && call.error && !expanded && (
            <Typography
              variant="body2"
              sx={{ mt: 0.25, color: 'text.primary', wordBreak: 'break-word', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {call.error}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexShrink: 0 }}>
          {failed && recoveredBy && (
            <>
              <Chip
                size="small"
                variant="outlined"
                icon={<ReplayIcon />}
                label="Recovered"
                sx={{ borderColor: 'success.main', '& .MuiChip-icon': { color: 'success.main' }, display: { xs: 'none', sm: 'inline-flex' } }}
              />
              <ReplayIcon titleAccess="Recovered" sx={{ fontSize: 18, color: 'success.main', display: { xs: 'block', sm: 'none' } }} />
            </>
          )}
          {offset && (
            <Tooltip title={startedMs != null ? `Started ${formatTime(new Date(startedMs).toISOString())}` : ''}>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO, whiteSpace: 'nowrap', display: { xs: 'none', sm: 'block' } }}>
                {offset}
              </Typography>
            </Tooltip>
          )}
          <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', minWidth: 52, textAlign: 'right' }}>
            {formatDuration(call.durationMs)}
          </Typography>
          <ExpandMoreIcon sx={{ fontSize: 20, color: 'text.secondary', transition: 'transform 150ms', transform: expanded ? 'rotate(180deg)' : 'none' }} />
        </Box>
      </ListItemButton>
      <Collapse in={expanded} unmountOnExit>
        <Box
          id={panelId}
          sx={{ px: 1.5, pb: 1.5, pl: { xs: 1.5, sm: 5 }, display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 2fr) minmax(0, 3fr)' } }}
        >
          <CodeBlock label="Arguments" value={call.argsJson} note={call.argsTruncated ? 'truncated' : undefined} onCopied={ctx.onCopied} />
          <CodeBlock
            label="Result"
            value={call.result ?? (call.status === 'no_result' ? 'No result was recorded for this call.' : '')}
            note={call.resultTruncated ? `showing ${formatChars(call.result?.length ?? 0)} of ${formatChars(call.resultChars)}` : undefined}
            onCopied={ctx.onCopied}
          />
          {recoveredBy && (
            <Typography variant="caption" color="text.secondary" sx={{ gridColumn: '1 / -1' }}>
              Recovered:{' '}
              <Link component="button" type="button" color="secondary.dark" onClick={() => ctx.jumpTo(recoveredBy.id)} sx={{ verticalAlign: 'baseline' }}>
                call #{recoveredBy.index + 1} ({recoveredBy.name}) succeeded
              </Link>
            </Typography>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

function sumDuration(calls: TraceCall[]): number | undefined {
  const known = calls.filter((c) => c.durationMs != null);
  return known.length ? known.reduce((n, c) => n + (c.durationMs ?? 0), 0) : undefined;
}

function CountChips({ calls }: { calls: TraceCall[] }) {
  const failed = calls.filter((c) => c.status === 'failed').length;
  return (
    <Stack direction="row" spacing={0.75} sx={{ flexShrink: 0 }}>
      <Chip size="small" variant="outlined" label={`${calls.length} call${calls.length === 1 ? '' : 's'}`} />
      {failed > 0 && (
        <Chip
          size="small"
          variant="outlined"
          icon={<CancelIcon />}
          label={`${failed} failed`}
          sx={{ borderColor: 'error.main', '& .MuiChip-icon': { color: 'error.dark' } }}
        />
      )}
    </Stack>
  );
}

function Group({
  title,
  subtitle,
  icon,
  calls,
  open,
  onToggle,
  ctx,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  icon: React.ReactNode;
  calls: TraceCall[];
  open: boolean;
  onToggle: () => void;
  ctx: CallListContext;
}) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, overflow: 'hidden', minWidth: 0 }}>
      <ListItemButton onClick={onToggle} aria-expanded={open} sx={{ gap: 1.25, py: 1.25, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', gap: 1.25, flex: '1 1 260px', minWidth: 0 }}>
          <Box sx={{ pt: '1px', width: 20, display: 'flex', flexShrink: 0 }}>{icon}</Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600}>{title}</Typography>
            {subtitle}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, ml: 'auto' }}>
          <CountChips calls={calls} />
          <Typography variant="caption" color="text.secondary" sx={{ minWidth: 52, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
            {formatDuration(sumDuration(calls))}
          </Typography>
          <ExpandMoreIcon sx={{ fontSize: 20, color: 'text.secondary', transition: 'transform 150ms', transform: open ? 'rotate(180deg)' : 'none' }} />
        </Box>
      </ListItemButton>
      <Collapse in={open} sx={{ '& .MuiCollapse-wrapperInner': { minWidth: 0 } }}>
        {calls.length > 0 && (
          <List disablePadding sx={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 0.25, px: 1, pb: 1 }}>
            {calls.map((call) => (
              <CallRow key={call.id} call={call} ctx={ctx} />
            ))}
          </List>
        )}
      </Collapse>
    </Box>
  );
}

const SETUP = 'setup';
const UNASSIGNED = 'unassigned';
const stepKey = (step: TraceStep) => `step-${step.stepCount}`;
const isUnrecovered = (c: TraceCall) => c.status === 'failed' && !c.recoveredByCallId;

function flip(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/**
 * Work plan steps with the calls that served each one. Steps start collapsed (their notes say what
 * was done) unless something needs a look: an unrecovered failure, an unfinished step, or a step
 * closed with no work of its own. Only unrecovered failures start expanded.
 */
export function WorkPlanTrace({
  trace,
  runStartedAt,
  onCopied,
}: {
  trace: AgentRunTrace;
  runStartedAt?: string;
  onCopied?: (label: string) => void;
}) {
  const byId = useMemo(() => new Map(trace.calls.map((c) => [c.id, c])), [trace.calls]);
  const failedCalls = useMemo(() => trace.calls.filter((c) => c.status === 'failed'), [trace.calls]);
  const steps = useMemo(() => trace.workPlan?.steps ?? [], [trace.workPlan]);

  /** The group each call is shown in. */
  const groupOf = useMemo(() => {
    const map = new Map<string, string>();
    trace.setupCallIds.forEach((id) => map.set(id, SETUP));
    steps.forEach((s) => s.callIds.forEach((id) => map.set(id, stepKey(s))));
    trace.unassignedCallIds.forEach((id) => map.set(id, UNASSIGNED));
    return map;
  }, [trace.setupCallIds, trace.unassignedCallIds, steps]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(trace.calls.filter(isUnrecovered).map((c) => c.id)));
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => {
    const open = new Set<string>();
    const needsLook = (ids: string[]) => ids.some((id) => {
      const c = byId.get(id);
      return !!c && isUnrecovered(c);
    });
    if (needsLook(trace.setupCallIds)) open.add(SETUP);
    for (const s of steps) if (s.status !== 'completed' || s.closedWithoutCalls || needsLook(s.callIds)) open.add(stepKey(s));
    if (!steps.length || needsLook(trace.unassignedCallIds)) open.add(UNASSIGNED);
    return open;
  });
  const [filter, setFilter] = useState<'all' | 'failed'>('all');
  const [focusCallId, setFocusCallId] = useState<string | null>(null);

  const toggle = useCallback((id: string) => setExpanded((prev) => flip(prev, id)), []);
  const toggleGroup = (key: string) => setOpenGroups((prev) => flip(prev, key));

  /** Opens the call and its group; the effect below scrolls to it and moves focus once it has rendered. */
  const jumpTo = useCallback(
    (id: string) => {
      const group = groupOf.get(id);
      if (group) setOpenGroups((prev) => new Set(prev).add(group));
      setExpanded((prev) => new Set(prev).add(id));
      if (byId.get(id)?.status !== 'failed') setFilter('all');
      setFocusCallId(id);
    },
    [groupOf, byId]
  );

  useEffect(() => {
    if (!focusCallId) return;
    const el = document.getElementById(`call-${focusCallId}`);
    el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    (el?.querySelector('[aria-expanded]') as HTMLElement | null)?.focus({ preventScroll: true });
    setFocusCallId(null);
  }, [focusCallId]);

  const pick = (ids: string[]) =>
    ids.map((id) => byId.get(id)).filter((c): c is TraceCall => !!c && (filter === 'all' || c.status === 'failed'));
  const ctx: CallListContext = { byId, runStartedAt, expanded, toggle, jumpTo, onCopied };

  const setup = pick(trace.setupCallIds);
  const unassigned = pick(trace.unassignedCallIds);
  const completedSteps = steps.filter((s) => s.status === 'completed').length;
  const firstFailure = failedCalls.find((c) => !c.recoveredByCallId) ?? failedCalls[0];

  return (
    <Card variant="outlined">
      <CardContent>
        <SectionTitle
          action={
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
              {firstFailure && (
                <Button
                  size="small"
                  color="inherit"
                  startIcon={<CancelIcon sx={{ color: 'error.dark' }} />}
                  onClick={() => jumpTo(firstFailure.id)}
                  sx={{ whiteSpace: 'nowrap' }}
                >
                  First failure
                </Button>
              )}
              <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)} aria-label="Which calls to show">
                <ToggleButton value="all" sx={{ px: 1.25, py: 0.25, whiteSpace: 'nowrap' }}>All ({trace.calls.length})</ToggleButton>
                <ToggleButton value="failed" sx={{ px: 1.25, py: 0.25, whiteSpace: 'nowrap' }} disabled={!failedCalls.length}>
                  Failed ({failedCalls.length})
                </ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          }
        >
          {steps.length ? `Work plan · ${completedSteps} of ${steps.length} steps completed` : 'Tool calls'}
        </SectionTitle>
        {trace.workPlan?.title && (
          <Typography variant="body2" fontWeight={600} sx={{ mb: 1.5 }}>{trace.workPlan.title}</Typography>
        )}
        {trace.workPlanScope === 'session' && steps.length > 0 && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            This session ran again after this run. The step titles, notes and checkmarks show the plan as it is now, which may be from a
            later run; the calls listed under each step are this run's own.
          </Alert>
        )}
        {(trace.callsTruncated || trace.messagesTruncated) && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            This trace is partial: very long sessions are cut at 1,000 messages and 200 tool calls.
          </Alert>
        )}

        <Stack spacing={1}>
          {setup.length > 0 && (
            <Group
              icon={<TuneIcon titleAccess="Setup" sx={{ fontSize: 20, color: 'text.secondary' }} />}
              title="Setup"
              subtitle={<Typography variant="caption" color="text.secondary">Finding and launching the plan</Typography>}
              calls={setup}
              open={openGroups.has(SETUP)}
              onToggle={() => toggleGroup(SETUP)}
              ctx={ctx}
            />
          )}
          {steps.map((step) => {
            const calls = pick(step.callIds);
            if (filter === 'failed' && !calls.length) return null;
            return (
              <Group
                key={step.stepCount}
                icon={<StepStatusIcon status={step.status} />}
                title={`Step ${step.stepCount} · ${step.title}`}
                subtitle={
                  <>
                    {step.notes && (
                      <Typography variant="body2" sx={{ mt: 0.25, wordBreak: 'break-word' }}>
                        <Linkified text={step.notes} />
                      </Typography>
                    )}
                    {step.description && (
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{
                          mt: 0.25,
                          wordBreak: 'break-word',
                          ...(openGroups.has(stepKey(step))
                            ? { display: 'block' }
                            : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
                        }}
                      >
                        Plan: {step.description}
                      </Typography>
                    )}
                    {step.closedWithoutCalls && step.status === 'completed' && (
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.25 }}>
                        <WarningAmberIcon sx={{ fontSize: 14, color: 'warning.dark' }} />
                        Marked completed with no work besides status updates.
                      </Typography>
                    )}
                  </>
                }
                calls={calls}
                open={openGroups.has(stepKey(step))}
                onToggle={() => toggleGroup(stepKey(step))}
                ctx={ctx}
              />
            );
          })}
          {unassigned.length > 0 && (
            <Group
              icon={<Box sx={{ width: 20 }} />}
              title={steps.length ? 'After the last step update' : 'All calls'}
              calls={unassigned}
              open={openGroups.has(UNASSIGNED)}
              onToggle={() => toggleGroup(UNASSIGNED)}
              ctx={ctx}
            />
          )}
          {!trace.calls.length && (
            <Typography variant="body2" color="text.secondary">No tool calls were recorded for this run.</Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  );
}

/**
 * One sanitiser for agent replies, hooks registered once: forms, frames, scripts and inline
 * styles are dropped, links open in a new tab, and images become links, so opening a trace never
 * loads a remote image in the admin's browser.
 */
const replyPurifier = typeof window !== 'undefined' ? DOMPurify(window) : null;
replyPurifier?.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName !== 'img' || !(node instanceof Element)) return;
  const src = node.getAttribute('src') ?? '';
  const alt = node.getAttribute('alt');
  const link = node.ownerDocument.createElement('a');
  if (/^https?:\/\//i.test(src)) link.setAttribute('href', src);
  link.textContent = `[image${alt ? `: ${alt}` : ''}]`;
  node.replaceWith(link);
});
replyPurifier?.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

const SANITIZE = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'iframe', 'script'],
  FORBID_ATTR: ['style'],
};

function sanitizeReply(html: string): string {
  return replyPurifier ? String(replyPurifier.sanitize(html, SANITIZE)) : '';
}

function linksIn(safeHtml: string): Array<{ href: string; label: string }> {
  const doc = new DOMParser().parseFromString(safeHtml, 'text/html');
  const seen = new Set<string>();
  const links: Array<{ href: string; label: string }> = [];
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ href, label: a.textContent?.trim() || href.split('/').pop() || href });
  }
  return links;
}

/** The agent's final reply, rendered (sanitised) or as source, with its links listed up front. */
export function FinalReplyCard({ html, truncated, onCopied }: { html?: string; truncated?: boolean; onCopied?: (label: string) => void }) {
  const [mode, setMode] = useState<'rendered' | 'source'>('rendered');
  const [expanded, setExpanded] = useState(false);
  const safe = useMemo(() => (html ? sanitizeReply(html) : ''), [html]);
  const links = useMemo(() => (safe ? linksIn(safe) : []), [safe]);
  if (!html) return null;
  return (
    <Card variant="outlined" id="final-reply">
      <CardContent>
        <SectionTitle
          action={
            <Stack direction="row" spacing={0.5} alignItems="center">
              <CopyButton value={html} label="Copy reply source" onCopied={onCopied} />
              <ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} aria-label="Reply view">
                <ToggleButton value="rendered" sx={{ px: 1.25, py: 0.25 }}>Rendered</ToggleButton>
                <ToggleButton value="source" sx={{ px: 1.25, py: 0.25 }}>Source</ToggleButton>
              </ToggleButtonGroup>
            </Stack>
          }
        >
          Final reply to the user
        </SectionTitle>
        {links.length > 0 && (
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
            <Typography variant="caption" color="text.secondary">Links in this reply</Typography>
            {links.slice(0, 6).map((l) => (
              <Chip
                key={l.href}
                size="small"
                variant="outlined"
                component="a"
                href={l.href}
                target="_blank"
                rel="noopener noreferrer"
                clickable
                icon={<OpenInNewIcon />}
                label={l.label.length > 48 ? `${l.label.slice(0, 47)}…` : l.label}
                title={l.href}
              />
            ))}
          </Box>
        )}
        {truncated && <Alert severity="info" sx={{ mb: 1 }}>The reply is long; the first 60,000 characters are shown.</Alert>}
        <Box
          sx={{
            maxHeight: expanded ? 'none' : 360,
            overflow: 'hidden',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            p: 2,
            ...(expanded ? {} : { maskImage: 'linear-gradient(#000 80%, transparent)', WebkitMaskImage: 'linear-gradient(#000 80%, transparent)' }),
          }}
        >
          {mode === 'rendered' ? (
            <Box
              data-testid="final-reply-rendered"
              sx={{
                typography: 'body2',
                wordBreak: 'break-word',
                '& h1, & h2, & h3': { fontSize: 15, fontWeight: 600, mt: 2, mb: 1 },
                '& p': { my: 1 },
                '& ul, & ol': { pl: 3, my: 1 },
                '& table': { borderCollapse: 'collapse', my: 1, fontSize: 13 },
                '& th, & td': { border: 1, borderColor: 'divider', px: 1, py: 0.5, textAlign: 'left' },
                '& code': { fontFamily: MONO, fontSize: 12 },
                '& a': { color: 'secondary.dark', wordBreak: 'break-all' },
              }}
              dangerouslySetInnerHTML={{ __html: safe }}
            />
          ) : (
            <Box component="pre" sx={{ m: 0, fontFamily: MONO, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {html}
            </Box>
          )}
        </Box>
        <Button size="small" color="secondary" onClick={() => setExpanded((v) => !v)} sx={{ mt: 0.5, px: 0 }}>
          {expanded ? 'Collapse' : 'Show the whole reply'}
        </Button>
      </CardContent>
    </Card>
  );
}
