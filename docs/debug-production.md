## Reproducing Production Issues in Dev

To safely investigate a production chat session without touching prod data, copy it to the dev DynamoDB tables and test against the dev/test environment.

### 1. Copy a production session to dev

```bash
cd backend
npx ts-node src/scripts/copy-session-to-dev.ts <prodSessionId> <devUserId>
```

- `<prodSessionId>` — the `sessionId` from production (`AW-ChatSessions`)
- `<devUserId>` — the user ID in dev that the session should be associated with (find this in the customer portal under Settings → Your Profile)

This copies both the session record and all messages (`AW-ChatMessages` → `Dev-AW-ChatMessages`), remapping `userId` to the dev user. The `sessionId` stays the same so URLs work directly in the test environment.

### 2. Test in the dev/test environment

Open the session in the test environment customer portal at `http://<test-env-ip>:5174/agent-mode/<sessionId>` and reproduce/debug the issue.

### 3. Clean up after testing

```bash
cd backend
npx ts-node src/scripts/delete-dev-session.ts <sessionId>
```

This deletes the session and all its messages from the dev tables.
