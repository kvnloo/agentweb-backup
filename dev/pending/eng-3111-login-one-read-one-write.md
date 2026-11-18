## ENG-3111: login makes one user read and one user write (2026-11-16)

`POST /api/auth/login` (`backend/src/controllers/auth.ts`) made three DynamoDB round trips in a
row: a query on `EmailIndex`, then, inside `userDb.updateUser`, a query on `UserIdIndex` to
recover the email the caller already held, then the update, which also asked for the whole
updated row back and discarded it.

- The read is now `userDb.getUserByEmailConsistent(email)`: a GetItem on the table's primary
  key. `EmailIndex` projects all attributes (checked on `AW-Users` and `Dev-AW-Users`), so the
  record has the same fields. The read is now strongly consistent; the index read was not.
- The last-login write is now `userDb.recordLogin(email, userId, { lastLoginTime, lastTouch? })`
  in `backend/src/services/db.ts`: one UpdateItem keyed by email, no read, no returned row. It
  writes the same two attributes as before.
- `recordLogin` carries the condition `userId = :userId`. An UpdateItem on a missing key creates
  the item, so without the condition a login racing an account deletion would leave a stub row.
  A failed condition is logged by `login` like any other failure of this write, and login still
  succeeds, as before.
- No table, index or stored field changed. `updateUser` and `getUserByEmail` are untouched and
  still used elsewhere.
- When the last-login write fails there is now one log line ("Error updating last login time")
  instead of two (the "DynamoDB updateUser error" line came from `updateUser`).
