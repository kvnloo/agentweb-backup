/**
 * Admin tab for editing onboarding ad-image prompt templates.
 *
 * Each Brick 5 archetype (A-L) is one card. Editing a card and clicking
 * Save bumps the template version in DynamoDB; subsequent ad-image
 * generations carry the new version, so the Live Metrics panel below
 * each card will reflect the new version's like-rate as users interact
 * with their generated ads.
 *
 * Live metrics today: like rate (likes / (likes+skips)), sample size,
 * set-level continue/regenerate counts. Sourced from the new
 * `Dev-AW-PromptSignals` table populated by `/ad-variant/rate` and
 * `/ad-set/signal`.
 */

import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActions,
  CardContent,
  Chip,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import { buildApiUrl } from '../config';
import { useAuth } from '../contexts/AuthContext';

interface PromptTemplate {
  templateId: string;
  version: string;
  name: string;
  feedLayout: string;
  storyLayout: string;
  textBudget: string;
  updatedAt: string;
  updatedBy: string;
}

interface SignalSummary {
  templateId: string;
  promptVersion: string;
  sampleSize: number;
  totals: {
    like: number;
    skip: number;
    continue_set: number;
    regenerate_set: number;
  };
  likeRate: number | null;
  versionTotals: {
    like: number;
    skip: number;
    continue_set: number;
    regenerate_set: number;
  };
  versionSampleSize: number;
}

const ARCHETYPE_IDS = [
  'archetype-A',
  'archetype-B',
  'archetype-C',
  'archetype-D',
  'archetype-E',
  'archetype-F',
  'archetype-G',
  'archetype-H',
  'archetype-I',
  'archetype-J',
  'archetype-K',
  'archetype-L',
] as const;

