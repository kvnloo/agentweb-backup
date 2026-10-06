/**
 * ENG-1235 — Emma working-style profile: the pure, structured core.
 *
 * Three independent enumerated dimensions. This module owns normalization,
 * the runtime instruction rendered at prompt assembly, natural-language change
 * parsing for chat, and the telemetry tag. Persistence and onboarding/Settings
 * UI are separate slices that consume these functions; nothing here reads or
 * writes storage.
 */

export type ExperienceLevel = 'new' | 'comfortable' | 'expert';
export type CollaborationStyle = 'guided' | 'direct' | 'fast';
export type RiskPosture = 'conservative' | 'balanced' | 'aggressive';

export interface WorkingStyle {
  experience: ExperienceLevel;
  collaboration: CollaborationStyle;
  risk: RiskPosture;
}

export const DEFAULT_WORKING_STYLE: Readonly<WorkingStyle> = Object.freeze({
  experience: 'comfortable',
  collaboration: 'direct',
  risk: 'balanced',
});

const EXPERIENCE: readonly ExperienceLevel[] = ['new', 'comfortable', 'expert'];
const COLLABORATION: readonly CollaborationStyle[] = ['guided', 'direct', 'fast'];
const RISK: readonly RiskPosture[] = ['conservative', 'balanced', 'aggressive'];

function pick<T extends string>(allowed: readonly T[], v: unknown, fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Coerce any stored/partial value into a valid profile; unknown values fall back per dimension. */
export function normalizeWorkingStyle(raw: unknown): WorkingStyle {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    experience: pick(EXPERIENCE, r.experience, DEFAULT_WORKING_STYLE.experience),
    collaboration: pick(COLLABORATION, r.collaboration, DEFAULT_WORKING_STYLE.collaboration),
    risk: pick(RISK, r.risk, DEFAULT_WORKING_STYLE.risk),
  };
}

const EXPERIENCE_TEXT: Record<ExperienceLevel, string> = {
  new: 'The user is new to this domain: explain the why in plain language, define terms the first time you use them, and teach fundamentals when they matter to the decision.',
  comfortable: 'The user knows the basics: assume baseline knowledge, skip foundational explanations, and offer more detail only when asked.',
  expert: 'The user is an expert: skip fundamentals and common caveats; use precise domain terminology.',
};

const COLLABORATION_TEXT: Record<CollaborationStyle, string> = {
  guided: 'Work step by step: break work into small safe next steps, add genuine encouragement when progress is made, and briefly check understanding before moving on.',
  direct: 'Lead with your recommendation and its rationale; keep replies tight and put optional detail last.',
  fast: 'Be terse: lead with deltas, blockers, and decisions; no padding, recaps, or routine check-ins.',
};

const RISK_TEXT: Record<RiskPosture, string> = {
  conservative: 'Foreground risks concretely and propose a reversible plan or draft for confirmation before acting.',
  balanced: 'Mention material risks with your recommendation; confirm before anything costly or hard to undo.',
  aggressive: 'Move quickly on reversible actions within existing authorization and highlight only material risk.',
};

const INVARIANTS =
  'This working style never overrides authorization, safety rules, spend limits, or explicit approval requirements. ' +
  'Be candid: push back with evidence when a choice is weak, stating the concern, the consequence, and the better path. ' +
  'Never insult, demean, or call the user stupid.';

/** Concrete behavioral instruction for the canonical prompt-assembly point. */
export function buildWorkingStyleInstruction(style: WorkingStyle): string {
  const s = normalizeWorkingStyle(style);
  return [
    `## User working style (${s.experience}/${s.collaboration}/${s.risk})`,
    EXPERIENCE_TEXT[s.experience],
    COLLABORATION_TEXT[s.collaboration],
    RISK_TEXT[s.risk],
    INVARIANTS,
  ].join('\n');
}

export type WorkingStyleChange = Partial<WorkingStyle> | 'reset';

/**
 * Detect an explicit chat request to change working style. Returns null when the
 * message is not such a request — callers must never reclassify silently.
 */
export function parseWorkingStyleRequest(message: string): WorkingStyleChange | null {
  const m = (message || '').toLowerCase();
  if (/\breset\b.*\b(working style|style|preferences)\b/.test(m)) return 'reset';
  const change: Partial<WorkingStyle> = {};
  if (/\b(more concise|be concise|shorter answers|be brief|less verbose|get to the point)\b/.test(m)) change.collaboration = 'fast';
  if (/\b(walk me through|step by step|slow down|explain more)\b/.test(m)) change.collaboration = 'guided';
  if (/\b(more direct|just tell me)\b/.test(m)) change.collaboration = 'direct';
  if (/\bi'?m new\b|\bbeginner\b/.test(m)) change.experience = 'new';
  if (/\bi'?m an expert\b|\bskip the basics\b/.test(m)) change.experience = 'expert';
  if (/\b(more risk|be (more )?aggressive|move faster)\b/.test(m)) change.risk = 'aggressive';
  if (/\b(less risk|be (more )?careful|more cautious|play it safe)\b/.test(m)) change.risk = 'conservative';
  return Object.keys(change).length ? change : null;
}

export function applyWorkingStyleChange(current: WorkingStyle, change: WorkingStyleChange): WorkingStyle {
  if (change === 'reset') return { ...DEFAULT_WORKING_STYLE };
  return normalizeWorkingStyle({ ...normalizeWorkingStyle(current), ...change });
}

/** Observability tag: resolved enums only, never user text. */
export function workingStyleTelemetry(style: WorkingStyle): string {
  const s = normalizeWorkingStyle(style);
  return `working_style=${s.experience}/${s.collaboration}/${s.risk}`;
}
