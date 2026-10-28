## ENG-87: Managed-campaign health signal evaluator (2026-10-28)

Pure `evaluateCampaignHealth`/`collectCampaignHealthSignals` in `backend/src/services/campaignHealthSignal.ts`: struggling (lead discrepancy, cost per lead, bad-lead rate) and win signals, deduped per campaign/window. Thresholds have no defaults; unset disables. Not yet wired to the eval-queue or alerts.
