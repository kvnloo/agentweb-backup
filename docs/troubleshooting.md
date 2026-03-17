## Common Troubleshooting

### Backend Issues

**Port 3001 already in use:**
```bash
lsof -ti:3001 | xargs kill -9
```

**Google OAuth redirect errors:**
- Check Google Cloud Console redirect URIs match exactly
- Verify `BACKEND_URL` environment variable
- For dev: `http://localhost:3001/api/auth/google/callback`
- For prod: `https://api.agentweb.pro/api/auth/google/callback`

**DynamoDB index missing errors:**
- Check if GSI exists: `aws dynamodb describe-table --table-name Dev-AW-TaskExecutions --region us-west-2`
- Create missing index using AWS CLI commands in `dev.md`

### Scheduled Chat Research Sessions

**LLM repeats previous output on retry instead of performing fresh research:**
- Check if `search_web` or other search tools are listed in the schedule's `requiredFunctionCalls` unnecessarily
- When search tools are required, `runVerifiedChat` retries until they're called, but the LLM sees its previous output in context and repeats it
- Fix: remove search tools from `requiredFunctionCalls` unless the schedule truly needs to enforce they are called a minimum number of times
- The LLM will still call search tools organically as part of its research flow

### Agent Engine Issues

**Memory system database errors (Azure OpenAI models):**
```bash
cd agent-engine
python memory_fix_v2.py
```

**Browser initialization failures:**
```bash
# Check VNC server (on Google Cloud VM)
ps aux | grep vnc
export DISPLAY=:1
vncserver -kill :1
tigervncserver :1 -geometry 1920x1080 -depth 24
```

**Module import errors:**
```bash
conda activate agent-engine
pip install -r requirements.txt
playwright install chromium
```
