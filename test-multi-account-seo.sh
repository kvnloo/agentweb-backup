#!/bin/bash

# Manual Test Script for Multiple GSC/GA4/Clarity Account Support
# This script provides commands to test the feature manually

set -e

BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
TEST_USER_ID="${TEST_USER_ID:-}"

echo "=================================="
echo "Multi-Account SEO Testing Script"
echo "=================================="
echo ""
echo "Prerequisites:"
echo "1. Backend running at: $BACKEND_URL"
echo "2. Admin token set: ${ADMIN_TOKEN:+✓}${ADMIN_TOKEN:-✗ (not set)}"
echo "3. Test user ID set: ${TEST_USER_ID:+✓}${TEST_USER_ID:-✗ (not set)}"
echo ""

if [ -z "$ADMIN_TOKEN" ] || [ -z "$TEST_USER_ID" ]; then
    echo "ERROR: Please set ADMIN_TOKEN and TEST_USER_ID environment variables"
    echo ""
    echo "Example:"
    echo "  export ADMIN_TOKEN='your-admin-jwt-token'"
    echo "  export TEST_USER_ID='user-123'"
    echo "  ./test-multi-account-seo.sh"
    exit 1
fi

echo "=================================="
echo "Test 1: Configure Multiple GA4 Properties"
echo "=================================="
echo ""
echo "Sending request to configure multiple GA4 properties..."

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT \
  "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}/seo-aeo" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "seoDomains": ["example.com", "test.com"],
    "googleAnalyticsProperties": [
      { "propertyId": "123456789", "label": "Main Website" },
      { "propertyId": "987654321", "label": "Product Site" }
    ],
    "gaFilteredDomains": ["app.example.com", "admin.example.com"],
    "clarityProjects": [
      { "projectId": "ul13e4f7fe", "label": "Main Site Clarity" },
      { "projectId": "xk9f2d8a1b", "label": "Product Clarity" }
    ],
    "productDomain": "app.example.com"
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

echo "Status: $HTTP_STATUS"
echo "Response:"
echo "$BODY" | jq '.' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✓ Configuration saved successfully"
else
    echo "✗ Configuration failed"
fi

echo ""
echo "=================================="
echo "Test 2: Verify Configuration Persisted"
echo "=================================="
echo ""
echo "Fetching user configuration..."

RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X GET \
  "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}")

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

echo "Status: $HTTP_STATUS"
echo "Response (relevant fields):"
echo "$BODY" | jq '{
  seoDomains: .seoDomains,
  googleAnalyticsProperties: .googleAnalyticsProperties,
  clarityProjects: .clarityProjects,
  gaFilteredDomains: .gaFilteredDomains,
  productDomain: .productDomain
}' 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✓ Configuration retrieved successfully"

    # Check if arrays exist
    if echo "$BODY" | jq -e '.googleAnalyticsProperties | length > 0' >/dev/null 2>&1; then
        GA_COUNT=$(echo "$BODY" | jq '.googleAnalyticsProperties | length')
        echo "✓ Found $GA_COUNT GA4 properties"
    fi

    if echo "$BODY" | jq -e '.clarityProjects | length > 0' >/dev/null 2>&1; then
        CLARITY_COUNT=$(echo "$BODY" | jq '.clarityProjects | length')
        echo "✓ Found $CLARITY_COUNT Clarity projects"
    fi
else
    echo "✗ Configuration retrieval failed"
fi

echo ""
echo "=================================="
echo "Test 3: Validation Tests"
echo "=================================="
echo ""

echo "Test 3a: Duplicate Property IDs (should fail)"
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT \
  "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}/seo-aeo" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "googleAnalyticsProperties": [
      { "propertyId": "123456789", "label": "Site 1" },
      { "propertyId": "123456789", "label": "Site 2" }
    ]
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

if [ "$HTTP_STATUS" = "400" ]; then
    echo "✓ Duplicate validation works (rejected as expected)"
    echo "   Error: $(echo "$BODY" | jq -r '.message' 2>/dev/null || echo "$BODY")"
else
    echo "✗ Duplicate validation failed (should have rejected)"
fi

echo ""
echo "Test 3b: Invalid Property ID Format (should fail)"
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT \
  "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}/seo-aeo" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "googleAnalyticsProperties": [
      { "propertyId": "G-XXXXXXXXX", "label": "Invalid Format" }
    ]
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

if [ "$HTTP_STATUS" = "400" ]; then
    echo "✓ Format validation works (rejected as expected)"
    echo "   Error: $(echo "$BODY" | jq -r '.message' 2>/dev/null || echo "$BODY")"
else
    echo "✗ Format validation failed (should have rejected)"
fi

echo ""
echo "Test 3c: Missing Label (should fail)"
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT \
  "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}/seo-aeo" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "googleAnalyticsProperties": [
      { "propertyId": "123456789", "label": "" }
    ]
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_STATUS/d')

if [ "$HTTP_STATUS" = "400" ]; then
    echo "✓ Label validation works (rejected as expected)"
    echo "   Error: $(echo "$BODY" | jq -r '.message' 2>/dev/null || echo "$BODY")"
else
    echo "✗ Label validation failed (should have rejected)"
fi

echo ""
echo "=================================="
echo "Test 4: Migration from Legacy Format"
echo "=================================="
echo ""

echo "Configuring with legacy single values only..."
RESPONSE=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X PUT \
  "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}/seo-aeo" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "seoDomains": ["legacy.com"],
    "googleAnalyticsPropertyId": "111111111",
    "clarityProjectId": "legacyproj",
    "productDomain": "app.legacy.com"
  }')

HTTP_STATUS=$(echo "$RESPONSE" | grep "HTTP_STATUS" | cut -d: -f2)

if [ "$HTTP_STATUS" = "200" ]; then
    echo "✓ Legacy format accepted"

    # Verify it was stored
    VERIFY_RESPONSE=$(curl -s "${BACKEND_URL}/api/admin/users/${TEST_USER_ID}" \
      -H "Authorization: Bearer ${ADMIN_TOKEN}")

    if echo "$VERIFY_RESPONSE" | jq -e '.googleAnalyticsPropertyId' >/dev/null 2>&1; then
        LEGACY_ID=$(echo "$VERIFY_RESPONSE" | jq -r '.googleAnalyticsPropertyId')
        echo "✓ Legacy googleAnalyticsPropertyId stored: $LEGACY_ID"
    fi

    if echo "$VERIFY_RESPONSE" | jq -e '.clarityProjectId' >/dev/null 2>&1; then
        LEGACY_CLARITY=$(echo "$VERIFY_RESPONSE" | jq -r '.clarityProjectId')
        echo "✓ Legacy clarityProjectId stored: $LEGACY_CLARITY"
    fi
else
    echo "✗ Legacy format rejected (should be accepted)"
fi

echo ""
echo "=================================="
echo "Test Summary"
echo "=================================="
echo ""
echo "All tests completed. Review the results above."
echo ""
echo "Next steps:"
echo "1. Test the partner portal UI at http://localhost:5173"
echo "   - Navigate to Users tab"
echo "   - Click Edit on SEO/AEO for test user"
echo "   - Verify multiple GA4 and Clarity entries appear"
echo "   - Try adding/removing entries"
echo ""
echo "2. Test the customer portal UI at http://localhost:5174"
echo "   - Log in as test user"
echo "   - Navigate to SEO/GEO page"
echo "   - Verify dropdown appears if multiple properties configured"
echo "   - Switch between properties and verify metrics update"
echo ""
