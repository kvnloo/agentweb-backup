## ENG-2565: Machine-engagement tripwire 5s threshold, ipAddress, Resend timestamp parse (2026-10-19)

- `SUSPECTED_MACHINE_GAP_MS` raised 2s -> 5s (ENG-325 min human gap 18.7s); `suspected_machine_engagement` log now carries `ipAddress`.
- `parseResendTimestamp` handles `YYYY-MM-DD HH:MM:SS.ffffff+00`; null on missing/garbage. Exit behavior unchanged.
