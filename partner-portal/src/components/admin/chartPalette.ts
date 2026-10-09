/**
 * Fixed chart palettes for the admin dashboards (ENG-1845).
 *
 * These are deliberately NOT theme tokens. A chart needs N mutually
 * distinguishable categorical colours that stay stable across theme changes,
 * whereas the brand theme is a two-hue primary/secondary ramp. Centralising
 * them here documents the intent and keeps every chart on the same values.
 * Values are unchanged from the inline literals they replace.
 */

/** Material-style series colours used by the Chart.js admin charts. */
export const CHART_SERIES = {
  blue: '#1976d2',
  lightBlue: '#2196f3',
  green: '#4caf50',
  orange: '#ff9800',
  red: '#f44336',
  purple: '#9c27b0',
  cyan: '#00bcd4',
} as const;

/** Six-step categorical palette for the cost-by-model dashboard. */
export const COST_SERIES_PALETTE: readonly string[] = [
  '#155EEF',
  '#7F56D9',
  '#039855',
  '#DC6803',
  '#D92D20',
  '#667085',
];

/**
 * Okabe-Ito colourblind-safe palette keyed by enrichment provider.
 * Keep this sequence intact; do not route it through brand tokens.
 */
export const ENRICHMENT_PROVIDER_PALETTE: Record<string, string> = {
  sibling: '#999999',
  apollo: '#0072B2',
  enrichSo: '#CC79A7',
  unipile: '#56B4E9',
  webSearch: '#E69F00',
  llm: '#009E73',
};
