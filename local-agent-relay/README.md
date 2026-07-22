# local-agent-relay

Bridges AgentWeb's Emma assistant to a **Codex agent running on your local computer**. Emma can ask the local agent to load web pages (using your existing browser sessions/cookies), extract data, and perform multi-step automation — then return the results to the conversation.

Also supports an email channel (IMAP/SMTP) for running Codex jobs remotely.

## Quick Start — HTTP Server (for Emma integration)

```bash
cd local-agent-relay
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

Start the HTTP relay server:

```bash
# Pick a secret token for authentication
codex-relay serve --secret YOUR_SECRET --cwd ~/Documents/GitHub/your-repo
```

Expose it via ngrok so AgentWeb can reach it:

```bash
ngrok http 8080
# Copy the https://xxxx.ngrok-free.app URL
```

Save the relay URL + secret in AgentWeb:
1. Open Settings > Integrations (or ask Emma: "save my local agent relay")
2. App name: `local-agent-relay`
3. URL (username field): `https://xxxx.ngrok-free.app`
4. Secret (password field): `YOUR_SECRET`

Now Emma can run tasks on your local machine:
> "Go to linkedin.com and extract the company info for Anthropic"
> "Check my local HubSpot dashboard and summarize today's leads"

### Serve Options

```bash
codex-relay serve \
  --secret YOUR_SECRET \        # Bearer token for auth (also: RELAY_SECRET env var)
  --port 8080 \                 # Port to listen on (default: 8080)
  --cwd ~/Documents/my-repo \   # Default working directory for Codex
  --sandbox workspace-write \   # Codex sandbox mode
  --timeout 300 \               # Default task timeout in seconds
  --no-browser                  # Disable browser pre-loading
```

Test the server:

```bash
# Health check
curl http://localhost:8080/health

# Run a task
curl -X POST http://localhost:8080/task \
  -H "Authorization: Bearer YOUR_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"task": "load linkedin.com and return the page title"}'
```

## Quick Start — CLI (direct local use)

Test the CLI without invoking Codex:

```bash
codex-relay run --dry-run -C ~/Documents/GitHub/your-repo "summarize this repo"
```

Run one real Codex task:

```bash
codex-relay run -C ~/Documents/GitHub/your-repo "inspect the test suite and report the first failing test"
```

You can also pipe a task through stdin:

```bash
printf 'summarize the current git diff' | codex-relay run -C ~/Documents/GitHub/your-repo -
```

## Continued Sessions

Use `--session` to keep talking to the same Codex session across CLI runs. The value can be a real Codex session id or a Codex thread title, matching `codex exec resume <session id or thread name>`.

Start a new session:

```bash
codex-relay run \
  --new-session \
  -C ~/Documents/GitHub/codex-relay \
  "open browser, load linkedin.com, and summarize the feed"
```

The output includes the real Codex session id. Use that id for follow-ups:

```bash
codex-relay run \
  --session 00000000-0000-0000-0000-000000000000 \
  -C ~/Documents/GitHub/codex-relay \
  "focus on the OpenAI post and extract the main announcement"
```

You can also resume by Codex thread title:

```bash
codex-relay run \
  --session "LinkedIn research" \
  -C ~/Documents/GitHub/codex-relay \
  "continue from that thread"
```

You can optionally attach a local alias to a Codex session id:

```bash
codex-relay run \
  --new-session \
  --session-alias linkedin \
  -C ~/Documents/GitHub/codex-relay \
  "start a LinkedIn research session"
```

Then continue by alias:

```bash
codex-relay run \
  --session-alias linkedin \
  -C ~/Documents/GitHub/codex-relay \
  "continue from the previous LinkedIn context"
```

## Browser Tasks

For prompts that mention opening or loading a URL, the relay pre-loads the page itself and passes the visible page text into Codex. By default this uses your existing logged-in Google Chrome session through macOS AppleScript.

Chrome blocks page reads from AppleScript unless this setting is enabled:

```text
Google Chrome > View > Developer > Allow JavaScript from Apple Events
```

Test browser loading directly:

```bash
codex-relay-browser open linkedin.com
```

If a site requires login, sign in with your normal Chrome first. The default `chrome` backend uses that existing browser session.

```bash
codex-relay run -C ~/Documents/GitHub/codex-relay "open browser, load linkedin.com, and give me a summary"
```

Use the Playwright backend with a separate profile directory when needed:

```bash
codex-relay run \
  --browser-backend playwright \
  --browser-profile-dir ~/.codex-relay/linkedin-profile \
  -C ~/Documents/GitHub/codex-relay \
  "open browser, load linkedin.com, and give me a summary"
```

