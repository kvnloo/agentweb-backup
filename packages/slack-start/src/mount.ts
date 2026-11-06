/**
 * Framework-agnostic mounting. `mountSlackStart` binds one trigger element;
 * `autoBind` binds every [data-agentweb-slack-start] element now and any that
 * appear later (MutationObserver), each exactly once.
 */
import { h, render } from 'preact';
import { Wizard } from './Wizard';
import { injectStyles } from './styles';
import type { SlackStartOptions } from './types';

export const TRIGGER_SELECTOR = '[data-agentweb-slack-start]';
const DEFAULT_STEP_PARAM = 'aw_slack_step';

const bound = new WeakMap<Element, () => void>();
const open = new Set<() => void>();

export function resolveApiBase(el: Element, fallback: string): string {
  const own = el.getAttribute('data-api-base');
  return (own && own.trim() ? own.trim() : fallback).replace(/\/+$/, '');
}

/** Open the wizard now. Returns a function that closes it. */
export function openSlackStart(options: SlackStartOptions, returnFocusTo?: HTMLElement | null): () => void {
  injectStyles();
  const host = document.createElement('div');
  host.setAttribute('data-agentweb-slack-start-root', '');
  document.body.appendChild(host);
  const stepParam = options.stepParam ?? DEFAULT_STEP_PARAM;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    open.delete(close);
    render(null, host);
    host.remove();
    const url = new URL(window.location.href);
    if (url.searchParams.has(stepParam)) {
      url.searchParams.delete(stepParam);
      window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    returnFocusTo?.focus();
  };
  open.add(close);
  render(h(Wizard, { ...options, stepParam, onClose: close }), host);
  return close;
}

/** Bind a trigger element. Returns an unbind function. */
export function mountSlackStart(trigger: HTMLElement, options: SlackStartOptions): () => void {
  const existing = bound.get(trigger);
  if (existing) return existing;
  trigger.setAttribute('aria-haspopup', 'dialog');
  let closeCurrent: (() => void) | null = null;
  const onClick = (e: Event) => {
    e.preventDefault();
    if (closeCurrent && open.has(closeCurrent)) return;
    closeCurrent = openSlackStart({ ...options, apiBase: resolveApiBase(trigger, options.apiBase) }, trigger);
  };
  trigger.addEventListener('click', onClick);
  const unbind = () => {
    trigger.removeEventListener('click', onClick);
    trigger.removeAttribute('aria-haspopup');
    bound.delete(trigger);
  };
  bound.set(trigger, unbind);
  return unbind;
}

/** Bind every current and future [data-agentweb-slack-start] element under `root`. */
export function autoBind(options: SlackStartOptions, root: ParentNode = document): () => void {
  const bindAll = (scope: ParentNode) => {
    if (scope instanceof Element && scope.matches(TRIGGER_SELECTOR)) mountSlackStart(scope as HTMLElement, options);
    scope.querySelectorAll<HTMLElement>(TRIGGER_SELECTOR).forEach((el) => mountSlackStart(el, options));
  };
  bindAll(root);
  const observer = new MutationObserver((records) => {
    for (const r of records) r.addedNodes.forEach((n) => n instanceof Element && bindAll(n));
  });
  observer.observe(root instanceof Document ? root.documentElement : (root as Node), { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** Close every open wizard (tests, SPA route teardown). */
export function closeAllSlackStart(): void {
  Array.from(open).forEach((close) => close());
}
