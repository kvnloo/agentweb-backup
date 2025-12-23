#!/usr/bin/env python3
"""
Download public Feishu/Lark wiki content from a shared URL.
"""

import argparse
import json
import logging
import re
import sys
from pathlib import Path
from typing import Any, Iterable, List, Optional, Tuple
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " \
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download Feishu/Lark wiki content from a shared URL."
    )
    parser.add_argument(
        "url",
        nargs="?",
        help="Feishu/Lark wiki URL to download (optional if --urls-file is used)",
    )
    parser.add_argument(
        "--urls-file",
        default=None,
        help="Path to a file with one Feishu/Lark URL per line",
    )
    parser.add_argument(
        "--output-dir",
        default="downloads/feishu",
        help="Directory to write outputs (default: downloads/feishu)",
    )
    parser.add_argument(
        "--cookie",
        default=None,
        help="Cookie header value to include in the request",
    )
    parser.add_argument(
        "--cookie-file",
        default=None,
        help="Path to a file containing a Cookie header value",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Request timeout in seconds (default: 30)",
    )
    parser.add_argument(
        "--no-render",
        action="store_true",
        help="Skip headless browser rendering and use raw HTML extraction",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download even if output files already exist",
    )
    return parser.parse_args()


def normalize_url(raw_url: str) -> str:
    raw_url = raw_url.strip()
    if not raw_url.startswith(("http://", "https://")):
        raw_url = f"https://{raw_url}"
    return raw_url


