#!/usr/bin/env node

/**
 * Test script for the specific user message about Meta ads metrics
 */

async function testSpecificMessage() {
  console.log('🧪 Testing Specific User Message\n');
  
  const baseUrl = 'http://localhost:3001';
  
  try {
    // Step 1: Login
    console.log('Step 1: Logging in...');
    const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'test@example.com',
        password: 'Test123!'
      })
    });
    
    if (!loginResponse.ok) {
      throw new Error(`Login failed: ${loginResponse.status}`);
    }
    
    const loginData = await loginResponse.json();
    const token = loginData.token;
    console.log('✅ Login successful');
    
    // Step 2: Create session
    console.log('\nStep 2: Creating session...');
    const sessionResponse = await fetch(`${baseUrl}/api/agent-mode/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        portalType: 'agent',
        pageIdentifier: 'agent-mode'
      })
    });
    
    const sessionData = await sessionResponse.json();
    console.log('✅ Session created:', sessionData.sessionId);
    
    // Step 3: Test with the specific user message
    console.log('\nStep 3: Testing with specific user message...');
    console.log('User message: get the ads metrics in last 30 days for campaign "Lead Ad Campaign | Landing Page" with breakdowns...');
    
    const response = await fetch(`${baseUrl}/api/agent-mode/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        sessionId: sessionData.sessionId,
        userMessage: `get the ads metrics in last 30 days for campaign "Lead Ad Campaign | Landing Page" with breakdowns of

"breakdowns": ["age", "gender"],
"fields": ["campaign_name", "adset_name", "age", "gender", "impressions", "reach", "spend", "ctr", "cpc", "link_clicks", "quality_ranking", "engagement_rate_ranking", "conversion_rate_ranking"]

show me the breakdowns`
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Request failed: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    console.log('✅ Response received');
    
    // Show the response
    console.log('\n📊 Response:');
    console.log('=' .repeat(80));
    console.log(data.content);
    console.log('=' .repeat(80));
    
    // Check tool calls
    if (data.toolCalls && data.toolCalls.length > 0) {
      console.log('\n🔧 Tool Calls:');
      data.toolCalls.forEach((toolCall, index) => {
        console.log(`Tool ${index + 1}:`, toolCall.function?.name || 'Unknown');
        if (toolCall.function?.name === 'get_meta_ads_metrics') {
          const args = toolCall.function.arguments;
          console.log('  Arguments:', JSON.stringify(args, null, 2));
        }
      });
    }
    
    console.log('\n🎉 Test completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

if (require.main === module) {
  testSpecificMessage().catch(console.error);
}

module.exports = { testSpecificMessage };
