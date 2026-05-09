from __future__ import annotations

import argparse
import asyncio
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import urlparse


URL_PATTERN = re.compile(r"\b(?:https?://)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:/[^\s]*)?")
BROWSER_WORDS = ("browser", "open ", "load ", "go to ", "visit ", "website", "web page", "webpage")


@dataclass(frozen=True)
class BrowserPage:
    requested_url: str
    final_url: str
    title: str
    text: str


@dataclass(frozen=True)
class BrowserActionResult:
    ok: bool
    message: str


def task_needs_browser(task: str) -> bool:
    lower = task.lower()
    return bool(extract_urls(task)) and any(word in lower for word in BROWSER_WORDS)


def extract_urls(text: str) -> list[str]:
    urls: list[str] = []
    for match in URL_PATTERN.findall(text):
        url = normalize_url(match.rstrip(".,);]"))
        if url not in urls:
            urls.append(url)
    return urls


def normalize_url(url: str) -> str:
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    parsed = urlparse(url)
    if not parsed.netloc:
        raise ValueError(f"Invalid URL: {url}")
    return url


async def load_page(
    url: str,
    *,
    max_chars: int = 12000,
    backend: str = "chrome",
    headless: bool = False,
    profile_dir: str | None = "~/.codex-relay/chrome-profile",
    timeout_ms: int = 30000,
) -> BrowserPage:
    if backend == "chrome":
        return load_page_with_existing_chrome(url, max_chars=max_chars, timeout_ms=timeout_ms)
    if backend != "playwright":
        raise ValueError(f"Unsupported browser backend: {backend}")
    return await load_page_with_playwright(
        url,
        max_chars=max_chars,
        headless=headless,
        profile_dir=profile_dir,
        timeout_ms=timeout_ms,
    )


async def load_page_with_playwright(
    url: str,
    *,
    max_chars: int = 12000,
    headless: bool = False,
    profile_dir: str | None = "~/.codex-relay/chrome-profile",
    timeout_ms: int = 30000,
) -> BrowserPage:
    from playwright.async_api import async_playwright

    normalized = normalize_url(url)
    async with async_playwright() as playwright:
        context = await _launch_context(playwright, headless=headless, profile_dir=profile_dir)
        page = await context.new_page()
        await page.goto(normalized, wait_until="domcontentloaded", timeout=timeout_ms)
        try:
            await page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass
        title = await page.title()
        text = await page.locator("body").inner_text(timeout=timeout_ms)
        final_url = page.url
        await context.close()
    return BrowserPage(
        requested_url=normalized,
        final_url=final_url,
        title=title.strip(),
        text=_clean_text(text)[:max_chars],
    )


