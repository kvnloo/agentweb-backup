#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# generate-testing-plan.sh — Analyze a PR diff and produce a testing plan
#
# Usage:
#   ./scripts/generate-testing-plan.sh <base_branch> [<head_branch>]
#
# Outputs a markdown testing plan to stdout based on changed files.
# Compatible with bash 3.x (macOS default) and bash 4+.
###############################################################################

BASE_BRANCH="${1:-main}"
HEAD_BRANCH="${2:-HEAD}"

# Get changed files
CHANGED_FILES=$(git diff --name-only "$BASE_BRANCH...$HEAD_BRANCH" 2>/dev/null || git diff --name-only "$BASE_BRANCH" "$HEAD_BRANCH" 2>/dev/null || echo "")

if [ -z "$CHANGED_FILES" ]; then
  echo "No changed files detected between $BASE_BRANCH and $HEAD_BRANCH"
  exit 0
fi

# --- Classify changed files ---
BACKEND_CHANGES=""
FRONTEND_CHANGES=""
TEST_CHANGES=""
CONFIG_CHANGES=""
AFFECTED_FEATURES=""

add_feature() {
  local feat="$1"
  # Deduplicate
  if ! echo "$AFFECTED_FEATURES" | grep -qF "$feat"; then
    if [ -n "$AFFECTED_FEATURES" ]; then
      AFFECTED_FEATURES="$AFFECTED_FEATURES
$feat"
    else
      AFFECTED_FEATURES="$feat"
    fi
  fi
}

