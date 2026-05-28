import json, sys, os, time

COST_FILE = os.path.expanduser("~/agentweb/.claude-total-cost")
META_FILE = os.path.expanduser("~/agentweb/.ec2-session-meta")

EC2_PRICES = {
    "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416,
    "t3.large": 0.0832, "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328,
}

with open("/tmp/.claude-raw.json", "r", errors="replace") as f:
    raw = f.read()

try:
    data = json.loads(raw)
    text = data.get("result", raw)
    cost = data.get("total_cost_usd", 0)
    usage = data.get("usage", {})
    duration_ms = data.get("duration_ms", 0)
    input_tok = usage.get("input_tokens", 0)
    output_tok = usage.get("output_tokens", 0)
    cache_read = usage.get("cache_read_input_tokens", 0)
    cache_create = usage.get("cache_creation_input_tokens", 0)

    # Read previous total and accumulate
    prev_total = 0
    try:
        with open(COST_FILE, "r") as cf:
            prev_total = float(cf.read().strip())
    except Exception:
        pass
    total = prev_total + cost
    try:
        with open(COST_FILE, "w") as cf:
            cf.write(f"{total:.6f}")
    except Exception:
        pass

    parts = []
    parts.append(f"Cost: ${cost:.4f} (Total: ${total:.4f})")
    cache_parts = []
    if cache_read:
        cache_parts.append(f"{cache_read:,} cache-read")
    if cache_create:
        cache_parts.append(f"{cache_create:,} cache-write")
    tok_detail = f"{input_tok:,} in + {output_tok:,} out"
    if cache_parts:
        tok_detail += " (" + ", ".join(cache_parts) + ")"
    parts.append(f"Tokens: {tok_detail}")
    if duration_ms:
        parts.append(f"Duration: {duration_ms / 1000:.0f}s")
    models = list(data.get("modelUsage", {}).keys())
    if models:
        parts.append("Model: " + ", ".join(models))

    # EC2 cost (hardcoded price table)
    try:
        meta = {}
        with open(META_FILE) as mf:
            for line in mf:
                k, _, v = line.strip().partition("=")
                if k:
                    meta[k] = v
        itype = meta.get("instance_type", "")
        launch_epoch = int(meta.get("launch_epoch", 0))
        if itype and launch_epoch:
            elapsed_h = (time.time() - launch_epoch) / 3600
            ec2_cost = elapsed_h * EC2_PRICES.get(itype, 0)
            h = int(elapsed_h)
            m = int((elapsed_h - h) * 60)
            parts.append(f"EC2: ${ec2_cost:.4f} ({h}h {m}m @ {itype})")
    except Exception:
        pass

    usage_line = " | ".join(parts)
except Exception:
    text = raw
    usage_line = ""

exit_code = int(sys.argv[2])
if exit_code != 0:
    text = f"Claude Code exited with code {exit_code}:\n{text}"

if usage_line:
    text += f"\n\n---\n{usage_line}"

if len(text) > 9900:
    text = text[:9900] + "\n\n...(truncated)"
chunks = [{"text": {"content": text[i:i+1900]}} for i in range(0, len(text), 1900)]
if not chunks:
    chunks = [{"text": {"content": "(no output)"}}]
print(json.dumps({"parent": {"page_id": sys.argv[1]}, "rich_text": chunks}))
