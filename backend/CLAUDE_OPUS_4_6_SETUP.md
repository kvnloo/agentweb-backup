# Claude Opus 4.6 Setup for Agent Mode

## Current Status

Claude Opus 4.6 support has been added to Agent Mode with model ID: `anthropic.claude-opus-4-6-v1`

However, the exact Bedrock model ID needs to be verified as the test is failing with "The provided model identifier is invalid."

## Setup Steps Required

### 1. Verify the Correct Model ID

The model ID `anthropic.claude-opus-4-6-v1` may not be correct. To find the actual model ID:

```bash
# Using AWS CLI (if bedrock command is available)
aws bedrock list-foundation-models --region us-west-2 --query "modelSummaries[?contains(modelId, 'opus')]"

# Or check in AWS Console:
# https://console.aws.amazon.com/bedrock/home?region=us-west-2#/models
```

Common Claude model ID patterns in Bedrock:
- `anthropic.claude-opus-4-20250514-v1:0` (with date and version)
- `anthropic.claude-4-opus-20250514-v1:0` (alternative naming)
- `us.anthropic.claude-opus-4-v1` (regional prefix)

### 2. Enable Model Access in Bedrock

1. Go to AWS Bedrock Console: https://console.aws.amazon.com/bedrock/
2. Navigate to "Model access" in the left sidebar
3. Click "Manage model access"
4. Find "Claude Opus 4" or "Claude 4 Opus" and enable it
5. Wait for access to be granted (can take a few minutes)

### 3. Check if Inference Profile is Required

Some newer models require using an inference profile ARN instead of the direct model ID. If the model requires an inference profile:

1. Find the inference profile ARN in the Bedrock console under "Cross-region inference"
2. Update the model ID mapping in `agentModeService.ts` (line ~286)

Example:
```typescript
if (modelId === 'anthropic.claude-opus-4-6-v1') {
  actualModelId = 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/us.anthropic.claude-opus-4-v1:0';
}
```

### 4. Update Model ID in Code

Once you have the correct model ID, update it in:

**backend/src/services/agentModeService.ts** (line ~390):
```typescript
'anthropic.claude-opus-4-6-v1': { client: null, supportsTemperature: true },
```

Replace `'anthropic.claude-opus-4-6-v1'` with the correct model ID.

## Testing

After updating the model ID, run the test script:

```bash
cd backend
npx ts-node src/scripts/test-claude-opus-4-6.ts
```

Expected output:
```
✓ Claude Opus 4.6 IS in supported models list
✓ Simple completion successful
✓ Tool calling successful
🎉 All tests passed!
```

## Current Implementation

The implementation includes:

1. **Model Registration** (agentModeService.ts line ~390)
   - Added to llmModels registry with temperature support

2. **Bedrock Client Wrapper** (agentModeService.ts line ~271)
   - OpenAI-compatible interface
   - Tool calling support (essential for Agent Mode)
   - Proper message format conversion
   - Usage tracking

3. **Lazy Loading** (agentModeService.ts line ~459)
   - Client initialized on first use
   - Cached for subsequent calls

## Next Steps

1. Verify the exact Bedrock model ID for Claude Opus 4.6
2. Enable model access in AWS Bedrock Console
3. Update the model ID in the code
4. Run the test script to verify
5. Test in Agent Mode UI

## Notes

- Tool calling is fully supported for Emma's function calls
- Temperature control is enabled
- Token usage is properly tracked
- The model will appear in the Agent Mode model selector once working
