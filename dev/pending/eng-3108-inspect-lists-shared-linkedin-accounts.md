## ENG-3108: inspect_linkedin_account lists LinkedIn accounts a teammate shared with the organization (2026-11-16)

`inspect_linkedin_account` (`backend/src/emma/linkedInAccountRevokeTools.ts`) read only the
caller's own user record, while `list_connected_accounts` also returns accounts a teammate
shared with the organization. In the 2026-11-11 scheduled run the two tools returned five and
six LinkedIn accounts; the missing one was the account the run was sending from.

- Inspect now reads `getAccountsWithOwnerIncludingOrgShared`. A teammate's shared account is
  listed with two extra fields, `sharedByTeammate: true` and `revocableByCaller: false`. The
  caller's own entries are unchanged, so a caller with nothing shared gets the same result.
- Asking for a teammate's shared account by id returns `account` (that entry) and no error.
  Its queued actions are not read: they sit on the owner's schedules.
- An id the caller cannot reach at all keeps the existing "No LinkedIn Outreach account ... is
  connected to this user." text.
- `revoke_linkedin_account` is not changed and still reads the caller's own record only.
- No new sentences in the result or the tool description. Wording questions stay on ENG-3097.
