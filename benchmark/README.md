# Emma Benchmark V2 (Okareo-Based)

Multi-turn evaluation system for Emma (AgentWeb's AI marketing assistant) using the Okareo platform. Runs against the staging backend via REST API with zero backend changes.

## Quick Start

```bash
cd benchmark
pip install -r requirements.txt
cp .env.example .env   # Fill in your keys

# 1. Create all Okareo resources (one-time)
python setup.py

# 2. Run benchmarks
python run.py

# 3. Compare runs
python compare.py <baseline_label> <new_label>
```

## Architecture

```
benchmark/           Okareo SDK (Python)
    |
    v
Okareo Platform      Scenarios + Drivers + Checks
    |                    multi-turn simulation
    v
AgentWeb Staging     POST /api/agent-mode/sessions  (create session)
                     POST /api/agent-mode/generate   (send message)
```

Each simulation creates a real AgentWeb session on staging. Okareo's driver (simulated user persona) has a multi-turn conversation with Emma, then quality checks evaluate the transcript.

## Scenarios (8 sets, ~45 rows)

| Scenario | Rows | Tests |
|----------|------|-------|
| Onboarding | 5 | Brand setup, skill discovery, first work plan |
| Content Creation | 8 | Blog, social media, images, video, email |
| Lead Management | 6 | CRM queries, email outreach, campaigns |
| SEO & Research | 5 | Web search, deep research, analytics |
| GTM Planning | 5 | Create/review plans, work items |
| Knowledge Base | 5 | Search KB, read files, use in context |
| Edge Cases | 6 | Off-topic, adversarial, guardrails |
| Multi-Step | 5 | Complex workflows requiring multiple tools |

## Drivers (5 personas)

| Driver | Style | Best for |
|--------|-------|----------|
| New User | Exploratory, broad questions | Onboarding |
| Power User | Direct, efficient | Content, GTM |
| Confused User | Vague, changes mind | Knowledge Base |
| Technical User | Data-focused, specific | SEO, Leads |
| Adversarial User | Boundary-testing | Edge Cases |

## Quality Checks

**Built-in (12):** task_completed, result_completed, behavior_adherence, response_consistency, loop_guard, context_consistency, function_call_consistency, empathy_score, toxicity, avg_turn_latency, total_cost, total_turn_count

**Custom (5):** skill_install_before_use, correct_tool_selection, no_hallucinated_capabilities, actionable_response, brand_voice_consistency

## Model Comparison

```bash
# Run baseline with default model
python run.py --label baseline

# Run with a different model
python run.py --model anthropic.claude-sonnet-4-5-20250514 --label sonnet45 --ensure-target

# Compare
python compare.py baseline sonnet45
```

The `--ensure-target` flag creates/updates the Okareo target for the specified model.

## CLI Reference

### setup.py
```
--model MODEL          LLM model for the target (default: claude-sonnet-4)
--skip-scenarios       Skip scenario creation
--skip-drivers         Skip driver creation
--skip-checks          Skip check creation
--skip-target          Skip target creation
```

### run.py
```
--scenario NAME        Run a single scenario (default: all)
--driver NAME          Override driver for all scenarios
--model MODEL          LLM model ID
--max-turns N          Max conversation turns (default: 5)
--label LABEL          Run label (default: timestamp)
--checks-only TYPE     builtin | custom | all (default: all)
--ensure-target        Create/update target before running
```

### compare.py
```
compare.py <baseline_label> <new_label>
```

## File Structure

```
benchmark/
  setup.py              Create Okareo resources
  run.py                Execute simulations
  compare.py            Compare two runs
  requirements.txt      Python dependencies
  .env.example          Environment template
  scenarios/*.json      Test case definitions
  drivers/*.txt         Simulated user personas
  checks/*.py           Custom quality checks
  lib/
    __init__.py
    auth.py             Staging JWT auth
    okareo_setup.py     Okareo resource helpers
  runs/                 Run metadata (auto-created)
```
