## ENG-3133: weekly Zoma email bars no longer collapse in Gmail's Android app (2026-11-18)

- **Bug (seen on a real phone):** in Gmail's Android app the daily-spend bars and the per-campaign bars drew as thin
  lines. Heights were right but the app ignores `width` attributes on these tables, so every bar's width collapsed.
  A desktop browser honours the attributes, which is why the first renders looked fine.
- **Fix:** each bar is one table cell that carries its size in CSS (`width`/`height` in px, plus the attributes for
  Outlook) and a spacer `div` of the same width that holds the cell open. No bar depends on a width attribute or a
  percentage any more. Daily bars are 36px wide in 40px columns (7 x 40 = 280px, fits a 320dp phone body); campaign bars
  are pixel lengths up to 250px.
- **Proof it does not rely on the attributes:** a unit test strips every `width` attribute from the generated HTML and
  asserts every one of the 17 sample bars still defines its width in CSS with a spacer; a second test pins the
  size limits. The sample was also rendered with the attributes stripped at 360px.
- No behaviour change: the weekly email is still off (`ZOMA_WEEKLY_REPORT_ENABLED` unset).