Headless mode is available, but many logged-in or bot-sensitive sites are more reliable with the default visible browser.

```bash
codex-relay run --browser-headless -C ~/Documents/GitHub/codex-relay "load example.com and summarize it"
```

Generic browser actions are also available from the terminal. These operate on your existing Chrome session:

```bash
codex-relay-browser read
codex-relay-browser click --text "Like"
codex-relay-browser click --role button --name "Like" --index 1
codex-relay-browser click --selector "button[aria-label*='Like']"
codex-relay-browser type "hello world" --selector "textarea"
```

When prompting Codex through the relay, tell it to use these terminal commands for browser actions instead of Computer Use:

```bash
codex-relay run \
  --session 00000000-0000-0000-0000-000000000000 \
  -C ~/Documents/GitHub/codex-relay \
  "Use codex-relay-browser terminal commands for browser actions. Read the active LinkedIn page and click the first visible Like button. Do not use Computer Use."
```

Edit `config.toml`, then test the email relay without invoking Codex:

```bash
codex-relay poll-email --config config.toml --once --dry-run
```

Run the email relay continuously:

```bash
codex-relay poll-email --config config.toml
```

## Email Command Format

The relay accepts messages where either the subject or body starts with the configured prefix, defaulting to `codex:`.

Example subject:

```text
codex: inspect failing tests in agentweb
```

Example body:

```text
codex: In /path/to/agentweb, run the test suite and fix the first failure. Do not push.
```

## Safety Notes

Email is an untrusted input channel. Keep the default sandbox mode unless you intentionally need broader access, and do not point this at a shared inbox. Start with `dry_run = true` and a single allowlisted sender.

The relay is intentionally conservative:

- It only accepts allowlisted senders.
- It requires a command prefix.
- It runs one message at a time.
- It applies a process timeout.
- It defaults to Codex `workspace-write` sandboxing.

## Configuration

See `config.example.toml` for all supported options.

Environment variables can be used in config values with `${NAME}` syntax. This is recommended for passwords and app tokens.

## Development

```bash
python -m unittest
```

## Running a Dev Instance Alongside Prod

The prod relay runs from its own standalone repo (e.g. `~/local-agent-relay`). To run a dev instance with unreleased changes from the `agentweb` repo on the same machine:

**1. Copy the relay to a separate directory on the target machine:**

```bash
scp -r /path/to/agentweb/local-agent-relay user@host:~/agentweb-dev-relay
```

**2. On the target machine, create a venv using Python 3.11+:**

```bash
cd ~/agentweb-dev-relay
/opt/homebrew/bin/python3.11 -m venv .venv-dev
.venv-dev/bin/pip install --upgrade pip
.venv-dev/bin/pip install .
```

**3. Start on a different port (prod uses 8080, dev uses 8081):**

```bash
screen -dmS codex-relay-dev bash -c \
  '~/agentweb-dev-relay/.venv-dev/bin/codex-relay serve --port 8081 --secret YOUR_DEV_SECRET --cwd ~/agent-work --sandbox danger-full-access --binary /Applications/Codex.app/Contents/Resources/codex --extra-arg=--skip-git-repo-check 2>&1 | tee /tmp/codex-relay-dev.log'
```

> **Note:** `--extra-arg=--skip-git-repo-check` is required when the `--cwd` directory has no git commits yet. Use `=` to pass flags as extra args (not a space) so argparse doesn't misinterpret them.

**4. Expose via a second ngrok tunnel:**

```bash
ngrok http 8081
```

**5. Save the dev relay config in AWS Secrets Manager:**

```bash
aws secretsmanager put-secret-value \
  --secret-id dev/AgentWeb/LocalAgentRelay \
  --secret-string '{"endpoint":"https://<dev-ngrok-url>.ngrok-free.app","apiKey":"YOUR_DEV_SECRET"}'
```

The backend routes to `dev/AgentWeb/LocalAgentRelay` when `NODE_ENV != production` and to `prod/AgentWeb/LocalAgentRelay` in production, so the two instances are fully independent.

**To update the dev relay with new changes**, re-copy the changed files and restart the screen session:

```bash
scp /path/to/agentweb/local-agent-relay/src/codex_relay/*.py \
    user@host:~/agentweb-dev-relay/src/codex_relay/
ssh user@host "screen -S codex-relay-dev -X quit; \
  screen -dmS codex-relay-dev bash -c \
  '~/agentweb-dev-relay/.venv-dev/bin/codex-relay serve --port 8081 --secret YOUR_DEV_SECRET 2>&1 | tee /tmp/codex-relay-dev.log'"
```
