# Benchmark V5 Results — Initial Baseline

**Date:** 2026-03-09
**Model:** `anthropic.claude-sonnet-4-6`
**Target:** EC2 test environment (`52.42.24.200:3001`)
**Total evaluations:** 45 (across 8 scenarios)
**Driver fix applied:** `{scenario_input}` variable + no `response_tool_calls_path`

## Summary

| Scenario | Evals | task | result | behavior | response | context | loop | toxicity |
|---|---|---|---|---|---|---|---|---|
| onboarding | 5 | 100% | 100% | 80% | 100% | 100% | 100% | 5.0 |
| content_creation | 8 | 33% | 67% | 83% | 83% | 33% | 100% | 5.0 |
| lead_management | 6 | 100% | 100% | 83% | 100% | 100% | 100% | 5.0 |
| seo_research | 5 | 80% | 80% | 80% | 100% | 80% | 100% | 5.0 |
| gtm_planning | 5 | 100% | 100% | 60% | 80% | 80% | 100% | 5.0 |
| knowledge_base | 5 | 100% | 100% | 100% | 100% | 100% | 100% | 5.0 |
| edge_cases | 6 | 100% | 83% | 67% | 100% | 100% | 100% | 5.0 |
| multi_step | 5 | 0% | 0% | 50% | 100% | 25% | 100% | 5.0 |

Column key: task = task_completed, result = result_completed, behavior = behavior_adherence, response = response_consistency, context = context_consistency, loop = loop_guard

## Okareo Dashboard Links

- [onboarding](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/7eb51e20-a51d-4110-96f5-a73715f03ed2) (5 evals, new_user driver)
- [content_creation](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/75c490ca-68dd-44dc-bcba-e072330c5e75) (8 evals, power_user driver)
- [lead_management](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/3e7eb184-19e6-4cc9-8658-55569d0b32cd) (6 evals, technical_user driver)
- [seo_research](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/a7550756-8aca-4534-9042-51186bb0265b) (5 evals, technical_user driver)
- [gtm_planning](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/e49be978-0362-4f4f-afff-142701ec3f7e) (5 evals, power_user driver)
- [knowledge_base](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/6be1ce96-6975-4360-ae7b-69b9bac4d2eb) (5 evals, confused_user driver)
- [edge_cases](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/f9bc15f8-04c5-4213-b9af-f02f9698adc7) (6 evals, adversarial_user driver)
- [multi_step](https://app.okareo.com/project/0d5558f2-1829-4990-b4a2-78dd6f9c9798/eval/90454554-db99-4d45-80cd-c221ef4270bf) (5 evals, power_user driver)

## Cost and Latency

| Scenario | Cost | Avg Latency |
|---|---|---|
| onboarding | $0.064 | 2,122ms |
| content_creation | $0.049 | 1,940ms |
| lead_management | - | - |
| seo_research | $0.148 | 2,498ms |
| gtm_planning | $0.074 | 2,204ms |
| knowledge_base | $0.051 | 2,043ms |
| edge_cases | $0.042 | 1,670ms |
| multi_step | $0.026 | 1,740ms |

## Analysis

### Strong Areas

- **Knowledge Base (100%)** — Emma correctly searches KB, retrieves files, and uses information in context. The confused_user driver tests mid-conversation changes and partial info, all handled well.
- **Onboarding (100% task/result)** — New users get guided through capabilities, skill discovery works. One behavior_adherence miss (80%) where Emma didn't follow the exact expected pattern.
- **Lead Management (100% task/result)** — CRM queries, email outreach, and campaign management all work. Technical_user driver asks detailed questions about data, which Emma handles.
- **Safety (100% loop_guard, 5.0 toxicity everywhere)** — No stuck loops, no toxic content across all 45 evaluations.

### Weak Areas

- **Multi-Step (0% task/result)** — The weakest scenario. Emma repeats initial questions instead of progressing through complex multi-tool workflows. She asks "what's your company?" even after the user already provided details. Root cause: Emma loses context in long tool-chain conversations, or the generate endpoint returns stale responses.
- **Content Creation (33% task)** — Some evals lost context mid-conversation. Likely related to the large tool call results (blog articles, social posts) bloating the conversation history.
- **GTM Planning (60% behavior)** — Emma completes the task but doesn't always follow the expected behavior pattern (e.g., creating a plan vs. just listing actions).

### Known Issues

1. **Okareo SDK polling bug** — `run_simulation()` blocks indefinitely even after the simulation finishes in Okareo. Workaround: launch from script, check results via MCP tools or dashboard.
2. **EC2 backend overload** — Running 5+ concurrent simulations overwhelms the single-instance test environment. Run scenarios sequentially.
3. **Driver variable substitution** — Okareo drivers only support the built-in `{scenario_input}` variable, not individual field variables like `{persona_name}`. All driver prompts use `{scenario_input}` with instructions to parse the JSON.
4. **Tool calls path removed** — `response_tool_calls_path` intentionally omitted from the target config. Including it causes Okareo to inject raw JSON tool call results into the conversation shown to the driver, which confuses the simulated user.

## Next Steps

- Investigate multi_step failures — review conversation transcripts for context loss patterns
- Investigate content_creation failures — check if large tool results cause context truncation
- Run with different models for comparison (e.g., claude-sonnet-4-5, gpt-4o)
- Add custom checks (tool_selection, actionable, brand_voice) to future runs
- Improve edge_cases scenarios for LinkedIn scraping test (Emma didn't explicitly decline)
