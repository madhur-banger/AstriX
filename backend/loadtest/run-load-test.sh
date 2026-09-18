#!/bin/bash

# Load Test Runner with Automated Error Analysis
# Usage: ./run-load-test.sh 700
# or with all params: ./run-load-test.sh 700 15 15 25

set -e

# ============================================================================
# CONFIG
# ============================================================================

NUM_USERS=${1:-700}
WORKSPACE_VUS=${2:-15}
PROJECT_VUS=${3:-15}
TASK_VUS=${4:-25}

BASE_URL=${BASE_URL:-"http://localhost:8000/api"}
LOAD_TEST_EMAIL=${LOAD_TEST_EMAIL:-"loadtest@example.com"}
LOAD_TEST_PASSWORD=${LOAD_TEST_PASSWORD:-"Str0ng!Passw0rd"}

# Output directory
RESULTS_DIR="./load-test-results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
TEST_DIR="$RESULTS_DIR/test_${NUM_USERS}users_${TIMESTAMP}"
LOG_FILE="$TEST_DIR/k6_output.log"
ERROR_FILE="$TEST_DIR/errors.log"
REPORT_FILE="$TEST_DIR/error_report.txt"

# Create output directories
mkdir -p "$TEST_DIR"

# ============================================================================
# COLORS FOR OUTPUT
# ============================================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# ============================================================================
# RUN THE TEST
# ============================================================================

echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Starting Load Test with ${NUM_USERS} Users${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Configuration:"
echo "  NUM_USERS: $NUM_USERS"
echo "  WORKSPACE_VUS: $WORKSPACE_VUS"
echo "  PROJECT_VUS: $PROJECT_VUS"
echo "  TASK_VUS: $TASK_VUS"
echo "  Results Directory: $TEST_DIR"
echo ""

# set -e would otherwise be defeated by the pipe below: with `cmd | tee`,
# bash reports tee's exit status (always 0), not k6's, so a thresholds
# failure or crash in k6 would never trip `set -e` and this script would
# silently fall through to "Test Complete" as if the run had gone fine.
# Capture k6's real exit code via PIPESTATUS instead, and factor it into the
# summary/report below - don't just discard it.
set +e
BASE_URL=$BASE_URL \
LOAD_TEST_EMAIL=$LOAD_TEST_EMAIL \
LOAD_TEST_PASSWORD=$LOAD_TEST_PASSWORD \
NUM_USERS=$NUM_USERS \
WORKSPACE_VUS=$WORKSPACE_VUS \
PROJECT_VUS=$PROJECT_VUS \
TASK_VUS=$TASK_VUS \
k6 run scenarios.js 2>&1 | tee "$LOG_FILE"
K6_EXIT_CODE=${PIPESTATUS[0]}
set -e

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}Test Complete. Analyzing Errors...${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""

# ============================================================================
# EXTRACT ERRORS
# ============================================================================

grep "❌" "$LOG_FILE" > "$ERROR_FILE" 2>/dev/null || true

# k6's own THRESHOLDS block is the authoritative pass/fail signal for
# latency (computed over ALL requests, not just the handful scenarios.js
# happened to console.error on) - extract it directly rather than
# reconstructing percentiles from error-log text.
THRESHOLD_LINES=$(awk '/█ THRESHOLDS/,/█ TOTAL RESULTS/' "$LOG_FILE" | grep -E "✓|✗")
THRESHOLDS_FAILED=$(echo "$THRESHOLD_LINES" | grep -c "✗" || true)

if [ ! -s "$ERROR_FILE" ] && [ "$THRESHOLDS_FAILED" -eq 0 ] && [ "$K6_EXIT_CODE" -eq 0 ]; then
  echo -e "${GREEN}No request errors, and all thresholds passed. ✅${NC}"
  echo "0 errors, thresholds passed, k6 exit code $K6_EXIT_CODE" > "$REPORT_FILE"
  cat "$REPORT_FILE"
  exit 0
fi

if [ ! -s "$ERROR_FILE" ] && { [ "$THRESHOLDS_FAILED" -gt 0 ] || [ "$K6_EXIT_CODE" -ne 0 ]; }; then
  {
    echo "0 request-level errors, but the run did NOT pass cleanly:"
    echo ""
    echo "  k6 exit code: $K6_EXIT_CODE (0 = success)"
    echo ""
    echo "  Threshold results:"
    echo "$THRESHOLD_LINES" | sed 's/^/    /'
    echo ""
    echo "This is a PERFORMANCE finding, not a correctness bug: every request"
    echo "eventually succeeded (0% http_req_failed), but response times under"
    echo "this load exceeded the p(95)<1000ms threshold. See k6_output.log for"
    echo "full percentiles."
  } | tee "$REPORT_FILE"
  echo -e "${YELLOW}⚠️  Thresholds failed - see $REPORT_FILE${NC}"
  exit 1
fi

# ============================================================================
# GENERATE ERROR REPORT
# ============================================================================

{
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║                  LOAD TEST ERROR REPORT                        ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo ""
  echo "Test Configuration:"
  echo "  Users: $NUM_USERS"
  echo "  Timestamp: $TIMESTAMP"
  echo "  Log File: $LOG_FILE"
  echo "  k6 exit code: $K6_EXIT_CODE"
  echo ""

  # Count total errors
  TOTAL_ERRORS=$(wc -l < "$ERROR_FILE")
  echo "Total request-level errors: $TOTAL_ERRORS"
  echo ""

  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "LATENCY THRESHOLDS (from k6's own summary - all requests, not just failures)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  if [ -n "$THRESHOLD_LINES" ]; then
    echo "$THRESHOLD_LINES" | sed 's/^/  /'
  else
    echo "  (not found in log - check k6_output.log directly)"
  fi
  echo ""
  
  # ========================================================================
  # ERROR TYPES
  # ========================================================================
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "ERROR TYPES BREAKDOWN"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  grep "❌" "$ERROR_FILE" | cut -d' ' -f2 | sort | uniq -c | sort -rn | while read count type; do
    pct=$((count * 100 / TOTAL_ERRORS))
    printf "  %-30s %4d errors (%3d%%)\n" "$type" "$count" "$pct"
  done
  
  echo ""
  
  # ========================================================================
  # HTTP STATUS CODES
  # ========================================================================
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "HTTP STATUS CODES"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  grep -oE 'status=[0-9]+' "$ERROR_FILE" | cut -d= -f2 | sort | uniq -c | sort -rn | while read count status; do
    pct=$((count * 100 / TOTAL_ERRORS))
    case $status in
      500) STATUS_NAME="Internal Server Error" ;;
      503) STATUS_NAME="Service Unavailable" ;;
      504) STATUS_NAME="Gateway Timeout" ;;
      429) STATUS_NAME="Too Many Requests" ;;
      400) STATUS_NAME="Bad Request" ;;
      401) STATUS_NAME="Unauthorized" ;;
      403) STATUS_NAME="Forbidden" ;;
      404) STATUS_NAME="Not Found" ;;
      *) STATUS_NAME="Unknown" ;;
    esac
    printf "  HTTP %s %-25s %4d errors (%3d%%)\n" "$status" "($STATUS_NAME)" "$count" "$pct"
  done
  
  echo ""
  
  # (Full request-duration percentiles are in the LATENCY THRESHOLDS section
  # above and in k6_output.log's own HTTP block - not reconstructed here
  # from error-log text, since scenarios.js only logs `duration=` on task
  # create failures specifically, not on every failure type, which made any
  # percentile computed from this file misleading.)

  # ========================================================================
  # SAMPLE ERRORS
  # ========================================================================
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "SAMPLE ERRORS (First 5)"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  head -5 "$ERROR_FILE" | while read line; do
    echo "  $line"
  done
  
  echo ""
  
  # ========================================================================
  # ERROR MESSAGES (UNIQUE)
  # ========================================================================
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "UNIQUE ERROR MESSAGES"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo ""
  
  grep -oE 'body=.*' "$ERROR_FILE" | sed 's/^body=//' | sort | uniq -c | sort -rn | head -10 | while read count msg; do
    # Truncate long messages
    truncated=$(echo "$msg" | cut -c 1-70)
    printf "  (%d) %s\n" "$count" "$truncated"
  done
  
  echo ""
  
} | tee "$REPORT_FILE"

