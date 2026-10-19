## ENG-2123: a phone-matched lead merge only fills blanks (2026-10-19)

A repeat capture matched to an existing lead by PHONE (the `on` lookup match and the concurrent-create race loser) now only FILLS blank fields on that lead. It never replaces a non-blank standard field (firstName, lastName, phone, company, title, notes, linkedin) or an existing non-blank custom-field key; absent and blank keys are filled. The attribution refresh (`lastTouch`) is unchanged. The EMAIL repeat path is unchanged and still overwrites with the newer non-empty value (guard test).

**Why.** Reproduced on the dev index: in `on`, a blank-name capture replaced a row's notes ("CURATED NOTES" became "FORM MESSAGE"), and a capture merged into a hand-entered, backfilled row overwrote its company and notes. Phone is a weaker identity than email (hand-entered rows are keyed by the backfill, a number is easy to know), and leads store no origin, so an eligibility guard cannot tell curated rows apart. Filling blanks only makes the worst outcome "a blank gets filled" instead of "a stored value is lost".

**Cost.** A repeat visit's new value for a field that is already filled is dropped (a multi-step lander that adds a company on step 2 still works, because the field was blank).

**Still true.** Anyone who knows a number can fill blank fields on that lead. Two merges racing over the same blank field are last-writer-wins (bounded: same person, same field, a blank at that moment). `on` should still only be enabled after reading the `shadow` name-conflict and shared-line counts.

**Also frozen by fill-blanks (review finding).** Custom keys that a lander re-answers on a later step (a `stage` or step answer) keep their first stored value on a phone-matched repeat; only absent or blank keys are filled. Check which keys real landers send before relying on phone merges for them. A hand-entered lead with no `source` gets `source: 'api'` written when the caller omits one (it fills a blank). A phone-matched repeat that carries attribution still reports `lead.updated` (the `lastTouch` refresh), exactly as the email path does.