def load_page_with_existing_chrome(url: str, *, max_chars: int = 12000, timeout_ms: int = 30000) -> BrowserPage:
    normalized = normalize_url(url)
    script = r'''
on run argv
  set targetUrl to item 1 of argv
  set maxWaitSeconds to (item 2 of argv) as integer
  set separatorUrl to "---CODEX_RELAY_URL---"
  set separatorText to "---CODEX_RELAY_TEXT---"

  tell application "Google Chrome"
    activate
    if (count of windows) = 0 then make new window
    set targetTab to active tab of front window
    set URL of targetTab to targetUrl
  end tell

  delay 1
  set deadline to (current date) + maxWaitSeconds
  repeat
    try
      tell application "Google Chrome"
        set currentUrl to URL of targetTab
        set readyState to execute targetTab javascript "document.readyState"
      end tell
      if currentUrl is not "" and currentUrl is not "about:blank" and (readyState is "complete" or readyState is "interactive") then exit repeat
    end try
    if (current date) > deadline then exit repeat
    delay 0.5
  end repeat

  delay 0.5

  tell application "Google Chrome"
    set pageTitle to title of targetTab
    set finalUrl to URL of targetTab
    set pageText to execute targetTab javascript "document.body ? document.body.innerText : ''"
  end tell

  return pageTitle & linefeed & separatorUrl & linefeed & finalUrl & linefeed & separatorText & linefeed & pageText
end run
'''
    proc = subprocess.run(
        ["osascript", "-e", script, normalized, str(max(1, timeout_ms // 1000))],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=(timeout_ms // 1000) + 10,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(_chrome_error_message(proc.stderr.strip()))

    title, final_url, text = _parse_chrome_output(proc.stdout)
    return BrowserPage(
        requested_url=normalized,
        final_url=final_url,
        title=title,
        text=_clean_text(text)[:max_chars],
    )


def read_existing_chrome(*, max_chars: int = 12000) -> BrowserPage:
    script = _chrome_read_script()
    proc = _run_osascript(script)
    if proc.returncode != 0:
        raise RuntimeError(_chrome_error_message(proc.stderr.strip()))
    title, final_url, text = _parse_chrome_output(proc.stdout)
    return BrowserPage(
        requested_url=final_url,
        final_url=final_url,
        title=title,
        text=_clean_text(text)[:max_chars],
    )


def click_existing_chrome(
    *,
    text: str = "",
    selector: str = "",
    role: str = "",
    name: str = "",
    x: int | None = None,
    y: int | None = None,
    index: int = 1,
) -> BrowserActionResult:
    if x is not None and y is not None:
        js = f"document.elementFromPoint({x}, {y})?.click(); 'clicked coordinates {x},{y}'"
    elif selector:
        js = _click_selector_js(selector, index)
    elif role or name:
        js = _click_text_js(name or text, role=role, index=index)
    elif text:
        js = _click_text_js(text, index=index)
    else:
        raise ValueError("click requires --text, --selector, --role/--name, or --x/--y")
    return _execute_chrome_javascript(js)


def type_existing_chrome(text: str, *, selector: str = "", clear: bool = False) -> BrowserActionResult:
    if not text:
        raise ValueError("type requires non-empty text")
    js = _type_js(text, selector=selector, clear=clear)
    return _execute_chrome_javascript(js)


async def browser_context_for_task(
    task: str,
    *,
    max_chars_per_page: int = 12000,
    backend: str = "chrome",
    headless: bool = False,
    profile_dir: str | None = "~/.codex-relay/chrome-profile",
) -> str:
    urls = extract_urls(task)
    if not urls:
        return ""
    pages = []
    for url in urls[:3]:
        try:
            pages.append(
                await load_page(
                    url,
                    max_chars=max_chars_per_page,
                    backend=backend,
                    headless=headless,
                    profile_dir=profile_dir,
                )
            )
        except Exception as exc:
            pages.append(BrowserPage(requested_url=url, final_url=url, title="Browser load failed", text=str(exc)))
    return format_browser_context(pages)


def format_browser_context(pages: Iterable[BrowserPage]) -> str:
    sections = []
    for page in pages:
        sections.append(
            "\n".join(
                [
                    f"Requested URL: {page.requested_url}",
                    f"Final URL: {page.final_url}",
                    f"Title: {page.title or '(no title)'}",
                    "Visible text:",
                    page.text or "(no visible text)",
                ]
            )
        )
    return "\n\n---\n\n".join(sections)


async def _launch_context(playwright, *, headless: bool, profile_dir: str | None):
    if profile_dir:
        user_data_dir = Path(profile_dir).expanduser()
        user_data_dir.mkdir(parents=True, exist_ok=True)
        try:
            return await playwright.chromium.launch_persistent_context(
                str(user_data_dir),
                channel="chrome",
                headless=headless,
            )
        except Exception:
            return await playwright.chromium.launch_persistent_context(str(user_data_dir), headless=headless)

    try:
        browser = await playwright.chromium.launch(channel="chrome", headless=headless)
    except Exception:
        browser = await playwright.chromium.launch(headless=headless)
    return await browser.new_context()


def _clean_text(text: str) -> str:
    lines = [line.strip() for line in text.splitlines()]
    return "\n".join(line for line in lines if line)


def _parse_chrome_output(output: str) -> tuple[str, str, str]:
    if "\n---CODEX_RELAY_URL---\n" not in output or "\n---CODEX_RELAY_TEXT---\n" not in output:
        return "", "", output
    title, rest = output.split("\n---CODEX_RELAY_URL---\n", 1)
    final_url, text = rest.split("\n---CODEX_RELAY_TEXT---\n", 1)
    return title.strip(), final_url.strip(), text.strip()


def _chrome_read_script() -> str:
    return r'''
on run argv
  set separatorUrl to "---CODEX_RELAY_URL---"
  set separatorText to "---CODEX_RELAY_TEXT---"
  tell application "Google Chrome"
    activate
    if (count of windows) = 0 then error "Google Chrome has no open windows"
    set targetTab to active tab of front window
    set pageTitle to title of targetTab
    set finalUrl to URL of targetTab
    set pageText to execute targetTab javascript "document.body ? document.body.innerText : ''"
  end tell
  return pageTitle & linefeed & separatorUrl & linefeed & finalUrl & linefeed & separatorText & linefeed & pageText
end run
'''


def _execute_chrome_javascript(js: str) -> BrowserActionResult:
    script = r'''
on run argv
  set sourceJs to item 1 of argv
  tell application "Google Chrome"
    activate
    if (count of windows) = 0 then error "Google Chrome has no open windows"
    set targetTab to active tab of front window
    set resultText to execute targetTab javascript sourceJs
  end tell
  return resultText
end run
'''
    proc = _run_osascript(script, js)
    if proc.returncode != 0:
        return BrowserActionResult(ok=False, message=_chrome_error_message(proc.stderr.strip()))
    return BrowserActionResult(ok=True, message=proc.stdout.strip() or "ok")


def _click_selector_js(selector: str, index: int) -> str:
    return f"""
(() => {{
  const nodes = Array.from(document.querySelectorAll({selector!r})).filter(el => {{
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }});
  const el = nodes[{max(index, 1) - 1}];
  if (!el) return `no visible element matched selector: {selector}`;
  el.scrollIntoView({{ block: 'center', inline: 'center' }});
  el.click();
  return `clicked selector: {selector}`;
}})()
"""


def _click_text_js(text: str, *, role: str = "", index: int = 1) -> str:
    return f"""
(() => {{
  const wanted = {text!r}.toLowerCase();
  const wantedRole = {role!r}.toLowerCase();
  const candidates = Array.from(document.querySelectorAll('button, a, input, textarea, [role], [aria-label], [data-control-name], [contenteditable="true"]'));
  const matches = candidates.filter(el => {{
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const role = (el.getAttribute('role') || el.tagName || '').toLowerCase();
    if (wantedRole && role !== wantedRole) return false;
    const label = [
      el.innerText,
      el.textContent,
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el.value,
      el.getAttribute('data-control-name')
    ].filter(Boolean).join(' ').trim().toLowerCase();
    return label.includes(wanted);
  }});
  const el = matches[{max(index, 1) - 1}];
  if (!el) return `no visible element matched text: {text}`;
  el.scrollIntoView({{ block: 'center', inline: 'center' }});
  el.click();
  return `clicked text: {text}`;
}})()
"""


def _type_js(text: str, *, selector: str = "", clear: bool = False) -> str:
    target = (
        f"document.querySelector({selector!r})"
        if selector
        else "document.activeElement"
    )
    return f"""
(() => {{
  const el = {target};
  if (!el) return 'no target element for typing';
  el.focus();
  if ({str(clear).lower()}) {{
    if ('value' in el) el.value = '';
    else el.textContent = '';
  }}
  const text = {text!r};
  if ('value' in el) {{
    el.value = (el.value || '') + text;
    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
  }} else {{
    document.execCommand('insertText', false, text);
  }}
  return 'typed text';
}})()
"""


def _run_osascript(script: str, *args: str, timeout_seconds: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["osascript", "-e", script, *args],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
        check=False,
    )


def _chrome_error_message(stderr: str) -> str:
    return (
        "Could not read existing Google Chrome through AppleScript. "
        "Open Chrome and enable View > Developer > Allow JavaScript from Apple Events, "
        f"then retry. AppleScript error: {stderr or '(no stderr)'}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Control existing Chrome or load a page for Codex relay tasks.")
    subparsers = parser.add_subparsers(dest="command")

    open_parser = subparsers.add_parser("open", help="Open a URL and print visible page text.")
    open_parser.add_argument("url")
    _add_load_args(open_parser)

    read_parser = subparsers.add_parser("read", help="Read visible text from the active Chrome tab.")
    read_parser.add_argument("--max-chars", type=int, default=12000)

    click_parser = subparsers.add_parser("click", help="Click a visible element in existing Chrome.")
    click_parser.add_argument("--text", default="", help="Click element containing this visible text or label.")
    click_parser.add_argument("--selector", default="", help="Click a CSS selector.")
    click_parser.add_argument("--role", default="", help="Optional role/tag filter for text clicks, such as button.")
    click_parser.add_argument("--name", default="", help="Accessible name/text used with --role.")
    click_parser.add_argument("--index", type=int, default=1, help="1-based match index.")
    click_parser.add_argument("--x", type=int, help="Viewport x coordinate.")
    click_parser.add_argument("--y", type=int, help="Viewport y coordinate.")

    type_parser = subparsers.add_parser("type", help="Type into active or selected element in existing Chrome.")
    type_parser.add_argument("text")
    type_parser.add_argument("--selector", default="", help="Optional CSS selector to type into.")
    type_parser.add_argument("--clear", action="store_true", help="Clear target before typing.")

    args = parser.parse_args()

    if args.command == "read":
        print(format_browser_context([read_existing_chrome(max_chars=args.max_chars)]))
        return
    if args.command == "click":
        result = click_existing_chrome(
            text=args.text,
            selector=args.selector,
            role=args.role,
            name=args.name,
            x=args.x,
            y=args.y,
            index=args.index,
        )
        print(result.message)
        raise SystemExit(0 if result.ok else 1)
    if args.command == "type":
        result = type_existing_chrome(args.text, selector=args.selector, clear=args.clear)
        print(result.message)
        raise SystemExit(0 if result.ok else 1)

    if args.command != "open":
        parser.error("a command is required")

    page = asyncio.run(
        load_page(
            args.url,
            max_chars=args.max_chars,
            backend=args.backend,
            headless=args.headless,
            profile_dir=args.profile_dir,
        )
    )
    print(format_browser_context([page]))


def _add_load_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--backend", choices=("chrome", "playwright"), default="chrome", help="Browser backend to use.")
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--headless", action="store_true", help="Run without showing a browser window.")
    parser.add_argument("--profile-dir", default="~/.codex-relay/chrome-profile", help="Persistent Chrome profile directory.")


if __name__ == "__main__":
    main()
