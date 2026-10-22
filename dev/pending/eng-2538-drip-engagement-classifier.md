## ENG-2538: Pure drip engagement human/bot classifier (2026-10-18)

Added `backend/src/services/dripEngagementClassifier.ts`: pure `classifyEngagementEvent` (too_fast <10s, proxy_open for Apple MPP/Gmail image proxy opens, scanner_user_agent for SafeLinks/Barracuda/Proofpoint/Mimecast etc., click_burst >=3 distinct links in 2s) and `shouldExitSequence` using only human events. Not yet wired into the drip evaluator/worker.
