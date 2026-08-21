#!/usr/bin/env python3
import unittest
import os
import sys
from unittest.mock import patch, MagicMock

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import secrets_manager


def _mock_secret_manager_client(payload: str):
    client = MagicMock()
    response = MagicMock()
    response.payload.data = payload.encode('UTF-8')
    client.access_secret_version.return_value = response
    return client


class TestSecretsManagerEnvFallback(unittest.TestCase):
    """Env var must always win and GCP Secret Manager must never be called when it's set."""

    def setUp(self):
        secrets_manager._secret_cache.clear()
        secrets_manager._client = None

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_string_secret_uses_env_var_without_calling_gcp(self, mock_client_cls):
        with patch.dict(os.environ, {'RESEND_API_KEY': 'env-value'}, clear=False):
            result = secrets_manager.get_resend_api_key()
        self.assertEqual(result, 'env-value')
        mock_client_cls.assert_not_called()

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_json_secret_uses_env_var_without_calling_gcp(self, mock_client_cls):
        with patch.dict(os.environ, {'AZURE_OPENAI_API_KEY': 'env-azure-key'}, clear=False):
            result = secrets_manager.get_azure_openai_api_key()
        self.assertEqual(result, 'env-azure-key')
        mock_client_cls.assert_not_called()

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_secret_value_is_stripped_of_trailing_whitespace(self, mock_client_cls):
        # Regression: secrets created via `grep | cut` from a .env file carry
        # the source line's trailing newline. Most consumers tolerate it
        # silently, but `requests` rejects a newline in an HTTP header value
        # outright (CRLF injection protection) — broke the scheduled-chats
        # service-secret header in production testing.
        mock_client_cls.return_value = _mock_secret_manager_client('sm-value-with-newline\n')

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('RESEND_API_KEY', None)
            result = secrets_manager.get_resend_api_key()

        self.assertEqual(result, 'sm-value-with-newline')

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_string_secret_falls_back_to_secret_manager_when_env_unset(self, mock_client_cls):
        mock_client_cls.return_value = _mock_secret_manager_client('sm-value')

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('RESEND_API_KEY', None)
            result = secrets_manager.get_resend_api_key()

        self.assertEqual(result, 'sm-value')
        client = mock_client_cls.return_value
        client.access_secret_version.assert_called_once()
        called_name = client.access_secret_version.call_args.kwargs['request']['name']
        self.assertIn('/secrets/agentengine-dev-resend/versions/latest', called_name)

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_json_secret_falls_back_to_secret_manager_when_env_unset(self, mock_client_cls):
        payload = '{"apiKey": "sm-azure-key", "endpoint": "https://example.azure.com", "apiVersion": "2024-08-01-preview"}'
        mock_client_cls.return_value = _mock_secret_manager_client(payload)

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('AZURE_OPENAI_API_KEY', None)
            api_key = secrets_manager.get_azure_openai_api_key()
            endpoint = secrets_manager.get_azure_openai_endpoint()

        self.assertEqual(api_key, 'sm-azure-key')
        self.assertEqual(endpoint, 'https://example.azure.com')
        # The underlying secret is fetched once and cached across getters.
        mock_client_cls.return_value.access_secret_version.assert_called_once()

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_secret_id_uses_dev_prefix_by_default(self, mock_client_cls):
        mock_client_cls.return_value = _mock_secret_manager_client('sm-value')

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('AGENT_ENGINE_ENV', None)
            os.environ.pop('RESEND_API_KEY', None)
            secrets_manager.get_resend_api_key()

        called_name = mock_client_cls.return_value.access_secret_version.call_args.kwargs['request']['name']
        self.assertIn('/secrets/agentengine-dev-resend/', called_name)

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_secret_id_uses_prod_prefix_when_configured(self, mock_client_cls):
        mock_client_cls.return_value = _mock_secret_manager_client('sm-value')

        with patch.dict(os.environ, {'AGENT_ENGINE_ENV': 'production'}, clear=False):
            os.environ.pop('RESEND_API_KEY', None)
            secrets_manager.get_resend_api_key()

        called_name = mock_client_cls.return_value.access_secret_version.call_args.kwargs['request']['name']
        self.assertIn('/secrets/agentengine-prod-resend/', called_name)

    @patch('secrets_manager.secretmanager.SecretManagerServiceClient')
    def test_aws_credentials_fetched_from_json_secret(self, mock_client_cls):
        # Matches the real payload shape created for agentengine-prod-aws-credentials.
        payload = '{"AWS_ACCESS_KEY_ID": "AKIAFAKE", "AWS_SECRET_ACCESS_KEY": "fakesecret", "AWS_REGION": "us-west-2"}'
        mock_client_cls.return_value = _mock_secret_manager_client(payload)

        with patch.dict(os.environ, {}, clear=True):
            for var in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'):
                os.environ.pop(var, None)
            access_key = secrets_manager.get_aws_access_key_id()
            secret_key = secrets_manager.get_aws_secret_access_key()
            region = secrets_manager.get_aws_region()

        self.assertEqual(access_key, 'AKIAFAKE')
        self.assertEqual(secret_key, 'fakesecret')
        self.assertEqual(region, 'us-west-2')
        # All three getters resolve from the same underlying secret, fetched once.
        mock_client_cls.return_value.access_secret_version.assert_called_once()


if __name__ == '__main__':
    unittest.main()
