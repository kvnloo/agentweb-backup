#!/bin/bash
source ~/.bashrc
cd ~/agentweb

# Determine coding model from .coding-model (written from Notion "Coding Model" property).
# Empty/unset → default Opus 4.8 via Bedrock. "gpt-5.5" → Codex via Azure OpenAI.
CODING_MODEL=$(cat .coding-model 2>/dev/null | tr -d '[:space:]')
[[ -z "$CODING_MODEL" || "$CODING_MODEL" == "null" ]] && CODING_MODEL=""

if [[ "$CODING_MODEL" == "gpt-5.5" ]]; then
  MODEL_DISPLAY="GPT-5.5 (Azure OpenAI)"
  USE_CODEX=1
else
  MODEL_DISPLAY="Opus 4.8 (AWS Bedrock)"
  USE_CODEX=0
fi

grep -q '^claude_model=' ~/agentweb/.ec2-session-meta 2>/dev/null \
  && sed -i "s|^claude_model=.*|claude_model=$MODEL_DISPLAY|" ~/agentweb/.ec2-session-meta \
  || echo "claude_model=$MODEL_DISPLAY" >> ~/agentweb/.ec2-session-meta

NOTION_PAGE_ID=$(cat .notion-page-id 2>/dev/null)
NOTION_TOKEN=$(cat .notion-token 2>/dev/null)

