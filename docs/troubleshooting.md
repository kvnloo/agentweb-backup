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

### Voice Mode (Gemini Live) — Local Development

The Gemini Live API requires the browser microphone (`getUserMedia`), which browsers only allow on **secure contexts** (`https://` or `localhost`). When the customer portal runs on an EC2 IP (`http://54.x.x.x:5174`), the mic is blocked.

**Testing voice mode locally via SSH tunnel:**

1. SSH into the EC2 instance with port forwarding:
   ```bash
   ssh -L 5174:localhost:5174 -L 3001:localhost:3001 ec2-user@<EC2_PUBLIC_IP>
   ```
2. Open `http://localhost:5174` in your browser (not the EC2 IP).
   - `localhost` is treated as a secure context, so `getUserMedia` and `AudioContext` work.
3. Select **Gemini 3.1 Flash Live** as the model in Agent Mode.
4. Click **Start** — the voice session will connect.

**Why this works:** The SSH tunnel makes the browser connect to `localhost:5174`, which forwards to the EC2 instance. The browser sees `localhost` (secure context) and allows microphone access, while the actual socket connection reaches the EC2 backend transparently.

**Socket.IO transports:** The backend is configured with `transports: ['polling', 'websocket'], upgrade: false` to prevent WebSocket upgrade failures through the SSH tunnel. Do not change this — polling-first mode works reliably through tunnels.

**If "Start" button stops working after backend restart:**
- Hard-refresh the browser (`Ctrl+Shift+R`) to clear any stale socket connections
- The Gemini Live session is created fresh on each "Start" click — stale socket state from a previous session will cause `live:error: No active live session`

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
