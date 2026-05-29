#!/bin/bash
source ~/.bashrc
cd ~/agentweb

# Switch from Bedrock to Vertex AI (claude-opus-4-8)
unset CLAUDE_CODE_USE_BEDROCK
VERTEX_SA_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "agentweb/test-env/vertex-sa" \
  --region "${AWS_REGION:-us-west-2}" \
  --query SecretString --output text 2>/dev/null)
if [[ -n "$VERTEX_SA_JSON" ]]; then
  echo "$VERTEX_SA_JSON" > /tmp/vertex-sa.json
  chmod 600 /tmp/vertex-sa.json
  export GOOGLE_APPLICATION_CREDENTIALS=/tmp/vertex-sa.json
  export CLAUDE_CODE_USE_VERTEX=1
  export ANTHROPIC_VERTEX_PROJECT_ID="gen-lang-client-0725723168"
  export CLOUD_ML_REGION="global"
  # Record model label for heartbeat display
  grep -q '^claude_model=' ~/agentweb/.ec2-session-meta 2>/dev/null \
    && sed -i 's|^claude_model=.*|claude_model=Opus 4.8 (Google Vertex)|' ~/agentweb/.ec2-session-meta \
    || echo 'claude_model=Opus 4.8 (Google Vertex)' >> ~/agentweb/.ec2-session-meta
else
  grep -q '^claude_model=' ~/agentweb/.ec2-session-meta 2>/dev/null \
    && sed -i 's|^claude_model=.*|claude_model=Sonnet 4.6 (AWS Bedrock)|' ~/agentweb/.ec2-session-meta \
    || echo 'claude_model=Sonnet 4.6 (AWS Bedrock)' >> ~/agentweb/.ec2-session-meta
fi

NOTION_PAGE_ID=$(cat .notion-page-id 2>/dev/null)
NOTION_TOKEN=$(cat .notion-token 2>/dev/null)

# Post a crash comment and reset status to Blocked if the script exits before normal completion
_CLAUDE_COMPLETED=0
_crash_notify() {
  if [[ "$_CLAUDE_COMPLETED" == "0" && -n "$NOTION_PAGE_ID" && -n "$NOTION_TOKEN" ]]; then
    CRASH_BODY=$(python3 -c "
import json, sys
page_id = sys.argv[1]
body = {
  'parent': {'page_id': page_id},
  'rich_text': [{'type': 'text', 'text': {'content': 'Claude crashed or was killed before completing. No result was produced. Check the cloud instance logs.'}}]
}
print(json.dumps(body))
" "$NOTION_PAGE_ID" 2>/dev/null)
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

RAW=$(claude --model claude-opus-4-8 --permission-mode auto --output-format json -p "$(cat .claude-prompt)" 2>&1)
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

_CLAUDE_COMPLETED=1
if [[ -n "$NOTION_PAGE_ID" && -n "$NOTION_TOKEN" ]]; then
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
  if [[ -n "$BODY" ]]; then
    curl -s -X POST "https://api.notion.com/v1/comments" \
      -H "Authorization: Bearer $NOTION_TOKEN" \
      -H "Notion-Version: 2022-06-28" \
      -H "Content-Type: application/json" \
      -d "$BODY"
  fi
  rm -f /tmp/.claude-raw.json /tmp/.claude-comment.json
  # Set status to In Review after work is done
  curl -s -X PATCH "https://api.notion.com/v1/pages/${NOTION_PAGE_ID}" \
    -H "Authorization: Bearer $NOTION_TOKEN" \
    -H "Notion-Version: 2022-06-28" \
    -H "Content-Type: application/json" \
    -d '{"properties": {"Status": {"status": {"name": "In Review"}}}}' > /dev/null
fi
exec bash