while IFS= read -r file; do
  [ -z "$file" ] && continue

  # Classify by type
  case "$file" in
    *__tests__/*|*.test.*|*.spec.*) TEST_CHANGES="${TEST_CHANGES}${file}"$'\n' ;;
    backend/src/*) BACKEND_CHANGES="${BACKEND_CHANGES}${file}"$'\n' ;;
    customer-portal/src/*|partner-portal/src/*) FRONTEND_CHANGES="${FRONTEND_CHANGES}${file}"$'\n' ;;
    *.json|*.yml|*.yaml|*.env*|*.config*|Dockerfile*|docker-compose*) CONFIG_CHANGES="${CONFIG_CHANGES}${file}"$'\n' ;;
  esac

  # Map to feature areas
  case "$file" in
    *services/chatbotService*) add_feature "Agent Mode / Chat Sessions" ;;
    *services/agentModeService*) add_feature "Agent Mode / Chat AI" ;;
    *services/emailService*) add_feature "Email System" ;;
    *services/imageGeneration*) add_feature "Image Generation" ;;
    *services/linkedInService*) add_feature "LinkedIn Integration" ;;
    *services/slackService*) add_feature "Slack Integration" ;;
    *services/db.*) add_feature "Database Operations" ;;
    *services/gtmPlan*) add_feature "GTM Planning" ;;
    *routes/auth*) add_feature "Authentication" ;;
    *routes/tasks*) add_feature "Task Management" ;;
    *routes/agentMode*) add_feature "Agent Mode API" ;;
    *routes/chatbot*) add_feature "Emma Chatbot" ;;
    *routes/admin*) add_feature "Admin Dashboard" ;;
    *routes/schedules*) add_feature "Task Scheduling" ;;
    *routes/workflows*) add_feature "Workflows / Templates" ;;
    *routes/gtmPlan*) add_feature "GTM Planning" ;;
    *routes/seo*) add_feature "SEO Metrics" ;;
    *routes/crm*) add_feature "CRM / Leads" ;;
    *routes/blog*) add_feature "Blog Publishing" ;;
    *routes/connectedAccounts*) add_feature "Connected Accounts" ;;
    *routes/linkedinAuth*) add_feature "LinkedIn OAuth" ;;
    *routes/slack*) add_feature "Slack Webhooks" ;;
    *middleware/*) add_feature "Middleware / Auth" ;;
    customer-portal/src/pages/*) add_feature "Customer Portal Pages" ;;
    customer-portal/src/components/*) add_feature "Customer Portal Components" ;;
    partner-portal/src/*) add_feature "Partner Portal" ;;
    agent-engine/*) add_feature "Agent Engine (Python)" ;;
    test-env/*) add_feature "Test Environment Infrastructure" ;;
  esac
done <<< "$CHANGED_FILES"

# Get stats
DIFF_STATS=$(git diff --stat "$BASE_BRANCH...$HEAD_BRANCH" 2>/dev/null | tail -1 || echo "unknown changes")
COMMIT_MSGS=$(git log --oneline "$BASE_BRANCH...$HEAD_BRANCH" 2>/dev/null || echo "")

# --- Output the testing plan ---

cat <<'HEADER'
## 🧪 Testing Plan

> Auto-generated from PR diff analysis. Verify each item before approving.

HEADER

echo "### Summary"
echo ""
echo "- **Changes**: $DIFF_STATS"
echo "- **Affected areas**: $(echo "$AFFECTED_FEATURES" | tr '\n' ', ' | sed 's/,$//' | sed 's/,/, /g')"
echo ""

if [ -n "$COMMIT_MSGS" ]; then
  echo "### Commits"
  echo '```'
  echo "$COMMIT_MSGS"
  echo '```'
  echo ""
fi

echo "### Changed Files"
echo ""
print_file_list() {
  local label="$1"
  local files="$2"
  if [ -n "$files" ]; then
    echo "**${label}:**"
    echo "$files" | sed '/^$/d' | while IFS= read -r f; do
      echo "- \`$f\`"
    done
    echo ""
  fi
}

print_file_list "Backend" "$BACKEND_CHANGES"
print_file_list "Frontend" "$FRONTEND_CHANGES"
print_file_list "Tests" "$TEST_CHANGES"
print_file_list "Config/Infra" "$CONFIG_CHANGES"

# --- Feature-specific testing steps ---
echo "### Manual Verification Checklist"
echo ""

generate_steps() {
  local feature="$1"
  echo "#### $feature"
  echo ""

  case "$feature" in
    "Agent Mode / Chat Sessions")
      cat <<'EOF'
- [ ] Open Agent Mode in the customer portal
- [ ] Verify chat history sidebar loads all sessions (not just last 4-10)
- [ ] Scroll down in the sidebar — infinite scroll should load more
- [ ] Click an older session — messages should load correctly
- [ ] Create a new chat session — it should appear at the top
- [ ] Verify no duplicate sessions appear
- [ ] Check that archived sessions remain hidden
EOF
      ;;
    "Agent Mode / Chat AI")
      cat <<'EOF'
- [ ] Start a new Agent Mode conversation
- [ ] Verify AI responses stream correctly
- [ ] Test function calling (e.g., ask agent to perform a task)
- [ ] Verify conversation context is maintained across messages
- [ ] Check error handling for failed AI responses
EOF
      ;;
    "Agent Mode API")
      cat <<'EOF'
- [ ] Verify Agent Mode API endpoints respond correctly
- [ ] Test session creation, listing, and deletion via API
- [ ] Verify WebSocket/SSE streaming works
EOF
      ;;
    "Authentication")
      cat <<'EOF'
- [ ] Test login with email/password
- [ ] Test Google OAuth login
- [ ] Test delegation access (admin → customer)
- [ ] Verify token refresh works
- [ ] Test logout clears session
EOF
      ;;
    "Task Management")
      cat <<'EOF'
- [ ] Create a new task
- [ ] Edit an existing task
- [ ] Execute a task and verify status updates
- [ ] Check task history displays correctly
- [ ] Verify task scheduling works
EOF
      ;;
    "Email System")
      cat <<'EOF'
- [ ] Send a test email
- [ ] Verify email tracking events are recorded
- [ ] Check email template rendering
- [ ] Test bounce/complaint handling
EOF
      ;;
    "LinkedIn Integration"|"LinkedIn OAuth")
      cat <<'EOF'
- [ ] Test LinkedIn profile connection flow
- [ ] Verify LinkedIn post creation
- [ ] Check LinkedIn preview rendering
- [ ] Test disconnect/reconnect flow
EOF
      ;;
    "Customer Portal Pages"|"Customer Portal Components")
      cat <<'EOF'
- [ ] Navigate to each affected page — verify it loads without errors
- [ ] Check responsive layout (desktop + mobile viewport)
- [ ] Verify all interactive elements work (buttons, forms, modals)
- [ ] Check browser console for JavaScript errors
- [ ] Test page navigation (back/forward, direct URL access)
EOF
      ;;
    "Partner Portal")
      cat <<'EOF'
- [ ] Login to partner portal
- [ ] Verify affected admin pages load correctly
- [ ] Test any changed admin operations
- [ ] Check console for errors
EOF
      ;;
    "Database Operations")
      cat <<'EOF'
- [ ] Verify data reads return expected results
- [ ] Test data writes persist correctly
- [ ] Check pagination works for large datasets
- [ ] Verify index queries return correct results
EOF
      ;;
    "Slack Integration"|"Slack Webhooks")
      cat <<'EOF'
- [ ] Test Slack notification delivery
- [ ] Verify approval buttons work in Slack messages
- [ ] Check Slack channel listing
EOF
      ;;
    "GTM Planning")
      cat <<'EOF'
- [ ] Create/view a GTM plan
- [ ] Test approval workflow
- [ ] Verify notification delivery
EOF
      ;;
    "Emma Chatbot")
      cat <<'EOF'
- [ ] Open the Emma chatbot widget
- [ ] Ask a question and verify response
- [ ] Check context awareness (page-specific answers)
- [ ] Test session history
EOF
      ;;
    "SEO Metrics")
      cat <<'EOF'
- [ ] Open SEO dashboard
- [ ] Verify Google Search Console data loads
- [ ] Check Analytics integration
EOF
      ;;
    "Blog Publishing")
      cat <<'EOF'
- [ ] Create/edit a blog post
- [ ] Test publishing to CMS (Webflow/BaseHub)
- [ ] Verify content preview
EOF
      ;;
    "Image Generation")
      cat <<'EOF'
- [ ] Trigger image generation
- [ ] Verify generated images display correctly
- [ ] Test different generation providers
EOF
      ;;
    "Task Scheduling")
      cat <<'EOF'
- [ ] Create a scheduled task
- [ ] Verify schedule displays correctly
- [ ] Edit/delete a schedule
- [ ] Check next run time calculation
EOF
      ;;
    "Middleware / Auth")
      cat <<'EOF'
- [ ] Verify authenticated requests work
- [ ] Test unauthenticated requests are rejected
- [ ] Check delegation token handling
- [ ] Verify admin-only endpoints are protected
EOF
      ;;
    *)
      echo "- [ ] Verify $feature functionality works as expected"
      echo "- [ ] Check for regressions in related features"
      echo "- [ ] Verify error handling for edge cases"
      ;;
  esac
  echo ""
}

if [ -n "$AFFECTED_FEATURES" ]; then
  while IFS= read -r feature; do
    [ -n "$feature" ] && generate_steps "$feature"
  done <<< "$AFFECTED_FEATURES"
fi

# Regression checks
echo "### Regression Checks"
echo ""
cat <<'EOF'
- [ ] Backend health endpoint responds: `GET /api/health`
- [ ] Login flow works end-to-end
- [ ] Navigation between portal pages works
- [ ] No console errors on page load
EOF
echo ""

# API verification
if [ -n "$BACKEND_CHANGES" ]; then
  echo "### API Verification"
  echo ""
  echo "Check backend logs for errors after testing:"
  echo '```bash'
  echo './test-env/test-env.sh logs backend'
  echo '```'
  echo ""
fi

echo "---"
echo "*Generated at $(date -u '+%Y-%m-%d %H:%M UTC') from diff \`$BASE_BRANCH...$HEAD_BRANCH\`*"
