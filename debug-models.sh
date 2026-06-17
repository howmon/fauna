#!/bin/bash
# Quick test script to check model availability

echo "=== Fauna Model Discovery Debug ==="
echo ""
echo "Testing your current model availability..."
echo ""

# Check if Fauna is running
if ! curl -s http://localhost:5556/ > /dev/null 2>&1; then
  echo "❌ Fauna app is not running on localhost:5556"
  echo "   Start the app first with: npm start"
  exit 1
fi

echo "✓ Fauna is running"
echo ""

# Call debug endpoint
echo "Fetching model discovery info..."
RESPONSE=$(curl -s http://localhost:5556/api/models/debug)

echo ""
echo "=== Results ==="
echo ""

# Parse and display
TOKEN_STATUS=$(echo "$RESPONSE" | grep -o '"tokenStatus":"[^"]*"' | cut -d'"' -f4)
HAS_PAT=$(echo "$RESPONSE" | grep -o '"hasPat":[^,]*' | cut -d':' -f2)
FILTERED_COUNT=$(echo "$RESPONSE" | grep -o '"filteredCount":[0-9]*' | cut -d':' -f2)
FALLBACK_COUNT=$(echo "$RESPONSE" | grep -o '"fallbackCount":[0-9]*' | cut -d':' -f2)

echo "Authentication:"
echo "  Token Status: $TOKEN_STATUS"
echo "  Has PAT: $HAS_PAT"
echo ""

echo "Model Availability:"
echo "  Live API filtered models: $FILTERED_COUNT"
echo "  Fallback models: $FALLBACK_COUNT"
echo ""

# Check for errors
ERROR=$(echo "$RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
API_ERROR=$(echo "$RESPONSE" | grep -o '"liveApiStatus":"[^"]*"' | cut -d'"' -f4)

if [ -n "$ERROR" ]; then
  echo "⚠️  Error: $ERROR"
  echo "   Fauna will use fallback models ($FALLBACK_COUNT models)"
elif [ -n "$API_ERROR" ]; then
  echo "⚠️  Live API Error: $API_ERROR"
  echo "   Fauna will use fallback models ($FALLBACK_COUNT models)"
elif [ "$FILTERED_COUNT" -eq 0 ]; then
  echo "⚠️  No models available from live API!"
  echo "   Check rejection reasons in full debug output"
  echo "   Fauna will fall back to $FALLBACK_COUNT hardcoded models"
else
  echo "✓ $FILTERED_COUNT models available from live API"
  echo "✓ Plus $FALLBACK_COUNT fallback models for offline mode"
fi

echo ""
echo "=== Full Debug Output ==="
echo "$RESPONSE" | jq '.' 2>/dev/null || echo "$RESPONSE"

echo ""
echo "=== Tips ==="
echo ""
echo "If models are missing:"
echo "  1. Check 'rejectionReasons' above to see why models were filtered"
echo "  2. If you see 'model_picker_enabled=false (no PAT)', add a PAT:"
echo "     Settings → GitHub → Add Personal Access Token"
echo "  3. If API error (401/403), re-authenticate:"
echo "     gh auth login"
echo "  4. More help: See MODEL_TROUBLESHOOTING.md"