def extract_token_from_url(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path.rstrip("/")
    if not path:
        return "feishu_content"
    return path.split("/")[-1]


def read_cookie_value(cookie: Optional[str], cookie_file: Optional[str]) -> Optional[str]:
    if cookie and cookie_file:
        raise ValueError("Provide only one of --cookie or --cookie-file.")
    if cookie_file:
        return Path(cookie_file).read_text(encoding="utf-8").strip()
    return cookie


def fetch_html(
    url: str,
    cookie_value: Optional[str],
    timeout: int,
) -> str:
    headers = {"User-Agent": DEFAULT_USER_AGENT}
    if cookie_value:
        headers["Cookie"] = cookie_value
    response = requests.get(url, headers=headers, timeout=timeout)
    response.raise_for_status()
    return response.text


def extract_title(soup: BeautifulSoup) -> str:
    og_title = soup.find("meta", property="og:title")
    if og_title and og_title.get("content"):
        return og_title["content"].strip()
    if soup.title and soup.title.string:
        return soup.title.string.strip()
    return "Untitled Feishu Page"


def text_from_html(soup: BeautifulSoup) -> str:
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    main = soup.find("article")
    if main:
        text = main.get_text(separator="\n", strip=True)
        if text:
            return text
    return soup.get_text(separator="\n", strip=True)


def extract_ssr_blocks_text(soup: BeautifulSoup) -> str:
    container = soup.find(id="ssrBox") or soup.find("div", class_="wiki-ssr-content-box")
    if not container:
        return ""

    lines: List[str] = []

    def block_text(block: BeautifulSoup) -> str:
        spans = block.select('span[data-string="true"]')
        if spans:
            parts = [span.get_text(strip=True) for span in spans]
            return "".join([p for p in parts if p])
        return block.get_text(separator="", strip=True)

    for block in container.select("[data-block-type]"):
        block_type = str(block.get("data-block-type", "")).lower()
        text = block_text(block)
        if not text:
            continue
        if "heading" in block_type:
            lines.append(text)
            lines.append("")
        elif "bullet" in block_type:
            lines.append(f"- {text}")
        elif "ordered" in block_type:
            lines.append(f"1. {text}")
        else:
            lines.append(text)

    if not lines:
        return ""

    cleaned_lines: List[str] = []
    for line in lines:
        if line or (cleaned_lines and cleaned_lines[-1]):
            cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip()


def find_json_blobs(html: str) -> Iterable[str]:
    patterns = [
        r"window\.__INITIAL_STATE__\s*=\s*({.*?})\s*;",
        r"window\.__PRELOADED_STATE__\s*=\s*({.*?})\s*;",
        r"window\.__DATA__\s*=\s*({.*?})\s*;",
        r"__initialData__\s*=\s*({.*?})\s*;",
        r"__INITIAL_STATE__\s*=\s*JSON\.parse\(\"(.*?)\"\)\s*;",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, html, flags=re.DOTALL):
            blob = match.group(1)
            if "JSON.parse" in pattern:
                blob = bytes(blob, "utf-8").decode("unicode_escape")
            yield blob


def extract_json_assignment(html: str, key: str, index: int) -> Optional[str]:
    eq_index = html.find("=", index)
    if eq_index == -1:
        return None
    start = html.find("{", eq_index)
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(html)):
        ch = html[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return html[start : i + 1]
    return None


def iter_json_assignments(html: str, key: str) -> Iterable[str]:
    start = 0
    while True:
        index = html.find(key, start)
        if index == -1:
            break
        blob = extract_json_assignment(html, key, index)
        if blob:
            yield blob
        start = index + len(key)


def try_parse_json(blob: str) -> Optional[Any]:
    try:
        return json.loads(blob)
    except json.JSONDecodeError:
        return None


def iter_strings(obj: Any) -> Iterable[str]:
    if isinstance(obj, dict):
        for value in obj.values():
            yield from iter_strings(value)
    elif isinstance(obj, list):
        for value in obj:
            yield from iter_strings(value)
    elif isinstance(obj, str):
        yield obj


def text_from_json(obj: Any, min_length: int = 20) -> str:
    strings = []
    seen = set()
    for text in iter_strings(obj):
        cleaned = text.strip()
        if len(cleaned) < min_length:
            continue
        if cleaned in seen:
            continue
        seen.add(cleaned)
        strings.append(cleaned)
    return "\n".join(strings)


def extract_record_text(record: dict) -> str:
    data = record.get("data", {})
    text_data = data.get("text", {})
    init_text = text_data.get("initialAttributedTexts", {})
    text_map = init_text.get("text")
    if isinstance(text_map, dict):
        def key_func(key: str) -> int:
            try:
                return int(key)
            except ValueError:
                return 0
        parts = [text_map[k] for k in sorted(text_map.keys(), key=key_func)]
        return "".join(parts).strip()
    if isinstance(text_map, list):
        return "".join(text_map).strip()
    if isinstance(text_map, str):
        return text_map.strip()
    return ""


def build_text_from_catalog(catalog: dict) -> str:
    records = catalog.get("headingRecords") or {}
    if not records:
        return ""
    roots: List[str] = []
    for record in records.values():
        data = record.get("data", {})
        if data.get("type") == "page" or data.get("parent_id") in ("", None):
            if record.get("id"):
                roots.append(record["id"])
    if not roots:
        roots = list(records.keys())

    lines: List[str] = []
    visited = set()

    def walk(record_id: str) -> None:
        if record_id in visited:
            return
        visited.add(record_id)
        record = records.get(record_id)
        if not record:
            return
        data = record.get("data", {})
        record_type = str(data.get("type", "")).lower()
        text = extract_record_text(record)

        if record_type in {"page", "title", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6"}:
            if text:
                lines.append(text)
                lines.append("")
        elif "bullet" in record_type:
            if text:
                lines.append(f"- {text}")
        elif "ordered" in record_type:
            if text:
                lines.append(f"1. {text}")
        else:
            if text:
                lines.append(text)

        for child_id in data.get("children", []):
            walk(child_id)

    for root_id in roots:
        walk(root_id)

    cleaned_lines: List[str] = []
    for line in lines:
        if line or (cleaned_lines and cleaned_lines[-1]):
            cleaned_lines.append(line)
    return "\n".join(cleaned_lines).strip()


def extract_catalog_content(html: str) -> Tuple[str, Optional[Any]]:
    best_text = ""
    best_data = None
    for blob in iter_json_assignments(html, "window.catalogRecordInfo"):
        data = try_parse_json(blob)
        if not data:
            continue
        text = build_text_from_catalog(data)
        if len(text) > len(best_text):
            best_text = text
            best_data = data
    return best_text, best_data






def extract_content(html: str) -> Tuple[str, Optional[Any]]:
    soup = BeautifulSoup(html, "html.parser")
    ssr_text = extract_ssr_blocks_text(soup)
    html_text = ssr_text or text_from_html(soup)

    best_text = html_text if len(html_text) >= 200 else ""
    best_json = None

    catalog_text, catalog_json = extract_catalog_content(html)
    if len(catalog_text) > len(best_text):
        best_text = catalog_text
        best_json = catalog_json

    for blob in find_json_blobs(html):
        parsed = try_parse_json(blob)
        if parsed is None:
            continue
        candidate = text_from_json(parsed)
        if len(candidate) > len(best_text):
            best_text = candidate
            best_json = parsed

    return best_text, best_json


def safe_filename(name: str) -> str:
    name = re.sub(r"[^\w\-]+", "_", name.strip())
    return name.strip("_") or "feishu_content"


def write_outputs(
    output_dir: Path,
    token: str,
    title: str,
    html: str,
    text: str,
    json_data: Optional[Any],
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    base = safe_filename(token or title)

    html_path = output_dir / f"{base}.html"
    html_path.write_text(html, encoding="utf-8")
    logger.info("Saved HTML: %s", html_path)

    text_path = output_dir / f"{base}.txt"
    text_path.write_text(f"{title}\n\n{text}".strip() + "\n", encoding="utf-8")
    logger.info("Saved text: %s", text_path)

    if json_data is not None:
        json_path = output_dir / f"{base}.json"
        json_path.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.info("Saved JSON: %s", json_path)


def render_with_playwright(url: str, timeout: int) -> str:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.info("Playwright not available; skipping render step.")
        return ""

    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled"],
            )
        except Exception as exc:
            logger.info("Playwright browser launch failed: %s", exc)
            logger.info("Run `playwright install` to download the browser runtime.")
            return ""
        context = browser.new_context(user_agent=DEFAULT_USER_AGENT)
        page = context.new_page()
        nav_timeout = min(timeout, 30)
        page.set_default_navigation_timeout(nav_timeout * 1000)
        page.set_default_timeout(nav_timeout * 1000)
        page.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        try:
            page.goto(url, wait_until="domcontentloaded")
        except Exception as exc:
            logger.info("Playwright navigation failed: %s", exc)
        try:
            page.wait_for_function(
                "window.DATA && window.DATA.clientVars && window.DATA.clientVars.data",
                timeout=nav_timeout * 1000,
            )
        except Exception:
            pass
        try:
            page.wait_for_selector("#ssrBox [data-block-type]", timeout=nav_timeout * 1000)
        except Exception:
            pass
        page.wait_for_timeout(2000)
        try:
            for _ in range(8):
                metrics = page.evaluate("""
                () => {
                  const scroller = document.querySelector('.scrollbar-container') || document.scrollingElement || document.body;
                  return {
                    height: scroller ? scroller.scrollHeight : 0,
                    count: document.querySelectorAll('#ssrBox [data-block-type]').length
                  };
                }
                """)
                page.evaluate("""
                () => {
                  const scroller = document.querySelector('.scrollbar-container') || document.scrollingElement || document.body;
                  if (scroller) {
                    scroller.scrollTo(0, scroller.scrollHeight);
                  } else {
                    window.scrollTo(0, document.body.scrollHeight);
                  }
                }
                """)
                page.wait_for_timeout(900)
                new_metrics = page.evaluate("""
                () => {
                  const scroller = document.querySelector('.scrollbar-container') || document.scrollingElement || document.body;
                  return {
                    height: scroller ? scroller.scrollHeight : 0,
                    count: document.querySelectorAll('#ssrBox [data-block-type]').length
                  };
                }
                """)
                if new_metrics == metrics:
                    break
        except Exception as exc:
            logger.info("Playwright scroll failed: %s", exc)
        script = """
        () => {
          const extractFromClientVars = () => {
            const blockMap = window?.DATA?.clientVars?.data?.block_map;
            const blockSeq = window?.DATA?.clientVars?.data?.block_sequence || [];
            if (!blockMap) return '';
            const getRecordText = (block) => {
              const textObj = block?.data?.text?.initialAttributedTexts?.text;
              if (textObj && typeof textObj === 'object') {
                const parts = Object.keys(textObj)
                  .sort((a, b) => Number(a) - Number(b))
                  .map((k) => textObj[k]);
                return parts.join('').trim();
              }
              if (typeof textObj === 'string') return textObj.trim();
              return '';
            };
            const lines = [];
            const ids = blockSeq.length ? blockSeq : Object.keys(blockMap);
            for (const id of ids) {
              const block = blockMap[id];
              if (!block) continue;
              const type = (block?.data?.type || '').toLowerCase();
              const text = getRecordText(block);
              if (!text) continue;
              if (type.includes('heading') || type === 'title' || type === 'page') {
                lines.push(text);
                lines.push('');
              } else if (type.includes('bullet')) {
                lines.push(`- ${text}`);
              } else if (type.includes('ordered')) {
                lines.push(`1. ${text}`);
              } else {
                lines.push(text);
              }
            }
            return lines.join('\\n').trim();
          };

          const clientText = extractFromClientVars();
          if (clientText) return clientText;

          const container = document.querySelector('#ssrBox') || document.querySelector('.wiki-ssr-content-box');
          if (!container) return '';
          const blocks = Array.from(container.querySelectorAll('[data-block-type]'));
          if (!blocks.length) return container.innerText || '';
          const lines = [];
          const blockText = (block) => {
            const lineNodes = Array.from(block.querySelectorAll('.ace-line'));
            if (lineNodes.length) {
              return lineNodes.map((line) => {
                const spans = Array.from(line.querySelectorAll('span[data-string="true"]'));
                if (spans.length) {
                  return spans.map(s => (s.textContent || '').trim()).join('');
                }
                return (line.textContent || '').trim();
              }).filter(Boolean).join('\\n');
            }
            const spans = Array.from(block.querySelectorAll('span[data-string="true"]'));
            if (spans.length) {
              return spans.map(s => (s.textContent || '').trim()).join('');
            }
            return (block.innerText || block.textContent || '').trim();
          };
          for (const block of blocks) {
            const type = (block.getAttribute('data-block-type') || '').toLowerCase();
            const text = blockText(block);
            if (!text) continue;
            if (type.includes('heading')) {
              lines.push(text);
              lines.push('');
            } else if (type.includes('bullet')) {
              lines.push(`- ${text}`);
            } else if (type.includes('ordered')) {
              lines.push(`1. ${text}`);
            } else {
              lines.push(text);
            }
          }
          return lines.join('\\n').trim();
        }
        """
        try:
            text = page.evaluate(script)
        finally:
            context.close()
            browser.close()
        return text or ""


def should_skip_download(output_dir: Path, token: str, title: str) -> bool:
    base = safe_filename(token or title)
    html_path = output_dir / f"{base}.html"
    text_path = output_dir / f"{base}.txt"
    return html_path.exists() and text_path.exists()


def load_urls(url: Optional[str], urls_file: Optional[str]) -> List[str]:
    urls: List[str] = []
    if url:
        urls.append(url)
    if urls_file:
        for line in Path(urls_file).read_text(encoding="utf-8").splitlines():
            cleaned = line.strip()
            if cleaned and not cleaned.startswith("#"):
                urls.append(cleaned)
    return urls


def process_url(
    raw_url: str,
    args: argparse.Namespace,
    cookie_value: Optional[str],
    output_dir: Path,
) -> None:
    url = normalize_url(raw_url)
    token = extract_token_from_url(url)

    if not args.force and should_skip_download(output_dir, token, token):
        logger.info("Skipping (already downloaded): %s", url)
        return

    try:
        html = fetch_html(url, cookie_value, args.timeout)
    except requests.RequestException as exc:
        logger.error("Failed to fetch URL %s: %s", url, exc)
        return

    soup = BeautifulSoup(html, "html.parser")
    title = extract_title(soup)
    if not args.force and should_skip_download(output_dir, token, title):
        logger.info("Skipping (already downloaded): %s", url)
        return

    content_text, json_data = extract_content(html)

    if not args.no_render:
        logger.info("Trying headless render extraction.")
        rendered = render_with_playwright(url, args.timeout)
        if len(rendered) > len(content_text):
            content_text = rendered
    if not content_text:
        logger.warning("No readable content found; saving raw HTML only.")

    write_outputs(output_dir, token, title, html, content_text or "", json_data)


def main() -> int:
    args = parse_args()

    try:
        cookie_value = read_cookie_value(args.cookie, args.cookie_file)
    except ValueError as exc:
        logger.error(str(exc))
        return 2

    urls = load_urls(args.url, args.urls_file)
    if not urls:
        logger.error("Provide a URL or --urls-file.")
        return 2

    output_dir = Path(args.output_dir)
    for raw_url in urls:
        process_url(raw_url, args, cookie_value, output_dir)

    logger.info("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