export default function PromptTemplates(): JSX.Element {
  const { token } = useAuth();
  const [templates, setTemplates] = useState<PromptTemplate[] | null>(null);
  const [signals, setSignals] = useState<Record<string, SignalSummary>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token ?? ''}` }),
    [token],
  );

  const fetchAll = async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await axios.get<{ templates: PromptTemplate[] }>(
        buildApiUrl('/api/admin/prompt-templates'),
        { headers },
      );
      setTemplates(resp.data.templates);
      // Fetch signals for each template in parallel — best-effort, a
      // signals failure shouldn't block the templates list.
      const sig: Record<string, SignalSummary> = {};
      await Promise.all(
        resp.data.templates.map(async (t) => {
          try {
            const r = await axios.get<SignalSummary>(
              buildApiUrl(
                `/api/admin/prompt-templates/${t.templateId}/signals`,
              ),
              { headers },
            );
            sig[t.templateId] = r.data;
          } catch {
            // ignore per-template signal failures
          }
        }),
      );
      setSignals(sig);
    } catch (e: any) {
      setLoadError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) void fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Stack
        direction="row"
        justifyContent="space-between"
        alignItems="center"
        mb={2}
      >
        <Box>
          <Typography variant="h4" fontWeight={600}>
            Prompt Templates
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Brick 5 archetype templates that drive Gemini ad-image
            generation. Edits bump the template version; signals from
            the next generation onward attribute to the new version.
          </Typography>
        </Box>
        <Button
          startIcon={<RefreshIcon />}
          onClick={fetchAll}
          disabled={loading}
        >
          Reload
        </Button>
      </Stack>

      <OutreachInviteCard token={token ?? ''} />

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {loadError}
        </Alert>
      )}

      {loading && (
        <Box display="flex" justifyContent="center" my={6}>
          <CircularProgress />
        </Box>
      )}

      {!loading && templates && (
        <Stack spacing={2}>
          {ARCHETYPE_IDS.map((id) => {
            const tpl = templates.find((t) => t.templateId === id);
            if (!tpl) {
              return (
                <Alert key={id} severity="warning">
                  Missing template for {id} — will be seeded on next load.
                </Alert>
              );
            }
            return (
              <PromptTemplateCard
                key={id}
                template={tpl}
                signals={signals[id]}
                token={token ?? ''}
                onSaved={(updated) => {
                  setTemplates((prev) =>
                    prev
                      ? prev.map((t) =>
                          t.templateId === updated.templateId ? updated : t,
                        )
                      : prev,
                  );
                  // Re-fetch signals for this card so the version stamp
                  // refreshes.
                  void axios
                    .get<SignalSummary>(
                      buildApiUrl(
                        `/api/admin/prompt-templates/${updated.templateId}/signals`,
                      ),
                      { headers },
                    )
                    .then((r) => {
                      setSignals((prev) => ({
                        ...prev,
                        [updated.templateId]: r.data,
                      }));
                    })
                    .catch(() => undefined);
                }}
              />
            );
          })}
        </Stack>
      )}
    </Box>
  );
}

interface OutreachInvitePrompt {
  templateId: string;
  version: string;
  systemPrompt: string;
  withCompanyVariants: string[];
  withoutCompanyVariants: string[];
  updatedAt: string;
  updatedBy: string;
}

/**
 * Editor for the onboarding "review your drafts" invite prompt. Each
 * variant list is edited as one-per-line text; blank lines are dropped on
 * save. Saving bumps the version and takes effect for new onboarding
 * sessions within ~5 minutes (the backend read cache TTL) — no deploy.
 */
function OutreachInviteCard({ token }: { token: string }): JSX.Element {
  const [row, setRow] = useState<OutreachInvitePrompt | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [withCompany, setWithCompany] = useState('');
  const [withoutCompany, setWithoutCompany] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const headers = useMemo(
    () => ({ Authorization: `Bearer ${token}` }),
    [token],
  );

  const hydrate = (r: OutreachInvitePrompt): void => {
    setRow(r);
    setSystemPrompt(r.systemPrompt);
    setWithCompany(r.withCompanyVariants.join('\n'));
    setWithoutCompany(r.withoutCompanyVariants.join('\n'));
  };

  const fetchOne = async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await axios.get<{ template: OutreachInvitePrompt }>(
        buildApiUrl('/api/admin/prompt-templates/outreach/invite'),
        { headers },
      );
      hydrate(resp.data.template);
    } catch (e: any) {
      setLoadError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Without a token there is nothing to fetch — clear the spinner rather
    // than leaving it running forever.
    if (token) void fetchOne();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const splitLines = (s: string): string[] =>
    s
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

  const dirty =
    !!row &&
    (systemPrompt !== row.systemPrompt ||
      withCompany !== row.withCompanyVariants.join('\n') ||
      withoutCompany !== row.withoutCompanyVariants.join('\n'));

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const resp = await axios.put<{ template: OutreachInvitePrompt }>(
        buildApiUrl('/api/admin/prompt-templates/outreach/invite'),
        {
          systemPrompt,
          withCompanyVariants: splitLines(withCompany),
          withoutCompanyVariants: splitLines(withoutCompany),
        },
        { headers },
      );
      hydrate(resp.data.template);
    } catch (e: any) {
      setSaveError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card variant="outlined" sx={{ mb: 3, borderColor: 'primary.main' }}>
      <CardContent>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
          mb={1}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip
                label="OUTREACH"
                color="secondary"
                size="small"
                sx={{ fontWeight: 700 }}
              />
              <Typography variant="h6">Onboarding outreach invite</Typography>
            </Stack>
            <Typography variant="body2" color="text.secondary">
              Variant pool + system prompt the onboarding “review your
              drafts” step pre-fills LinkedIn invites from (brand + ICP
              context). One variant per line. Placeholders:{' '}
              <code>{'{firstName} {company} {icp} {specs} {brand}'}</code> — a
              variant whose placeholder can’t be filled is skipped. No emojis.
            </Typography>
            {row && (
              <Typography variant="caption" color="text.secondary">
                Version {row.version} · last edited{' '}
                {new Date(row.updatedAt).toLocaleString()} by {row.updatedBy}
              </Typography>
            )}
          </Box>
          <Button
            startIcon={<RefreshIcon />}
            onClick={fetchOne}
            disabled={loading || saving}
            size="small"
          >
            Reload
          </Button>
        </Stack>

        {loadError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {loadError}
          </Alert>
        )}
        {loading && (
          <Box display="flex" justifyContent="center" my={3}>
            <CircularProgress size={24} />
          </Box>
        )}

        {!loading && row && (
          <Stack spacing={2}>
            <TextField
              label="System prompt (guidance / future LLM path)"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              multiline
              minRows={3}
              fullWidth
              InputProps={{
                sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
              }}
            />
            <TextField
              label="Variants — prospect HAS a company (one per line)"
              value={withCompany}
              onChange={(e) => setWithCompany(e.target.value)}
              multiline
              minRows={5}
              fullWidth
              InputProps={{
                sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
              }}
            />
            <TextField
              label="Variants — prospect has NO company (one per line)"
              value={withoutCompany}
              onChange={(e) => setWithoutCompany(e.target.value)}
              multiline
              minRows={5}
              fullWidth
              InputProps={{
                sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
              }}
            />
            {saveError && <Alert severity="error">{saveError}</Alert>}
          </Stack>
        )}
      </CardContent>
      <CardActions sx={{ px: 2, pb: 2, justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
          onClick={onSave}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save (bumps version)'}
        </Button>
      </CardActions>
    </Card>
  );
}

interface PromptTemplateCardProps {
  template: PromptTemplate;
  signals?: SignalSummary;
  token: string;
  onSaved: (updated: PromptTemplate) => void;
}

function PromptTemplateCard({
  template,
  signals,
  token,
  onSaved,
}: PromptTemplateCardProps): JSX.Element {
  const [name, setName] = useState(template.name);
  const [feedLayout, setFeedLayout] = useState(template.feedLayout);
  const [storyLayout, setStoryLayout] = useState(template.storyLayout);
  const [textBudget, setTextBudget] = useState(template.textBudget);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset local state when the template prop changes (e.g. after save).
  useEffect(() => {
    setName(template.name);
    setFeedLayout(template.feedLayout);
    setStoryLayout(template.storyLayout);
    setTextBudget(template.textBudget);
  }, [
    template.templateId,
    template.version,
    template.name,
    template.feedLayout,
    template.storyLayout,
    template.textBudget,
  ]);

  const dirty =
    name !== template.name ||
    feedLayout !== template.feedLayout ||
    storyLayout !== template.storyLayout ||
    textBudget !== template.textBudget;

  const onSave = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    try {
      const resp = await axios.put<{ template: PromptTemplate }>(
        buildApiUrl(`/api/admin/prompt-templates/${template.templateId}`),
        { name, feedLayout, storyLayout, textBudget },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      onSaved(resp.data.template);
    } catch (e: any) {
      setSaveError(e?.response?.data?.message || e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  const archetypeId = template.templateId.replace('archetype-', '');

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack
          direction="row"
          justifyContent="space-between"
          alignItems="flex-start"
          mb={2}
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip
                label={archetypeId}
                color="primary"
                size="small"
                sx={{ fontWeight: 700 }}
              />
              <Typography variant="h6">{template.name}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Version {template.version} · last edited{' '}
              {new Date(template.updatedAt).toLocaleString()} by{' '}
              {template.updatedBy}
            </Typography>
          </Box>
          <SignalsPanel signals={signals} />
        </Stack>

        <Stack spacing={2}>
          <TextField
            label="Display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            size="small"
            fullWidth
          />
          <TextField
            label="Feed layout (1080×1080)"
            value={feedLayout}
            onChange={(e) => setFeedLayout(e.target.value)}
            multiline
            minRows={4}
            fullWidth
            InputProps={{
              sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
            }}
          />
          <TextField
            label="Story layout (1080×1350)"
            value={storyLayout}
            onChange={(e) => setStoryLayout(e.target.value)}
            multiline
            minRows={4}
            fullWidth
            InputProps={{
              sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
            }}
          />
          <TextField
            label="Text budget (the rule that constrains Gemini overlays)"
            value={textBudget}
            onChange={(e) => setTextBudget(e.target.value)}
            multiline
            minRows={6}
            fullWidth
            InputProps={{
              sx: { fontFamily: 'monospace', fontSize: '0.85rem' },
            }}
          />
        </Stack>

        {saveError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {saveError}
          </Alert>
        )}
      </CardContent>

      <CardActions sx={{ px: 2, pb: 2, justifyContent: 'flex-end' }}>
        <Button
          variant="contained"
          startIcon={
            saving ? <CircularProgress size={16} /> : <SaveIcon />
          }
          onClick={onSave}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save (bumps version)'}
        </Button>
      </CardActions>
    </Card>
  );
}

function SignalsPanel({
  signals,
}: {
  signals?: SignalSummary;
}): JSX.Element {
  if (!signals) {
    return (
      <Box sx={{ textAlign: 'right', minWidth: 180 }}>
        <Typography variant="caption" color="text.secondary">
          (no signals yet)
        </Typography>
      </Box>
    );
  }
  const likeRatePct =
    signals.likeRate !== null
      ? `${(signals.likeRate * 100).toFixed(0)}%`
      : '—';
  return (
    <Box sx={{ textAlign: 'right', minWidth: 200 }}>
      <Typography variant="overline" color="text.secondary">
        Live metrics (this version)
      </Typography>
      <Typography variant="h5" fontWeight={600}>
        {likeRatePct} like rate
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {signals.totals.like} likes · {signals.totals.skip} skips
        {signals.sampleSize > 0
          ? ` (${signals.sampleSize} signals)`
          : ' (no per-variant signals yet)'}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        Set-level: {signals.versionTotals.continue_set} continued ·{' '}
        {signals.versionTotals.regenerate_set} regenerated
      </Typography>
    </Box>
  );
}
