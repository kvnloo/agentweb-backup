import os
import json
import logging
import boto3

logger = logging.getLogger(__name__)

_secret_cache: dict = {}


def _environment() -> str:
    return 'production' if os.getenv('AGENT_ENGINE_ENV') == 'production' else 'development'


def get_secret(secret_name: str) -> str:
    """Fetch a secret string from AWS Secrets Manager, caching per process."""
    if secret_name in _secret_cache:
        return _secret_cache[secret_name]

    client = boto3.client('secretsmanager', region_name=os.getenv('AWS_REGION', 'us-west-2'))
    try:
        response = client.get_secret_value(SecretId=secret_name)
    except Exception as e:
        logger.error(f"Error fetching secret {secret_name}: {e}")
        raise

    value = response.get('SecretString')
    if not value:
        raise ValueError(f"Secret {secret_name} has no SecretString")

    _secret_cache[secret_name] = value
    return value


def _get_json_secret(secret_name: str) -> dict:
    return json.loads(get_secret(secret_name))


def _agent_engine_secret_name(sub_key: str) -> str:
    prefix = 'prod' if _environment() == 'production' else 'dev'
    return f"{prefix}/AgentWeb/AgentEngine/{sub_key}"


def _env_or_json_secret(env_var: str, sub_key: str, json_key: str, default: str = None) -> str:
    """Env var first (local dev via .env), Secrets Manager fallback (prod)."""
    value = os.getenv(env_var)
    if value:
        return value
    try:
        data = _get_json_secret(_agent_engine_secret_name(sub_key))
        return data.get(json_key, default)
    except Exception as e:
        logger.error(f"Could not resolve {env_var} from env or Secrets Manager ({sub_key}): {e}")
        return default


def _env_or_string_secret(env_var: str, sub_key: str, default: str = None) -> str:
    value = os.getenv(env_var)
    if value:
        return value
    try:
        return get_secret(_agent_engine_secret_name(sub_key))
    except Exception as e:
        logger.error(f"Could not resolve {env_var} from env or Secrets Manager ({sub_key}): {e}")
        return default


def get_openai_api_key() -> str:
    return _env_or_string_secret('OPENAI_API_KEY', 'OpenAI')


def get_gemini_api_key() -> str:
    return _env_or_string_secret('GEMINI_API_KEY', 'Gemini')


def get_google_image_api_key() -> str:
    return _env_or_string_secret('GOOGLE_IMAGE_API_KEY', 'GoogleImage')


def get_deepseek_api_key() -> str:
    return _env_or_string_secret('DEEPSEEK_API_KEY', 'DeepSeek')


def get_pld_deepseek_api_key() -> str:
    return _env_or_string_secret('PLD_DEEPSEEK_API_KEY', 'PLDDeepSeek')


def get_resend_api_key() -> str:
    return _env_or_string_secret('RESEND_API_KEY', 'Resend')


def get_azure_openai_api_key() -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_KEY', 'AzureOpenAI', 'apiKey')


def get_azure_openai_endpoint() -> str:
    return _env_or_json_secret('AZURE_OPENAI_ENDPOINT', 'AzureOpenAI', 'endpoint')


def get_azure_openai_api_version(default: str = '2024-08-01-preview') -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_VERSION', 'AzureOpenAI', 'apiVersion', default)


def get_azure_openai_api_key2() -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_KEY2', 'AzureOpenAI2', 'apiKey')


def get_azure_openai_endpoint2() -> str:
    return _env_or_json_secret('AZURE_OPENAI_ENDPOINT2', 'AzureOpenAI2', 'endpoint')


def get_azure_openai_api_version2(default: str = '2024-12-01-preview') -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_VERSION2', 'AzureOpenAI2', 'apiVersion', default)


def get_azure_openai_api_key3() -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_KEY3', 'AzureOpenAI3', 'apiKey')


def get_azure_openai_endpoint3() -> str:
    return _env_or_json_secret('AZURE_OPENAI_ENDPOINT3', 'AzureOpenAI3', 'endpoint')


def get_azure_openai_api_version3(default: str = '2025-01-01-preview') -> str:
    return _env_or_json_secret('AZURE_OPENAI_API_VERSION3', 'AzureOpenAI3', 'apiVersion', default)
