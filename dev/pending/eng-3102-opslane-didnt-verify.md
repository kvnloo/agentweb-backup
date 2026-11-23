## ENG-3102: merge-evidence.sh treats Opslane "didn't verify this commit" as an abstention (2026-11-16)

- `.github/scripts/merge-evidence.sh` pass 4: the closed list of Opslane `neutral` abstention titles gains a fourth entry, "Opslane didn't verify this commit". Opslane posts it when it did not run on a head at all (a daily limit, the plan, or a setup change) and says the check does not block. Before, that title failed the gate, and the check-run cannot be re-requested, so only a new push could clear it (#4134).
- The match is still app slug + check name + `neutral` + exact title. An Opslane `failure`, or a `neutral` with any other title, still blocks. A dropped run is not counted as evidence.
- Consequence: a head can now pass the gate with no Opslane run on it. To undo, remove the title from `OPSLANE_NOOP_TITLES`.
- Tests: four cases in `.github/scripts/merge-evidence.test.sh` built from the #4134 check-run.
