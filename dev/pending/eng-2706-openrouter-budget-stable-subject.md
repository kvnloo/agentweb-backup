## ENG-2706: Stable OpenRouter key-budget alert subject (2026-10-27)

The key-budget alert subject is now per threshold band (`past 80%` / `past 95%`) instead of embedding the live percentage, so the Linear oncall filer appends recurrences instead of filing a new issue per 1% step. Live % moved to message/context. Thresholds, spend, and limits unchanged.
