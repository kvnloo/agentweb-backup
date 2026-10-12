## ENG-2399: modify_work_plan schema/handler argument parity (2026-10-11)

- `modify_work_plan` schema and handler validation now share `MODIFY_WORK_PLAN_INPUT_SCHEMA` (backend/src/emma/impl/modifyWorkPlanArgs.ts). `steps` is optional (remove-only / autocomplete-only calls valid), step numbers are positive integers, and rejections return `{errorClass: invalid_args, field, expected}`. No persistence changes.
