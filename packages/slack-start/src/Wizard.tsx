/**
 * ENG-2782 S2 — the "Get started in Slack" wizard (one codebase for the
 * script-tag build and the React adapter).
 *
 * Everything the visitor reads comes from the backend config. Each answer is
 * PATCHed before the wizard moves on; step 1 POSTs immediately so research
 * starts while the visitor answers the rest. The current step is mirrored in a
 * URL parameter (browser back, analytics); the intake capability never is.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ApiError, createApiClient } from './api';
import { mountTurnstile } from './captcha';
import { clearSession, loadSession, newIdempotencyKey, saveSession, utmFromLocation, type StoredSession } from './session';
import type { Answers, SlackStartConfig, SlackStartOptions, SlackStartStep } from './types';

type Phase = 'loading' | 'config-error' | 'step' | 'getting-ready' | 'pending' | 'ready' | 'complete-error';
type AnswerField = Exclude<SlackStartStep['id'], 'start'>;

export interface WizardProps extends SlackStartOptions {
  onClose(): void;
}

const DEFAULT_STEP_PARAM = 'aw_slack_step';
const STEP_COUNT = 6;
const PROGRESS = [10, 28, 45, 62, 80, 92];
const POLL_MS = 1500;
const MAX_POLLS = 20;
const FIELD_ERRORS: Record<string, keyof SlackStartConfig['errors']> = {
  invalid_email: 'invalidEmail',
  personal_email: 'personalEmail',
  invalid_website: 'invalidWebsite',
  captcha_failed: 'captcha',
  captcha_unavailable: 'captcha',
  rate_limited: 'rateLimited',
  domain_in_progress: 'domainInProgress',
  account_exists: 'accountExists',
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])';

function emit(type: string, detail: Record<string, unknown> = {}) {
  try {
    window.dispatchEvent(new CustomEvent('agentweb:slack-start', { detail: { type, ...detail } }));
  } catch {
    /* analytics must never break the wizard */
  }
}

function readStepParam(param: string): number | null {
  const raw = new URLSearchParams(window.location.search).get(param);
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= STEP_COUNT ? n : null;
}

function urlWithStep(param: string, step: number | null): string {
  const url = new URL(window.location.href);
  if (step === null) url.searchParams.delete(param);
  else url.searchParams.set(param, String(step));
  return url.pathname + url.search + url.hash;
}

