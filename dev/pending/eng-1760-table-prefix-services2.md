## ENG-1760: shared TABLE_PREFIX in 15 more service modules (2026-10-21)

15 service modules now import TABLE_PREFIX from config/constants instead of defining it inline. Table names are unchanged for every NODE_ENV (same development to Dev- rule). The ratchet goes from 140 to 125.
