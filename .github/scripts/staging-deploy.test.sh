#!/usr/bin/env bash
# ENG-1866: structural workflow contract plus executable identity/health gates.
# No YAML dependency: match the repository's fixed step indentation and fail if
# a required step is absent. Syntax is checked separately with actionlint.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
python3 - <<'PY'
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

path = Path(os.environ.get('STAGING_WORKFLOW', '.github/workflows/staging-backend.yml'))
workflow = path.read_text() if path.exists() else ''

def step(name):
    match = re.search(r'^      - name: ' + re.escape(name) + r'\n(.*?)(?=^      - |\Z)', workflow, re.M | re.S)
    assert match, f'missing step: {name}'
    return match[1]

def script(name):
    block = step(name)
    match = re.search(r'^        run: \|\n((?:          .*\n|\n)+)', block, re.M)
    assert match, f'missing script: {name}'
    return '\n'.join(line[10:] for line in match[1].splitlines())

class StagingContract(unittest.TestCase):
    def test_staging_only_dispatch(self):
        self.assertRegex(workflow, r'on:\n  workflow_dispatch:\n    inputs:\n      ref:\n')
        self.assertRegex(workflow, r'      ref:\n(?:        .*\n)*        required: true\n')
        self.assertNotRegex(workflow, r'(?m)^  (push|pull_request|workflow_call):')
        self.assertIn("if: github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'", workflow)
        self.assertEqual(re.findall(r'^    environment: (.+)$', workflow, re.M), ['staging'])
        self.assertNotIn('partner', workflow.lower())
        self.assertNotIn('environment: prod', workflow)
        self.assertEqual(re.findall(r'^  ([\w-]+):\n', workflow.split('jobs:\n')[1], re.M), ['build', 'backend-staging-deploy'])

    def test_exact_checkout_and_trusted_deploy_script(self):
        self.assertIn('ref: ${{ inputs.ref }}', step('Checkout deployment source'))
        self.assertIn('path: source', step('Checkout deployment source'))
        self.assertIn('persist-credentials: false', step('Checkout deployment source'))
        self.assertIn('ref: ${{ github.sha }}', step('Checkout deploy controls'))
        self.assertIn('bash .github/scripts/eb-deploy.sh', step('Deploy and verify'))
        self.assertIn('working-directory: source/backend', step('Build and package'))
        self.assertIn("node-version: '22'", step('Setup Node.js'))
        for name in ('Build and package', 'Transfer deployment package'):
            self.assertIn('${{ steps.version.outputs.version_label }}', step(name))
        for name in ('Upload deployment package', 'Deploy and verify', 'Confirm staging Ready and Green'):
            self.assertIn('${{ needs.build.outputs.version_label }}', step(name))
        self.assertIn('EB_SOURCE_BUNDLE_S3_KEY: builds/${{ needs.build.outputs.version_label }}.zip', step('Deploy and verify'))
        self.assertIn('needs: build', workflow)
        self.assertIn('actions/upload-artifact@', step('Transfer deployment package'))
        self.assertIn('actions/download-artifact@', step('Download deployment package'))
        self.assertNotIn('continue-on-error', workflow)
        self.assertIn('run: bash .github/scripts/eb-deploy.sh', step('Deploy and verify'))

    def test_serialization_and_credentials(self):
        self.assertIn('concurrency:\n  group: backend-staging-deploy\n  cancel-in-progress: false', workflow)
        self.assertIn('permissions:\n  contents: read', workflow)
        for name in ('EB_BACKEND_STAGING_APPLICATION_NAME', 'EB_BACKEND_STAGING_ENVIRONMENT_NAME'):
            self.assertIn('${{ vars.' + name + ' }}', workflow)
        self.assertNotIn('${{ vars.EB_BACKEND_APPLICATION_NAME }}', workflow)
        self.assertNotIn('${{ vars.EB_BACKEND_ENVIRONMENT_NAME }}', workflow)
        for name in ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'):
            self.assertIn('${{ secrets.' + name + ' }}', step('Configure AWS credentials'))
        self.assertNotIn('secrets.', workflow[:workflow.index('  backend-staging-deploy:')])
        self.assertLess(workflow.index('name: Transfer deployment package'), workflow.index('  backend-staging-deploy:'))
        deploy_job = workflow.split('  backend-staging-deploy:\n', 1)[1]
        job_timeout = int(re.search(r'^    timeout-minutes: (\d+)$', deploy_job, re.M).group(1))
        deploy_timeout = int(re.search(r"EB_TOTAL_TIMEOUT_SECONDS: '(\d+)'", deploy_job).group(1))
        green_timeout = int(re.search(r'STAGING_GREEN_TIMEOUT_SECONDS:-(\d+)', deploy_job).group(1))
        self.assertGreater(job_timeout * 60, deploy_timeout + green_timeout)

    def test_empty_ref_cannot_fall_back_to_main(self):
        self.assertIn('DEPLOY_REF: ${{ inputs.ref }}', step('Validate explicit ref'))
        self.assertLess(workflow.index('name: Validate explicit ref'), workflow.index('name: Checkout deployment source'))
        for ref, success in [('', False), ('  ', False), ('main', True), ('a' * 40, True), ('refs/pull/2851/head', True)]:
            result = subprocess.run(['bash', '-euo', 'pipefail', '-c', script('Validate explicit ref')], env=dict(os.environ, DEPLOY_REF=ref), capture_output=True)
            self.assertEqual(result.returncode == 0, success)

    def test_production_push_control(self):
        prod = Path('.github/workflows/deploy.yml').read_text()
        self.assertIn('push:\n    branches: [main]', prod)
        self.assertIn('group: deploy-production', prod)
        # ENG-2677: notify-feature-launch is the 4th prod-env job (reads prod Slack secret only, continue-on-error).
        self.assertEqual(prod.count('environment: prod'), 4)
        self.assertNotIn('inputs.ref', prod)

    def test_record_actual_sha_and_unique_version(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(['git', 'init', '-q', str(root / 'source')], check=True)
            subprocess.run(['git', '-C', str(root / 'source'), '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], check=True)
            sha = subprocess.check_output(['git', '-C', str(root / 'source'), 'rev-parse', 'HEAD'], text=True).strip()
            env = dict(os.environ, GITHUB_OUTPUT=str(root / 'output'), GITHUB_STEP_SUMMARY=str(root / 'summary'), GITHUB_RUN_ID='123', GITHUB_RUN_ATTEMPT='2')
            subprocess.run(['bash', '-euo', 'pipefail', '-c', script('Record deployment identity')], cwd=root, env=env, check=True)
            output = (root / 'output').read_text()
            self.assertIn('sha=' + sha, output)
            self.assertIn(f'version_label=backend-staging-{sha}-123-2', output)
            self.assertIn(sha, (root / 'summary').read_text())

    def test_final_verification_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            aws = root / 'aws'
            aws.write_text('#!/bin/bash\nprintf "%s\\n" "$MOCK_STATE"\nexit "$MOCK_EXIT"\n')
            aws.chmod(0o755)
            env = dict(os.environ, PATH=tmp + ':' + os.environ['PATH'], EB_APPLICATION_NAME='staging-app', EB_ENVIRONMENT_NAME='staging-env', EB_VERSION_LABEL='exact-version', STAGING_GREEN_TIMEOUT_SECONDS='0', GITHUB_STEP_SUMMARY=str(root / 'summary'))
            for state, code, success in [('Ready\tGreen\texact-version', '0', True), ('Ready\tGreen\told-version', '0', False), ('Ready\tRed\texact-version', '0', False), ('Ready\tYellow\texact-version', '0', False), ('Updating\tGreen\texact-version', '0', False), ('None', '0', False), ('', '0', False), ('Ready\tGreen\texact-version', '255', False)]:
                with self.subTest(state=state, code=code):
                    result = subprocess.run(['bash', '-euo', 'pipefail', '-c', script('Confirm staging Ready and Green')], env=dict(env, MOCK_STATE=state, MOCK_EXIT=code), capture_output=True, text=True)
                    self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)

unittest.main(verbosity=2)
PY
