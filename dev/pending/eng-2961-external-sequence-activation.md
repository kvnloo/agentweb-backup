## ENG-2961: external sequence activation preview/confirm MCP actions (2026-11-12)

manage_crm_sequence gains external_activation_preview / external_activate_confirm for external MCP callers only, bound to the ENG-2958 digest (sequence version + approver). Stale/tampered/foreign/missing digest refused; activation uses the existing atomic guarded write. No schema changes.
