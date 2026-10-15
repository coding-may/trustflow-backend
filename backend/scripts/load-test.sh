#!/usr/bin/env bash
#
# Load Test Runner for TrustFlow Backend
#
# Runs k6 load tests to simulate concurrent users creating escrows,
# checking status, and triggering webhooks. Measures p95 response times
# and identifies connection pool limits and memory bottlenecks.
#
# Prerequisites:
#   - k6 installed (https://k6.io/docs/getting-started/installation/)
#   - Backend API running (locally or remote)
#
# Usage:
#   ./backend/scripts/load-test.sh                    # Run against localhost
#   ./backend/scripts/load-test.sh production         # Run against production
#   BASE_URL=http://localhost:4000 ./backend/scripts/load-test.sh  # Custom URL

set -euo pipefail

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_SCRIPT="${SCRIPT_DIR}/load-test.k6.js"
RESULTS_FILE="${SCRIPT_DIR}/../load-test-results.json"

# Default target
BASE_URL="${BASE_URL:-http://localhost:3000}"
DURATION="${DURATION:-5m}"
VUS="${VUS:-500}"

# Parse arguments
if [[ $# -gt 0 ]]; then
  case "$1" in
    production|prod)
      BASE_URL="https://api.trustflow.xyz"
      echo -e "${YELLOW}⚠️  Warning: Running load test against PRODUCTION${NC}"
      echo -e "${YELLOW}   Make sure you have approval to run load tests in production!${NC}"
      read -p "Continue? (yes/no): " -r
      if [[ ! $REPLY =~ ^[Yy]es$ ]]; then
        echo "Aborted."
        exit 0
      fi
      ;;
    staging)
      BASE_URL="https://staging-api.trustflow.xyz"
      ;;
    local|localhost)
      BASE_URL="http://localhost:3000"
      ;;
    help|--help|-h)
      echo "Usage: $0 [target]"
      echo ""
      echo "Targets:"
      echo "  local       Run against http://localhost:3000 (default)"
      echo "  staging     Run against staging environment"
      echo "  production  Run against production (with confirmation)"
      echo ""
      echo "Environment variables:"
      echo "  BASE_URL    Override target URL"
      echo "  DURATION    Test duration (default: 5m)"
      echo "  VUS         Virtual users (default: 500)"
      echo ""
      echo "Examples:"
      echo "  $0                                    # Local test"
      echo "  $0 staging                            # Staging test"
      echo "  BASE_URL=http://localhost:4000 $0     # Custom URL"
      echo "  DURATION=10m VUS=1000 $0              # Extended test"
      exit 0
      ;;
    *)
      echo -e "${RED}✗ Unknown target: $1${NC}"
      echo "Run '$0 help' for usage information"
      exit 1
      ;;
  esac
fi

# Check if k6 is installed
if ! command -v k6 &> /dev/null; then
  echo -e "${RED}✗ k6 is not installed${NC}"
  echo ""
  echo "Install k6:"
  echo "  macOS:    brew install k6"
  echo "  Linux:    https://k6.io/docs/getting-started/installation/#linux"
  echo "  Windows:  https://k6.io/docs/getting-started/installation/#windows"
  exit 1
fi

echo -e "${BLUE}k6 Load Test - TrustFlow Backend${NC}"
echo "=================================="
echo ""
echo "Target:   ${BASE_URL}"
echo "Duration: ${DURATION}"
echo "VUs:      ${VUS}"
echo ""

# Health check before starting
echo -e "${BLUE}Running pre-flight health check...${NC}"
if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
  echo -e "${GREEN}✓ API is healthy${NC}"
else
  echo -e "${RED}✗ API health check failed${NC}"
  echo "Make sure the backend is running at ${BASE_URL}"
  exit 1
fi

echo ""
echo -e "${BLUE}Starting load test...${NC}"
echo ""

# Run k6 load test
k6 run \
  --vus "${VUS}" \
  --duration "${DURATION}" \
  --env BASE_URL="${BASE_URL}" \
  --out json="${RESULTS_FILE}" \
  "${K6_SCRIPT}"

EXIT_CODE=$?

echo ""
if [[ $EXIT_CODE -eq 0 ]]; then
  echo -e "${GREEN}✓ Load test completed successfully${NC}"
  echo ""
  echo "Results saved to: ${RESULTS_FILE}"
  echo ""
  echo "Key findings:"
  echo "  - Check if p95 latency stayed under 250ms"
  echo "  - Review connection pool behavior under load"
  echo "  - Identify any memory bottlenecks or leaks"
  echo "  - Verify error rates stayed below 10%"
else
  echo -e "${RED}✗ Load test failed or thresholds not met${NC}"
  echo ""
  echo "Common issues:"
  echo "  - p95 latency exceeded 250ms (check database connection pool)"
  echo "  - Error rate exceeded 10% (check logs for failures)"
  echo "  - Request failures exceeded 5% (check backend health)"
fi

exit $EXIT_CODE
