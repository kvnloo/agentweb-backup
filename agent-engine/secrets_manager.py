import os
import json
import logging
from google.cloud import secretmanager

logger = logging.getLogger(__name__)

_secret_cache: dict = {}
_client = None


def _environment() -> str:
    return 'production' if os.getenv('AGENT_ENGINE_ENV') == 'production' else 'development'


def _gcp_project_id() -> str:
    # The VM this runs on lives in this project; ADC picks up the attached
    # service account automatically (no key file / credential wiring needed).
    return os.getenv('GCP_PROJECT_ID', 'agent-engine-460619')


def _client_singleton():
    global _client
    if _client is None:
        _client = secretmanager.SecretManagerServiceClient()
    return _client


def get_secret(secret_id: str) -> str:
    """Fetch a secret's latest version from GCP Secret Manager, caching per process."""
    if secret_id in _secret_cache:
        return _secret_cache[secret_id]

    name = f"projects/{_gcp_project_id()}/secrets/{secret_id}/versions/latest"
    try:
        response = _client_singleton().access_secret_version(request={"name": name})
    except Exception as e:
        logger.error(f"Error fetching secret {secret_id}: {e}")
        raise

    value = response.payload.data.decode('UTF-8')
    if not value:
        raise ValueError(f"Secret {secret_id} is empty")

    _secret_cache[secret_id] = value
    return value


def _get_json_secret(secret_id: str) -> dict:
    return json.loads(get_secret(secret_id))


def _agent_engine_secret_id(sub_key: str) -> str:
    # GCP Secret Manager IDs don't support '/', so we flatten the
    # prod/AgentWeb/AgentEngine/<SubKey> convention used elsewhere in the org
    # into a single hyphenated ID: agentengine-<env>-<subkey>.
    prefix = 'prod' if _environment() == 'production' else 'dev'
    return f"agentengine-{prefix}-{sub_key.lower()}"


def _env_or_json_secret(env_var: str, sub_key: str, json_key: str, default: str = None) -> str:
    """Env var first (local dev via .env), Secret Manager fallback (prod)."""
    value = os.getenv(env_var)
    if value:
        return value
    try:
        data = _get_json_secret(_agent_engine_secret_id(sub_key))
        return data.get(json_key, default)
    except Exception as e:
        logger.error(f"Could not resolve {env_var} from env or Secret Manager ({sub_key}): {e}")
        return default


def _env_or_string_secret(env_var: str, sub_key: str, default: str = None) -> str:
    value = os.getenv(env_var)
    if value:
        return value
    try:
        return get_secret(_agent_engine_secret_id(sub_key))
    except Exception as e:
        logger.error(f"Could not resolve {env_var} from env or Secret Manager ({sub_key}): {e}")
        return default


def get_openai_api_key() -> str:
    return _env_or_string_secret('OPENAI_API_KEY', 'openai')


def get_gemini_api_key() -> str:
    return _env_or_string_secret('GEMINI_API_KEY', 'gemini')


def get_google_image_api_key() -> str:
    return _env_or_string_secret('GOOGLE_IMAGE_API_KEY', 'google-image')


def get_deepseek_api_key() -> str:
    return _env_or_string_secret('DEEPSEEK_API_KEY', 'deepseek')


def get_pld_deepseek_api_key() -> str:
    return _env_or_string_secret('PLD_DEEPSEEK_API_KEY', 'pld-deepseek')


def get_resend_api_key() -> str:
    return _env_or_string_secret('RESEND_API_KEY', 'resend')


def get_azure_openai_api_key() -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_KEY', 'azure-openai', 'apiKey')


def get_azure_openai_endpoint() -> str:
    return _env_or_json_secret('AZURE_OPENAI_ENDPOINT', 'azure-openai', 'endpoint')


def get_azure_openai_api_version(default: str = '2024-08-01-preview') -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_VERSION', 'azure-openai', 'apiVersion', default)


def get_azure_openai_api_key2() -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_KEY2', 'azure-openai-2', 'apiKey')


def get_azure_openai_endpoint2() -> str:
    return _env_or_json_secret('AZURE_OPENAI_ENDPOINT2', 'azure-openai-2', 'endpoint')


def get_azure_openai_api_version2(default: str = '2024-12-01-preview') -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_VERSION2', 'azure-openai-2', 'apiVersion', default)


def get_azure_openai_api_key3() -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_KEY3', 'azure-openai-3', 'apiKey')


def get_azure_openai_endpoint3() -> str:
    return _env_or_json_secret('AZURE_OPENAI_ENDPOINT3', 'azure-openai-3', 'endpoint')


def get_azure_openai_api_version3(default: str = '2025-01-01-preview') -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_VERSION3', 'azure-openai-3', 'apiVersion', default)


def get_scheduled_chats_service_secret() -> str:
    return _env_or_string_secret('SCHEDULED_CHATS_SERVICE_SECRET', 'scheduled-chats-service-secret')


def get_alert_webhook_url() -> str:
    """Slack incoming-webhook URL used by deploy/alert_oncall.sh on process failure."""
    return _env_or_string_secret('AGENT_ENGINE_ALERT_WEBHOOK_URL', 'alert-webhook')


def get_aws_access_key_id() -> str:
    return _env_or_json_secret('AWS_ACCESS_KEY_ID', 'aws-credentials', 'AWS_ACCESS_KEY_ID')


def get_aws_secret_access_key() -> str:
    return _env_or_json_secret('AWS_SECRET_ACCESS_KEY', 'aws-credentials', 'AWS_SECRET_ACCESS_KEY')


def get_aws_region(default: str = 'us-west-2') -> str:
    return _env_or_json_secret('AWS_REGION', 'aws-credentials', 'AWS_REGION', default)


def get_aws_default_region(default: str = 'us-west-2') -> str:
    # web_agent.py:223 uses a bare boto3.client('s3') on boto3's default
    # credential/region chain, which does not read AWS_REGION — only
    # AWS_DEFAULT_REGION (or an explicit region_name kwarg) satisfies it.
    return _env_or_json_secret('AWS_DEFAULT_REGION', 'aws-credentials', 'AWS_DEFAULT_REGION', default)
