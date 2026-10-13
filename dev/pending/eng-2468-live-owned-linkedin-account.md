## ENG-2468: Resolve live user-owned LinkedIn account after reconnect (2026-10-13)

`resolveUserOwnedAccountId` returned the first Unipile row; a reconnect appends a new account_id, so CRM message sync/invites stayed pinned to the dead session (401 Disconnected account). Now probes and prefers a live account, then unknown, then first.