# Post a crash comment and reset status to Blocked if the script exits before normal completion
_CLAUDE_COMPLETED=0
_crash_notify() {
  if [[ "$_CLAUDE_COMPLETED" == "0" && -n "$NOTION_PAGE_ID" && -n "$NOTION_TOKEN" ]]; then
    AGENT_NAME=$([[ "$USE_CODEX" == "1" ]] && echo "Codex" || echo "Claude")
    CRASH_BODY=$(python3 -c "
import json, sys
page_id = sys.argv[1]
agent = sys.argv[2]
body = {
  'parent': {'page_id': page_id},
  'rich_text': [{'type': 'text', 'text': {'content': f'{agent} crashed or was killed before completing. No result was produced. Check the cloud instance logs.'}}]
}
print(json.dumps(body))
" "$NOTION_PAGE_ID" "$AGENT_NAME" 2>/dev/null)
    [[ -n "$CRASH_BODY" ]] && curl -s -X POST "https://api.notion.com/v1/comments" \
      -H "Authorization: Bearer $NOTION_TOKEN" \
      -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" \
      -d "$CRASH_BODY" > /dev/null
    curl -s -X PATCH "https://api.notion.com/v1/pages/${NOTION_PAGE_ID}" \
      -H "Authorization: Bearer $NOTION_TOKEN" \
      -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" \
      -d '{"properties": {"Status": {"status": {"name": "Blocked"}}}}' > /dev/null
  fi
}
trap '_crash_notify' EXIT

# Set status to In progress before starting work
if [[ -n "$NOTION_PAGE_ID" && -n "$NOTION_TOKEN" ]]; then
  curl -s -X PATCH "https://api.notion.com/v1/pages/${NOTION_PAGE_ID}" \
    -H "Authorization: Bearer $NOTION_TOKEN" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d '{"properties": {"Status": {"status": {"name": "In progress"}}}}' > /dev/null
fi

if [[ "$USE_CODEX" == "1" ]]; then
  # Use aider via Azure OpenAI. AZURE_OPENAI_API_KEY / AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_VERSION
  # are exported from ~/.bashrc (sourced above) via the backend-env secret.
  # gpt-5.5 rejects temperature=0; the model settings file at ~/.aider.model.settings.yml sets temperature=1.
  RAW=$(AZURE_API_KEY="$AZURE_OPENAI_API_KEY" \
        AZURE_API_BASE="$AZURE_OPENAI_ENDPOINT" \
        AZURE_API_VERSION="$AZURE_OPENAI_API_VERSION" \
        aider \
          --model azure/gpt-5.5 \
          --yes-always \
          --map-tokens 0 \
          --no-check-update \
          --message "$(cat .claude-prompt)" 2>&1)
  EXIT_CODE=$?
else
  # Use Claude Opus 4.8 via AWS Bedrock. CLAUDE_CODE_USE_BEDROCK=1 and AWS_BEARER_TOKEN_BEDROCK
  # are exported from ~/.bashrc (sourced above) via the claude-code-env secret.
  RAW=$(claude --model us.anthropic.claude-opus-4-8 --permission-mode auto --output-format json -p "$(cat .claude-prompt)" 2>&1)
  EXIT_CODE=$?

  # Save session ID so the relay can resume the exact same session on follow-up prompts
  SESSION_ID=$(echo "$RAW" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
  if [[ -z "$SESSION_ID" ]]; then
    # Fall back to reading sessionId from the most recently modified JSONL
    SESSION_ID=$(ls -t ~/.claude/projects/-home-ec2-user-agentweb/*.jsonl 2>/dev/null | head -1 | xargs -I{} python3 -c "
import json
for line in open('{}'):
    try:
        d = json.loads(line.strip())
        if d.get('type') == 'last-prompt':
            print(d.get('sessionId', ''))
    except: pass
" 2>/dev/null | tail -1)
  fi
  [[ -n "$SESSION_ID" ]] && echo "$SESSION_ID" > ~/agentweb/.claude-session-id
fi

_CLAUDE_COMPLETED=1
if [[ -n "$NOTION_PAGE_ID" && -n "$NOTION_TOKEN" ]]; then
  if [[ "$USE_CODEX" == "1" ]]; then
    # Codex outputs plain text — post it directly without JSON parsing
    printf '%s' "$RAW" > /tmp/.codex-raw.txt
    BODY=$(python3 -c "
import json, sys
page_id = sys.argv[1]
exit_code = int(sys.argv[2])
try:
    raw = open('/tmp/.codex-raw.txt').read()
except Exception:
    raw = ''
if not raw.strip():
    raw = '(no output)'
if exit_code != 0:
    raw = f'Codex exited with code {exit_code}:\n{raw}'
if len(raw) > 9900:
    raw = raw[:9900] + '\n\n...(truncated)'
chunks = [{'text': {'content': raw[i:i+1900]}} for i in range(0, len(raw), 1900)]
if not chunks:
    chunks = [{'text': {'content': '(no output)'}}]
print(json.dumps({'parent': {'page_id': page_id}, 'rich_text': chunks}))
" "$NOTION_PAGE_ID" "$EXIT_CODE" 2>/dev/null)
    rm -f /tmp/.codex-raw.txt
  else
    # Claude outputs JSON — parse it via claude-comment.py for cost/token stats
    printf '%s' "$RAW" > /tmp/.claude-raw.json
    python3 ~/agentweb/.claude-comment.py "$NOTION_PAGE_ID" "$EXIT_CODE" > /tmp/.claude-comment.json
    BODY=$(cat /tmp/.claude-comment.json)
    if [[ -z "$BODY" ]]; then
      # claude-comment.py produced nothing (e.g. RAW was truncated/empty) — post a fallback
      BODY=$(python3 -c "
import json, sys
page_id = sys.argv[1]
exit_code = sys.argv[2]
msg = f'Claude exited (code {exit_code}) but produced no parseable output. The run may have been truncated or produced no result. Check the cloud instance logs.'
body = {'parent': {'page_id': page_id}, 'rich_text': [{'type': 'text', 'text': {'content': msg}}]}
print(json.dumps(body))
" "$NOTION_PAGE_ID" "$EXIT_CODE" 2>/dev/null)
    fi
    rm -f /tmp/.claude-raw.json /tmp/.claude-comment.json
  fi
  if [[ -n "$BODY" ]]; then
    curl -s -X POST "https://api.notion.com/v1/comments" \
      -H "Authorization: Bearer $NOTION_TOKEN" \
      -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" \
      -d "$BODY"
  fi
  # Set status to In Review after work is done
  curl -s -X PATCH "https://api.notion.com/v1/pages/${NOTION_PAGE_ID}" \
    -H "Authorization: Bearer $NOTION_TOKEN" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d '{"properties": {"Status": {"status": {"name": "In Review"}}}}' > /dev/null
fi
exec bash
