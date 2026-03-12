# Lessons Learned - AgentWeb

This file captures patterns and mistakes to avoid. Updated after corrections from users to prevent repeat errors.

## Pattern Recognition

### Authentication & Token Handling
- **Lesson:** Never use `localStorage.getItem("token")` directly in frontend code
  - **Why:** Doesn't work with delegation (delegated tokens stored in sessionStorage)
  - **Fix:** Always use `const { token } = useAuth()` from context
  - **Date:** Documented in CLAUDE.md

### Test Environment Workflow
- **Lesson:** Always sync after code changes when test environment is active
  - **Why:** No automatic file watcher - changes must be explicitly deployed
  - **Fix:** Run `./test-env/test-env.sh sync [service]` after each change
  - **Date:** Documented in CLAUDE.md

### TypeScript Compilation
- **Lesson:** Run `npx tsc` after EVERY backend file edit, including tests
  - **Why:** Type errors not caught during hot reload; prevents CI failures
  - **Fix:** Don't batch - verify compilation after each file change
  - **Date:** Documented in CLAUDE.md

### Working Directory Isolation
- **Lesson:** Never hardcode paths like `/Users/user/path/agentweb/`
  - **Why:** User has multiple clones; hardcoded paths silently edit wrong files
  - **Fix:** Always use working directory from `<env>` context
  - **Date:** Documented in CLAUDE.md

## Testing Patterns

### Backend Service Tests
- **Lesson:** Mock AWS services (DynamoDB, S3, Secrets Manager) in unit tests
  - **Why:** Tests must run without AWS credentials or network access
  - **Fix:** Use Jest mocks for `aws-sdk` calls
  - **Example:** See `backend/src/__tests__/agentModeService.*.test.ts`

### Coverage Requirements
- **Lesson:** CI requires ≥95% coverage on statements, branches, functions, lines
  - **Why:** Enforced by Jest config and CI pipeline
  - **Fix:** Ensure all new code paths have test coverage before committing

## Deployment Patterns

### Build Naming
- **Lesson:** Deployments triggered by file changes, not version bumps
  - **Why:** GitHub Actions uses path filters to detect changes
  - **Fix:** No need to update package.json versions for deployment

### Elastic Beanstalk Logs
- **Lesson:** EB logs rotate frequently - use DynamoDB for investigation
  - **Why:** Session state in AW-ChatSessions table persists longer
  - **Fix:** Query by sessionId to get messages, errors, work plan status

### Portal Distinction
- **Lesson:** partner-portal is admin-only; customer-portal is for ALL user-facing features
  - **Why:** Put social posts page in partner-portal instead of customer-portal — had to revert
  - **Fix:** Always use customer-portal for end-user pages (tasks, chat, marketing, social posts, settings)
  - **Date:** 2026-03-11

### Adding New Customer Portal Pages
- **Lesson:** `customerPortalPages.ts` exists in TWO places — both must be updated
  - **Why:** Forgot backend copy; admin subscription UI didn't show the new page
  - **Fix:** Update both `backend/src/services/customerPortalPages.ts` AND `customer-portal/src/services/customerPortalPages.ts`
  - **Also:** `customer-portal/src/App.tsx` (route), `customer-portal/src/utils/pageTitles.ts` (title)
  - **Date:** 2026-03-11

## Code Patterns

### DynamoDB Queries
- **Lesson:** Use GSI queries instead of scans
  - **Why:** Scans are slow and expensive on large tables
  - **Fix:** Create GSIs for common query patterns (status+time, userId, etc.)

### Commit Granularity
- **Lesson:** Each commit should cover one logical change
  - **Why:** Makes git history clear and reviewable
  - **Fix:** Separate commits for: bug fix, feature, tests, release notes, docs

---

**Note:** Add new lessons to this file after ANY correction from users. Include:
- What went wrong
- Why it happened
- How to prevent it
- Example or reference