export function Wizard({ apiBase, fetch: fetchImpl, stepParam = DEFAULT_STEP_PARAM, onClose }: WizardProps) {
  const api = useMemo(() => createApiClient(apiBase, fetchImpl ?? window.fetch.bind(window)), [apiBase, fetchImpl]);
  const [phase, setPhase] = useState<Phase>('loading');
  const [config, setConfig] = useState<SlackStartConfig | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [furthest, setFurthest] = useState(0);
  const [session, setSession] = useState<StoredSession>(() => loadSession(apiBase) ?? { idempotencyKey: newIdempotencyKey() });
  const [email, setEmail] = useState(session.email ?? '');
  const [website, setWebsite] = useState(session.website ?? '');
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const captchaRef = useRef<HTMLDivElement>(null);
  const headingId = useMemo(() => `aw-ss-h-${Math.random().toString(36).slice(2, 9)}`, []);

  const persist = useCallback(
    (next: StoredSession) => {
      setSession(next);
      saveSession(apiBase, next);
    },
    [apiBase],
  );

  const goTo = useCallback(
    (index: number, mode: 'push' | 'replace' = 'push') => {
      setError(null);
      setStepIndex(index);
      setFurthest((f) => Math.max(f, index));
      const url = urlWithStep(stepParam, index + 1);
      if (mode === 'push') window.history.pushState({ awSlackStep: index + 1 }, '', url);
      else window.history.replaceState({ awSlackStep: index + 1 }, '', url);
      emit('step_view', { step: index + 1 });
    },
    [stepParam],
  );

  // Load config, then resume a saved intake if there is one.
  const load = useCallback(async () => {
    setPhase('loading');
    try {
      const cfg = await api.config();
      setConfig(cfg);
      let landing = 0;
      if (session.intakeId && session.intakeToken) {
        try {
          const state = await api.read(session.intakeId, session.intakeToken);
          setAnswers(state.answers ?? {});
          setEmail(state.email);
          setWebsite(state.website);
          const resumeMax = Math.min(Math.max(state.furthestStep, 1), STEP_COUNT - 1);
          const fromUrl = readStepParam(stepParam);
          landing = fromUrl !== null && fromUrl - 1 <= resumeMax ? fromUrl - 1 : resumeMax;
          setFurthest(resumeMax);
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            clearSession(apiBase);
            const fresh = { idempotencyKey: newIdempotencyKey() };
            setSession(fresh);
            setEmail('');
            setWebsite('');
          } else {
            throw err;
          }
        }
      }
      setPhase('step');
      goTo(landing, readStepParam(stepParam) === landing + 1 ? 'replace' : 'push');
      emit('open');
    } catch {
      setPhase('config-error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Browser back/forward moves between steps; leaving the step param closes the wizard.
  useEffect(() => {
    const onPop = () => {
      const step = readStepParam(stepParam);
      if (step === null) return onClose();
      if (phase === 'step' && step - 1 <= furthest) {
        setError(null);
        setStepIndex(step - 1);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [stepParam, phase, furthest, onClose]);

  // Escape closes; Tab is trapped inside the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const nodes = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !n.hasAttribute('hidden'));
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active ? panelRef.current.contains(active) : false;
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Move focus into the dialog whenever the screen changes.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      panel.querySelector<HTMLElement>('.aw-ss-body input:not([readonly]), .aw-ss-body button') ??
      panel.querySelector<HTMLElement>(FOCUSABLE) ??
      panel;
    target.focus();
  }, [phase, stepIndex]);

  // Turnstile on step 1, only when the backend publishes a site key and no intake exists yet.
  const needsCaptcha = !!config?.captcha && !session.intakeId;
  useEffect(() => {
    if (!needsCaptcha || phase !== 'step' || stepIndex !== 0 || !captchaRef.current || !config?.captcha) return;
    return mountTurnstile(captchaRef.current, config.captcha.siteKey, setCaptchaToken, () => setError(config.errors.captcha));
  }, [needsCaptcha, phase, stepIndex, config]);

  const messageFor = (err: unknown, fallback: string): string => {
    if (err instanceof ApiError) {
      const key = FIELD_ERRORS[err.code];
      if (err.code === 'domain_in_progress' || err.code === 'account_exists') return err.message && err.message !== err.code ? err.message : config!.errors[key];
      if (key) return config!.errors[key];
    }
    return fallback;
  };

  async function submitStart() {
    if (!config) return;
    if (session.intakeId && session.intakeToken) return goTo(1);
    setBusy(true);
    setError(null);
    try {
      const res = await api.start(
        {
          email: email.trim(),
          website: website.trim(),
          ...(utmFromLocation(window.location.search) ? { utm: utmFromLocation(window.location.search) } : {}),
          ...(captchaToken ? { captchaToken } : {}),
        },
        session.idempotencyKey,
      );
      persist({ ...session, intakeId: res.intakeId, intakeToken: res.intakeToken, email: email.trim(), website: website.trim() });
      emit('started');
      goTo(1);
    } catch (err) {
      setError(messageFor(err, config.errors.generic));
      if (err instanceof ApiError && err.code === 'captcha_failed') {
        setCaptchaToken(null);
        window.turnstile?.reset();
      }
    } finally {
      setBusy(false);
    }
  }

  async function runComplete() {
    if (!config || !session.intakeId || !session.intakeToken) return;
    setPhase('getting-ready');
    setError(null);
    try {
      for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
        const res = await api.complete(session.intakeId, session.intakeToken);
        if (res.status === 'invited') {
          setPhase('ready');
          emit('completed', { status: 'invited' });
          return;
        }
        if (res.status === 'pending') {
          setPhase('pending');
          emit('completed', { status: 'pending' });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      throw new Error('still processing');
    } catch {
      setPhase('complete-error');
    }
  }

  async function submitAnswer(step: SlackStartStep) {
    if (!config || !session.intakeId || !session.intakeToken) return;
    const field = step.id as AnswerField;
    const value = answers[field];
    setBusy(true);
    setError(null);
    try {
      await api.answer(session.intakeId, session.intakeToken, { [field]: value }, stepIndex + 1);
      if (stepIndex === STEP_COUNT - 1) {
        setBusy(false);
        await runComplete();
        return;
      }
      goTo(stepIndex + 1);
    } catch {
      setError(config.errors.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  function back() {
    if (stepIndex === 0) return;
    if (window.history.state?.awSlackStep === stepIndex + 1) {
      window.history.back();
    } else {
      goTo(stepIndex - 1, 'replace');
    }
  }

  function toggle(step: SlackStartStep, optionId: string) {
    const field = step.id as AnswerField;
    setError(null);
    setAnswers((prev) => {
      if (step.kind === 'single') return { ...prev, [field]: optionId };
      const current = Array.isArray(prev[field]) ? (prev[field] as string[]) : [];
      const next = current.includes(optionId) ? current.filter((v) => v !== optionId) : [...current, optionId];
      return { ...prev, [field]: next };
    });
  }

  const step = config?.steps[stepIndex];
  const selected = step && step.id !== 'start' ? answers[step.id as AnswerField] : undefined;
  const hasSelection = Array.isArray(selected) ? selected.length > 0 : typeof selected === 'string';
  const readOnlyStart = !!session.intakeId;

  let body;
  if (phase === 'loading') {
    body = (
      <div class="aw-ss-body" aria-busy="true">
        <div class="aw-ss-spin" />
        <h2 class="aw-ss-h" id={headingId}>
          Loading…
        </h2>
      </div>
    );
  } else if (phase === 'config-error') {
    body = (
      <div class="aw-ss-body">
        <h2 class="aw-ss-h" id={headingId}>
          Something went wrong
        </h2>
        <p class="aw-ss-err" role="alert">
          We couldn't load this right now.
        </p>
        <button type="button" class="aw-ss-btn" onClick={() => void load()}>
          Try again
        </button>
      </div>
    );
  } else if (phase === 'getting-ready' || phase === 'complete-error') {
    const copy = config!.screens.gettingReady;
    body = (
      <div class="aw-ss-body" aria-live="polite">
        {phase === 'getting-ready' && <div class="aw-ss-spin" />}
        <h2 class="aw-ss-h" id={headingId}>
          {copy.heading}
        </h2>
        <p class="aw-ss-sub">{copy.subline}</p>
        {phase === 'complete-error' && (
          <>
            <p class="aw-ss-err" role="alert">
              {config!.errors.generic}
            </p>
            <button type="button" class="aw-ss-btn" onClick={() => void runComplete()}>
              {config!.buttons.retry}
            </button>
          </>
        )}
      </div>
    );
  } else if (phase === 'pending' || phase === 'ready') {
    const copy = phase === 'ready' ? config!.screens.ready : config!.screens.pending;
    body = (
      <div class="aw-ss-body" aria-live="polite">
        <h2 class="aw-ss-h" id={headingId}>
          {copy.heading}
        </h2>
        <p class="aw-ss-sub">{copy.body}</p>
        <button type="button" class="aw-ss-btn" onClick={onClose}>
          {config!.buttons.close}
        </button>
      </div>
    );
  } else if (step) {
    const isLast = stepIndex === STEP_COUNT - 1;
    const cta = step.cta ?? config!.buttons.continue;
    body = (
      <div class="aw-ss-body">
        <div class="aw-ss-bar">
          <button type="button" class="aw-ss-back" aria-label={config!.buttons.back} disabled={stepIndex === 0 || busy} onClick={back}>
            ‹
          </button>
          <div
            class="aw-ss-track"
            role="progressbar"
            aria-label="Progress"
            aria-valuemin={1}
            aria-valuemax={STEP_COUNT}
            aria-valuenow={stepIndex + 1}
          >
            <span class="aw-ss-fill" style={{ width: `${PROGRESS[stepIndex]}%` }} />
          </div>
        </div>
        <h2 class="aw-ss-h" id={headingId}>
          {step.heading}
        </h2>
        <p class="aw-ss-sub">{step.subline}</p>
        {step.kind === 'start' && step.fields ? (
          <form
            class="aw-ss-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submitStart();
            }}
          >
            <label class="aw-ss-lbl" for={`${headingId}-email`}>
              {step.fields.email.label}
            </label>
            <input
              class="aw-ss-in"
              id={`${headingId}-email`}
              type="email"
              autoComplete="email"
              required
              readOnly={readOnlyStart}
              placeholder={step.fields.email.placeholder}
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
            />
            <label class="aw-ss-lbl" for={`${headingId}-website`}>
              {step.fields.website.label}
            </label>
            <input
              class="aw-ss-in"
              id={`${headingId}-website`}
              type="text"
              inputMode="url"
              autoComplete="url"
              required
              readOnly={readOnlyStart}
              placeholder={step.fields.website.placeholder}
              value={website}
              onInput={(e) => setWebsite((e.target as HTMLInputElement).value)}
            />
            {needsCaptcha && <div class="aw-ss-captcha" ref={captchaRef} />}
            {error && (
              <p class="aw-ss-err" role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              class="aw-ss-btn"
              disabled={busy || !email.trim() || !website.trim() || (needsCaptcha && !captchaToken)}
              aria-busy={busy}
            >
              {busy ? '…' : `${cta} →`}
            </button>
          </form>
        ) : (
          <>
            <fieldset class={`aw-ss-list${listLayout(step)}`} aria-labelledby={headingId}>
              {renderOptions(step, selected, (id) => toggle(step, id), `${headingId}-${step.id}`)}
            </fieldset>
            {step.note && <p class="aw-ss-note">{step.note}</p>}
            {error && (
              <p class="aw-ss-err" role="alert">
                {error}
              </p>
            )}
            {error ? (
              <button type="button" class="aw-ss-btn" disabled={busy} onClick={() => void submitAnswer(step)}>
                {config!.buttons.retry}
              </button>
            ) : (
              <button type="button" class="aw-ss-btn" disabled={busy || !hasSelection} aria-busy={busy} onClick={() => void submitAnswer(step)}>
                {busy ? '…' : `${isLast ? cta : config!.buttons.continue} →`}
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div class="aw-ss-root" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="aw-ss-panel" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} ref={panelRef}>
        <button type="button" class="aw-ss-close" aria-label={config?.buttons.close ?? 'Close'} onClick={onClose}>
          ×
        </button>
        {body}
      </div>
    </div>
  );
}

function listLayout(step: SlackStartStep): string {
  if (step.options?.some((o) => o.group)) return ' aw-ss-three';
  return (step.options?.length ?? 0) > 6 || step.id === 'adSpend' ? ' aw-ss-two' : '';
}

function renderOptions(step: SlackStartStep, selected: string | string[] | undefined, onToggle: (id: string) => void, name: string) {
  const multi = step.kind === 'multi';
  const isOn = (id: string) => (Array.isArray(selected) ? selected.includes(id) : selected === id);
  const out: preact.JSX.Element[] = [];
  let group: string | undefined;
  for (const option of step.options ?? []) {
    if (option.group && option.group !== group) {
      group = option.group;
      out.push(
        <p class="aw-ss-group" key={`g-${group}`}>
          {group}
        </p>,
      );
    }
    const on = isOn(option.id);
    out.push(
      <label class={`aw-ss-o${multi ? ' aw-ss-multi' : ''}${on ? ' aw-ss-on' : ''}`} key={option.id}>
        <input type={multi ? 'checkbox' : 'radio'} name={name} value={option.id} checked={on} onChange={() => onToggle(option.id)} />
        <span>{option.label}</span>
        <span class="aw-ss-mark" aria-hidden="true" />
      </label>,
    );
  }
  return out;
}
