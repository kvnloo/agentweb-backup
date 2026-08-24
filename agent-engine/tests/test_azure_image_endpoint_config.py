"""ENG-410: the Azure image endpoint must come from configuration, never a hardcoded default.

Production image generation previously pointed at an Azure AI Services resource inside a
departed co-founder's personal Microsoft account. These tests pin the contract that replaced it:
the endpoint is read from the environment, and an unset value fails loudly rather than silently
routing at some other account's resource.
"""
import os
import pathlib
import re
import unittest


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
WEB_AGENT = REPO_ROOT / "web_agent.py"


class _StubSecretsManager:
    """Stand-in for secrets_manager.py in this lightweight exec() sandbox.

    get_azure_image_endpoint() (ENG-389) routes through secrets_manager
    (env var first, GCP Secret Manager fallback in prod) rather than a bare
    os.getenv, so real code needs this symbol available. This stub mirrors
    just the env-var-first half - these tests only ever exercise the env
    var being set or unset, never the GCP fallback, so that's a faithful
    match without needing the real google-cloud-secretmanager import here."""

    @staticmethod
    def get_azure_image_endpoint():
        return os.getenv("AZURE_IMAGE_ENDPOINT")


def _load_endpoint_helper():
    """Load get_azure_image_endpoint without importing web_agent's heavy deps."""
    src = WEB_AGENT.read_text()
    match = re.search(
        r"^AZURE_IMAGE_ENDPOINT_ENV = .*?^def get_azure_image_endpoint.*?return endpoint\.rstrip\('/'\) or None",
        src,
        re.S | re.M,
    )
    if not match:
        raise AssertionError("get_azure_image_endpoint helper not found in web_agent.py")
    ns = {
        "os": os,
        "Optional": __import__("typing").Optional,
        "secrets_manager": _StubSecretsManager(),
    }
    exec(compile(match.group(0), str(WEB_AGENT), "exec"), ns)
    return ns["get_azure_image_endpoint"], ns["AZURE_IMAGE_ENDPOINT_ENV"]


class TestAzureImageEndpointConfig(unittest.TestCase):
    def setUp(self):
        self.helper, self.env_name = _load_endpoint_helper()
        self._saved = os.environ.get("AZURE_IMAGE_ENDPOINT")

    def tearDown(self):
        if self._saved is None:
            os.environ.pop("AZURE_IMAGE_ENDPOINT", None)
        else:
            os.environ["AZURE_IMAGE_ENDPOINT"] = self._saved

    def test_env_var_name(self):
        self.assertEqual(self.env_name, "AZURE_IMAGE_ENDPOINT")

    def test_returns_configured_endpoint(self):
        os.environ["AZURE_IMAGE_ENDPOINT"] = "https://agentweb-imagegen-prod.services.ai.azure.com"
        self.assertEqual(
            self.helper(), "https://agentweb-imagegen-prod.services.ai.azure.com"
        )

    def test_strips_trailing_slashes_so_url_join_is_safe(self):
        os.environ["AZURE_IMAGE_ENDPOINT"] = "https://agentweb-imagegen-prod.services.ai.azure.com///"
        endpoint = self.helper()
        self.assertEqual(endpoint, "https://agentweb-imagegen-prod.services.ai.azure.com")
        self.assertEqual(
            f"{endpoint}/openai/deployments/gpt-image-1/images/generations",
            "https://agentweb-imagegen-prod.services.ai.azure.com/openai/deployments/gpt-image-1/images/generations",
        )

    def test_unset_returns_none_so_caller_fails_loudly(self):
        os.environ.pop("AZURE_IMAGE_ENDPOINT", None)
        self.assertIsNone(self.helper())

    def test_blank_or_whitespace_returns_none(self):
        for value in ("", "   ", "\t"):
            os.environ["AZURE_IMAGE_ENDPOINT"] = value
            self.assertIsNone(self.helper(), f"expected None for {value!r}")

    def test_no_departed_account_endpoint_hardcoded_in_web_agent(self):
        self.assertNotIn("ruiwangwarm", WEB_AGENT.read_text())

    def test_both_azure_image_branches_read_from_config(self):
        src = WEB_AGENT.read_text()
        # Each Azure image branch (FLUX + gpt-image-1) resolves the endpoint from config
        # and returns an error when it is missing.
        self.assertEqual(src.count("azure_endpoint = get_azure_image_endpoint()"), 2)
        self.assertEqual(
            src.count(f"{{AZURE_IMAGE_ENDPOINT_ENV}} environment variable is not set"), 2
        )

    def test_image_credentials_are_decoupled_from_the_chat_client_key(self):
        """Image gen must not reuse AZURE_OPENAI_API_KEY2.

        That variable is paired with AZURE_OPENAI_ENDPOINT2 for the chat client in
        task_utils.get_azure_openai_llm2(). Sharing it meant repointing the image
        endpoint alone would authenticate the new resource with the old one's key.
        """
        src = WEB_AGENT.read_text()
        # Assert on executable code, not prose: the explanatory comment above the helpers
        # legitimately names the old variable.
        code = "\n".join(
            line for line in src.splitlines() if not line.lstrip().startswith("#")
        )
        self.assertNotIn("AZURE_OPENAI_API_KEY2", code)
        self.assertEqual(src.count("api_key = get_azure_image_api_key()"), 2)
        self.assertEqual(
            src.count(f"{{AZURE_IMAGE_API_KEY_ENV}} environment variable is not set"), 2
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
