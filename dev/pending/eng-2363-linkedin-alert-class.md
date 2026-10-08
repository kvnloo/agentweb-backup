## ENG-2363: LinkedIn disconnect oncall alerts carry a per-account Alert Class (2026-10-08)

First and reminder disconnect alerts now set `Alert Class: unipile-disconnected:<accountId>` so intake folds every occurrence onto one open canonical instead of filing a new issue per reminder. Owner email and 12h oncall dedupe unchanged.