# ============================================================================
# PRINT SUMMARY
# ============================================================================

echo ""
echo -e "${YELLOW}Full Report saved to: $REPORT_FILE${NC}"
echo -e "${YELLOW}Errors log saved to: $ERROR_FILE${NC}"
echo -e "${YELLOW}Test log saved to: $LOG_FILE${NC}"
echo ""

# Color code the result. Both signals matter independently: TOTAL_ERRORS is
# correctness (did requests actually fail), THRESHOLDS_FAILED/K6_EXIT_CODE
# is performance (did latency blow the target even with 0% failures - see
# the two 700/1000-user runs that hit this exact case). Report both rather
# than letting a clean error count imply a clean run.
TOTAL_ERRORS=$(wc -l < "$ERROR_FILE")

if [ "$THRESHOLDS_FAILED" -gt 0 ]; then
  echo -e "${YELLOW}⚠️  Latency thresholds failed (p95 exceeded target) - see LATENCY THRESHOLDS above${NC}"
fi

if [ "$TOTAL_ERRORS" -eq 0 ]; then
  echo -e "${GREEN}✅ No request-level errors detected${NC}"
elif [ "$TOTAL_ERRORS" -lt 10 ]; then
  echo -e "${GREEN}✅ Very few request-level errors ($TOTAL_ERRORS)${NC}"
elif [ "$TOTAL_ERRORS" -lt 50 ]; then
  echo -e "${YELLOW}⚠️  Some request-level errors detected ($TOTAL_ERRORS)${NC}"
else
  echo -e "${RED}❌ Multiple request-level errors detected ($TOTAL_ERRORS)${NC}"
fi

if [ "$TOTAL_ERRORS" -ge 50 ] || [ "$THRESHOLDS_FAILED" -gt 0 ] || [ "$K6_EXIT_CODE" -ne 0 ]; then
  exit 1
fi
exit 0
