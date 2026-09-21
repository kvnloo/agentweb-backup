"""ENG-1823: parse web_agent.py's CLI subprocess result correctly regardless
of exit code.

Background: task_monitor.py runs agent-engine's WebAgent as a CLI subprocess
(web_agent.py's __main__), which prints its result dict as one JSON line to
stdout, then exits 0 on success, 1 on failure (`sys.exit(0 if
result["success"] else 1)`). Before ENG-1823's fix to web_agent.py's own
success semantics, `result["success"]` was effectively always True whenever
the agent called `done` at all -- so this subprocess essentially never
exited non-zero for a run that actually finished, and gating stdout parsing
on returncode == 0 never mattered in practice.

After that fix, a run whose agent explicitly reported failure (`done` with
success: false) now correctly exits 1 -- but it still prints a complete,
well-formed result dict to stdout before doing so. Gating stdout parsing on
returncode == 0 alone would throw that dict away and replace it with a
generic "Process error: <raw stderr>" message, discarding exactly the
explanation (e.g. "No real action was performed yet...") this whole ticket
exists to surface correctly. So: always look for the result dict in stdout
first, and only fall back to a stderr-based generic error when nothing
structured was found there -- which still covers a genuine crash correctly.

Pure, dependency-free logic (no browser_use / playwright / asyncio imports)
so it is unit-testable under plain Python.
"""
import json
import logging
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


def parse_web_agent_cli_result(
    stdout: Optional[bytes],
    stderr: Optional[bytes],
    returncode: int,
    log_file: str,
    llm_name: str,
) -> Dict[str, Any]:
    """Return the result dict from a web_agent.py CLI subprocess run.

    Looks for the last valid JSON object containing a 'success' key in
    stdout, regardless of returncode -- a correctly-reported task failure
    still prints one before exiting non-zero. Falls back to a generic
    stderr-based error only when nothing structured was found.
    """
    try:
        output = stdout.decode() if stdout else ""
        for line in reversed(output.split('\n')):
            line = line.strip()
            if not line:
                continue
            try:
                result = json.loads(line)
                if isinstance(result, dict) and 'success' in result:
                    logger.info("Successfully parsed result from web_agent.py")
                    return result
            except json.JSONDecodeError:
                continue
    except Exception as e:
        logger.error(f"Error parsing output: {e}")
        return {
            "success": False,
            "error": f"Failed to parse output: {str(e)}. Check {log_file} for details.",
            "llmName": llm_name,
        }

    if returncode != 0:
        error_msg = stderr.decode() if stderr else "Unknown error"
        logger.error(f"Process failed with error: {error_msg}")
        return {
            "success": False,
            "error": f"Process error: {error_msg}. Check {log_file} for details.",
            "llmName": llm_name,
        }

    logger.error(f"No valid JSON found in output. Full output written to {log_file}")
    return {
        "success": False,
        "error": f"No valid JSON output found. Check {log_file} for details.",
        "llmName": llm_name,
    }
