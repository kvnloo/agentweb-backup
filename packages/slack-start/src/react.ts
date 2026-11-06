/**
 * React adapter. Renders the host page's own <button>; the wizard itself is the
 * shared Preact core (no second implementation). React is a peer dependency.
 *
 *   <SlackStartButton apiBase="https://api.agentweb.pro">Get started in Slack</SlackStartButton>
 */
import { createElement, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { mountSlackStart } from './mount';
import type { SlackStartOptions } from './types';

export type SlackStartButtonProps = Partial<SlackStartOptions> &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> & { children?: ReactNode };

export const DEFAULT_API_BASE = 'https://api.agentweb.pro';

export function SlackStartButton({ apiBase = DEFAULT_API_BASE, fetch, stepParam, nonce, children, ...rest }: SlackStartButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    return mountSlackStart(ref.current, { apiBase, fetch, stepParam, nonce });
  }, [apiBase, fetch, stepParam, nonce]);
  return createElement('button', { type: 'button', ...rest, ref }, children);
}
