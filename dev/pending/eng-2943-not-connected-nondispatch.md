## ENG-2943: Never-connected integration errors no longer file oncall rows (2026-11-11)

Agent failure rule set reclassifies "No <X> account connected" tool failures as non-dispatchable `not_connected`; genuine connected-account auth failures stay `config`.
