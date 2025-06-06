#!/bin/bash
# Test script for deep-fol-backend endpoints
# Usage: bash test-backend.sh

set -e

API_URL="http://localhost:3001"

# Test /generate endpoint
echo "Testing /generate endpoint..."
RESPONSE=$(curl -s -X POST "$API_URL/generate" -H "Content-Type: application/json" -d '{"prompt": "Say hello!"}')
echo "Response: $RESPONSE"

# Test /index-snippet endpoint
echo "Testing /index-snippet endpoint..."
RESPONSE=$(curl -s -X POST "$API_URL/index-snippet" -H "Content-Type: application/json" -d '{"code": "function test() { return 42; }"}')
echo "Response: $RESPONSE"

# Test /semantic-search endpoint
echo "Testing /semantic-search endpoint..."
RESPONSE=$(curl -s -X POST "$API_URL/semantic-search" -H "Content-Type: application/json" -d '{"query": "function that returns a number"}')
echo "Response: $RESPONSE"

echo "All backend endpoint tests completed."
