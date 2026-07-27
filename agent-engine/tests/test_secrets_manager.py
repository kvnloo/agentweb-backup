#!/usr/bin/env python3
import unittest
import os
import sys
from unittest.mock import patch, MagicMock

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import secrets_manager


class TestSecretsManagerEnvFallback(unittest.TestCase):
    """Env var must always win and Secrets Manager must never be called when it's set."""

    def setUp(self):
        secrets_manager._secret_cache.clear()

    @patch('secrets_manager.boto3.client')
    def test_string_secret_uses_env_var_without_calling_aws(self, mock_boto_client):
        with patch.dict(os.environ, {'RESEND_API_KEY': 'env-value'}, clear=False):
            result = secrets_manager.get_resend_api_key()
        self.assertEqual(result, 'env-value')
        mock_boto_client.assert_not_called()

    @patch('secrets_manager.boto3.client')
    def test_json_secret_uses_env_var_without_calling_aws(self, mock_boto_client):
        with patch.dict(os.environ, {'AZURE_OPENAI_API_KEY': 'env-azure-key'}, clear=False):
            result = secrets_manager.get_azure_openai_api_key()
        self.assertEqual(result, 'env-azure-key')
        mock_boto_client.assert_not_called()

    @patch('secrets_manager.boto3.client')
    def test_string_secret_falls_back_to_secrets_manager_when_env_unset(self, mock_boto_client):
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {'SecretString': 'sm-value'}
        mock_boto_client.return_value = mock_client

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('RESEND_API_KEY', None)
            result = secrets_manager.get_resend_api_key()

        self.assertEqual(result, 'sm-value')
        mock_client.get_secret_value.assert_called_once()
        called_secret_id = mock_client.get_secret_value.call_args.kwargs['SecretId']
        self.assertTrue(called_secret_id.endswith('/AgentWeb/AgentEngine/Resend'))

    @patch('secrets_manager.boto3.client')
    def test_json_secret_falls_back_to_secrets_manager_when_env_unset(self, mock_boto_client):
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {
            'SecretString': '{"apiKey": "sm-azure-key", "endpoint": "https://example.azure.com", "apiVersion": "2024-08-01-preview"}'
        }
        mock_boto_client.return_value = mock_client

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('AZURE_OPENAI_API_KEY', None)
            api_key = secrets_manager.get_azure_openai_api_key()
            endpoint = secrets_manager.get_azure_openai_endpoint()

        self.assertEqual(api_key, 'sm-azure-key')
        self.assertEqual(endpoint, 'https://example.azure.com')
        # The underlying secret is fetched once and cached across getters.
        mock_client.get_secret_value.assert_called_once()

    @patch('secrets_manager.boto3.client')
    def test_secret_name_uses_dev_prefix_by_default(self, mock_boto_client):
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {'SecretString': 'sm-value'}
        mock_boto_client.return_value = mock_client

        with patch.dict(os.environ, {}, clear=True):
            os.environ.pop('AGENT_ENGINE_ENV', None)
            os.environ.pop('RESEND_API_KEY', None)
            secrets_manager.get_resend_api_key()

        called_secret_id = mock_client.get_secret_value.call_args.kwargs['SecretId']
        self.assertTrue(called_secret_id.startswith('dev/'))

    @patch('secrets_manager.boto3.client')
    def test_secret_name_uses_prod_prefix_when_configured(self, mock_boto_client):
        mock_client = MagicMock()
        mock_client.get_secret_value.return_value = {'SecretString': 'sm-value'}
        mock_boto_client.return_value = mock_client

        with patch.dict(os.environ, {'AGENT_ENGINE_ENV': 'production'}, clear=False):
            os.environ.pop('RESEND_API_KEY', None)
            secrets_manager.get_resend_api_key()

        called_secret_id = mock_client.get_secret_value.call_args.kwargs['SecretId']
        self.assertTrue(called_secret_id.startswith('prod/'))


if __name__ == '__main__':
    unittest.main()
