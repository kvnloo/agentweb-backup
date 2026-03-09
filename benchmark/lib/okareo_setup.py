"""Helpers to create Okareo resources (scenarios, drivers, checks, targets)."""

import json
import os
from pathlib import Path

from okareo import Okareo
from okareo.model_under_test import (
    CustomEndpointTarget,
    Driver,
    EndSessionConfig,
    SessionConfig,
    Target,
    TurnConfig,
)
from okareo.checks import ModelBasedCheck, CheckOutputType
from okareo_api_client.models.scenario_set_create import ScenarioSetCreate

from .auth import get_staging_token, get_staging_url

BENCHMARK_DIR = Path(__file__).resolve().parent.parent

SCENARIO_NAMES = [
    "onboarding",
    "content_creation",
    "lead_management",
    "seo_research",
    "gtm_planning",
    "knowledge_base",
    "edge_cases",
    "multi_step",
]

DRIVER_NAMES = [
    "new_user",
    "power_user",
    "confused_user",
    "technical_user",
    "adversarial_user",
]

CUSTOM_CHECKS = [
    "skill_install_before_use",
    "correct_tool_selection",
    "no_hallucinated_capabilities",
    "actionable_response",
    "brand_voice_consistency",
]

BUILTIN_CHECKS = [
    "task_completed",
    "result_completed",
    "behavior_adherence",
    "response_consistency",
    "loop_guard",
    "context_consistency",
    "function_call_consistency",
    "empathy_score",
    "toxicity",
    "avg_turn_latency",
    "total_cost",
    "total_turn_count",
]

# Default model to test
DEFAULT_MODEL = "anthropic.claude-sonnet-4-6"


def get_okareo_client() -> Okareo:
    return Okareo(os.environ["OKAREO_API_KEY"])


def load_scenario_rows(name: str) -> list[dict]:
    path = BENCHMARK_DIR / "scenarios" / f"{name}.json"
    with open(path) as f:
        return json.load(f)


def load_driver_prompt(name: str) -> str:
    path = BENCHMARK_DIR / "drivers" / f"{name}.txt"
    return path.read_text()


def load_check_module(name: str):
    """Import a custom check module and return (prompt_template, check_type)."""
    import importlib.util
    path = BENCHMARK_DIR / "checks" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.PROMPT_TEMPLATE, mod.CHECK_TYPE


def create_all_scenarios(okareo: Okareo) -> dict:
    """Create all scenario sets. Returns {name: scenario_object}."""
    results = {}
    for name in SCENARIO_NAMES:
        rows = load_scenario_rows(name)
        seed_data = okareo.seed_data_from_list(rows)
        scenario = okareo.create_scenario_set(
            ScenarioSetCreate(name=f"emma-benchmark-{name}", seed_data=seed_data)
        )
        results[name] = scenario
        print(f"  Scenario: emma-benchmark-{name} ({len(rows)} rows)")
    return results


def create_all_drivers(okareo: Okareo) -> dict:
    """Create all driver personas. Returns {name: driver_object}."""
    results = {}
    for name in DRIVER_NAMES:
        prompt = load_driver_prompt(name)
        driver = Driver(name=f"emma-{name}", prompt_template=prompt)
        driver = okareo.create_or_update_driver(driver)
        results[name] = driver
        print(f"  Driver: emma-{name}")
    return results


def create_all_checks(okareo: Okareo) -> dict:
    """Create custom LLM-evaluated checks. Returns {name: check_object}."""
    results = {}
    for name in CUSTOM_CHECKS:
        prompt_template, check_type = load_check_module(name)
        output_type = CheckOutputType.PASS_FAIL if check_type == "pass_fail" else CheckOutputType.SCORE
        check = ModelBasedCheck(
            prompt_template=prompt_template,
            check_type=output_type,
        )
        result = okareo.create_or_update_check(
            name=f"emma-{name}",
            description=f"Custom benchmark check: {name.replace('_', ' ')}",
            check=check,
        )
        results[name] = result
        print(f"  Check: emma-{name} ({check_type})")
    return results


def create_target(okareo: Okareo, model: str = DEFAULT_MODEL, name_suffix: str = "") -> object:
    """Create a custom endpoint target pointing at the staging AgentWeb API."""
    base_url = get_staging_url()
    token = get_staging_token()
    target_name = f"emma-staging-{name_suffix}" if name_suffix else "emma-staging"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
    }

    endpoint = CustomEndpointTarget(
        start_session=SessionConfig(
            url=f"{base_url}/api/agent-mode/sessions",
            method="POST",
            headers=headers,
            body={
                "portalType": "agent",
                "pageIdentifier": "agent-mode",
            },
            status_code=201,
            response_session_id_path="response.sessionId",
        ),
        next_turn=TurnConfig(
            url=f"{base_url}/api/agent-mode/generate",
            method="POST",
            headers=headers,
            body={
                "sessionId": "{session_id}",
                "userMessage": "{latest_message}",
                "llmModel": model,
            },
            status_code=200,
            response_message_path="response.content",
            # Note: response_tool_calls_path intentionally omitted.
            # Including it causes Okareo to show raw tool call JSON in the
            # conversation, which confuses the driver persona.
        ),
        end_session=EndSessionConfig(
            url=f"{base_url}/api/agent-mode/session/{{session_id}}",
            method="GET",
            headers=headers,
            status_code=200,
        ),
    )

    target = Target(name=target_name, target=endpoint)
    registered = okareo.create_or_update_target(target, tags=[f"model:{model}"])
    print(f"  Target: {target_name} (model={model})")
    return registered


def get_all_check_names() -> list[str]:
    """Return all check names (builtin + custom) for use in simulations."""
    custom = [f"emma-{name}" for name in CUSTOM_CHECKS]
    return BUILTIN_CHECKS + custom
