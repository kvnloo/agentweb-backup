# Cycle 271 — one XFF empty-ARN string for `None` and classic; do not split

**Date:** 2026-09-12T12:20:00Z
**Question:** Mock `NONE` prints `None` (test L191–193);
classic prints a bare name (L796). Both fail
`grep '^arn:'` and hit the same empty-ARN `fail()`.
Should XFF use **one** empty-ARN string for `None` and
classic, rather than two?
**Answer:** **One string. Do not split.** After
`grep '^arn:' || true` (`eb-deploy.sh` L809) both
tokens are gone: `[ -z "${lb_arns}" ]` (L810) is the
only gate. Delay already uses **one** L811 sentence
for both. Probe UNKNOWN already uses **one** detail
(`L315`) for both (the classic comment is above the
string, not a second branch). Splitting would need a
**pre-grep** `None` vs name check — a fifth None-ish
policy (cycle 259). Cycle 267 already: one XFF
sentence, not L811. This cycle: that one sentence
covers both inputs. Missing `lb_arns` also prints
`None` (mock L196–198) — a third input on the same
path. Do **not** add that pin from A-019. Do not
un-park A-020. Do not 503 `/health`. Do not add A-021.

## Evidence

### After grep, `None` and classic are the same empty string

```191:198:.github/scripts/eb-deploy.test.sh
      if [ "$first" = "NONE" ]; then
        printf 'None\n'
        exit 0
      fi
      cat "${MOCK_DIR}/lb_arns"
    else
      printf 'None\n'
    fi
```

```809:811:.github/scripts/eb-deploy.sh
  lb_arns=$(printf '%s' "${lb_arns}" | tr '\t' '\n' | grep '^arn:' || true)
  if [ -z "${lb_arns}" ]; then
    fail "environment '${EB_ENVIRONMENT_NAME}' has no Application Load Balancer ARN; cannot set DeregistrationDelay via elbv2 (classic ELB is not supported by this path)."
```

`None` does not match `^arn:`. `awseb-e-classic-lb`
(test L796) does not match `^arn:`. A missing fixture
prints `None` and also does not match. Cycle 270:
Green + delay unset is the empty-ARN fixture; that
fixture still hits **this** `if`, not two `if`s.

To emit two XFF strings you would have to save the
pre-grep token and branch on `None` vs other. Delay
does not. Probe does not (one `EB_UNHEALTHY_DETAIL`).
Cycle 255 already: do not fork `grep '^arn:'`. A
post-grep split is that fork with extra strings.

Hermes / Oh My Pi: one registry, one dispatch miss
string. AgentWeb’s cutting-edge SDLC is in-process
503; a later XFF pin should keep delay’s **one**
empty-ARN `fail()` shape with an XFF sentence
(cycle 267), not a None-vs-classic enum.

## First-slice correction (A-019 stays ready; A-020 stays park)

Keep JSON 503 at POST `/mcp` like `runScheduledChats` L13032.
Add:

- Do **not** split XFF empty-ARN `fail()` into `None`
  vs classic strings (after grep both are empty).
- Delay L811 is already one string; copy that shape,
  not a second branch.
- Do **not** add that pin from A-019.

Ready status of Q-001 / Q-014 / Q-003 is not falsified. A-006
stays discarded.

## Relation to A-002 / A-007 / A-008

Unchanged. A-019 is still the architecture item after #2+#3.

## Next cycle

File-level only: delay L811’s parenthetical names
`classic ELB is not supported by this path`. Probe’s
operator string does **not** (`L315`). Should XFF’s
one empty-ARN string also name classic ELB, or stay
XFF / `modify-load-balancer-attributes` only? Copy
the classic clause into the XFF sentence without
copying “DeregistrationDelay.” Do not add that pin
from A-019. Do not un-park A-020. Do not 503
`/health`. Do not add A-021. Do not un-ready Q-001 /
Q-014 / Q-003. Do not revive A-006. Do not mint a timer
unless Kevin asks.
