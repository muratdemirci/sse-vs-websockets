#!/usr/bin/env bash
set -euo pipefail

# Usage: ./load-test/run-benchmarks.sh [quick|standard|comprehensive]
#
# Automated benchmark runner for SSE vs WebSocket comparison.
# Runs all test scenarios, saves results, and generates a comparison report.

################################################################################
# Configuration
################################################################################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WS_PORT=3001
SSE_PORT=3002
WS_SERVER="$PROJECT_DIR/server/websocket-server.js"
SSE_SERVER="$PROJECT_DIR/server/sse-server.js"
CLIENT_SIM="$PROJECT_DIR/load-test/client-simulator.js"
COMPARE_SCRIPT="$PROJECT_DIR/load-test/compare-results.js"

WS_PID=""
SSE_PID=""

PROFILE="${1:-standard}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RESULTS_DIR="$PROJECT_DIR/results/$TIMESTAMP"

# Terminal colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

################################################################################
# Profile definitions
################################################################################

case "$PROFILE" in
  quick)
    CLIENT_COUNTS=(100)
    DURATION=15
    RUNS_PER_TEST=1
    ESTIMATED_TIME="~5 minutes"
    ;;
  standard)
    CLIENT_COUNTS=(100 500 1000)
    DURATION=30
    RUNS_PER_TEST=3
    ESTIMATED_TIME="~30 minutes"
    ;;
  comprehensive)
    CLIENT_COUNTS=(100 500 1000 5000)
    DURATION=60
    RUNS_PER_TEST=5
    ESTIMATED_TIME="~3 hours"
    ;;
  *)
    echo -e "${RED}Error: Unknown profile '$PROFILE'${NC}"
    echo "Usage: $0 [quick|standard|comprehensive]"
    echo ""
    echo "Profiles:"
    echo "  quick          100 clients, 15s, 1 run (~5 min)"
    echo "  standard       100/500/1000 clients, 30s, 3 runs (~30 min)"
    echo "  comprehensive  100/500/1000/5000 clients, 60s, 5 runs (~3 hours)"
    exit 1
    ;;
esac

################################################################################
# Utility functions
################################################################################

log_info() {
  echo -e "${BLUE}[INFO]${NC} $*"
}

log_success() {
  echo -e "${GREEN}[OK]${NC} $*"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $*"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $*"
}

log_header() {
  echo ""
  echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo -e "${BOLD}${CYAN}  $*${NC}"
  echo -e "${BOLD}${CYAN}════════════════════════════════════════════════════════════${NC}"
  echo ""
}

log_test() {
  echo -e "${BOLD}${YELLOW}── $* ──${NC}"
}

################################################################################
# Server management
################################################################################

wait_for_server() {
  local port="$1"
  local name="$2"
  local max_attempts=30
  local attempt=0

  while [ $attempt -lt $max_attempts ]; do
    if curl -sf "http://localhost:${port}/metrics" > /dev/null 2>&1; then
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 1
  done

  log_error "$name on port $port did not become ready within ${max_attempts}s"
  return 1
}

start_servers() {
  local extra_args="${1:-}"

  log_info "Starting WebSocket server on port $WS_PORT..."
  # shellcheck disable=SC2086
  node "$WS_SERVER" $extra_args > /dev/null 2>&1 &
  WS_PID=$!

  log_info "Starting SSE server on port $SSE_PORT..."
  # shellcheck disable=SC2086
  node "$SSE_SERVER" $extra_args > /dev/null 2>&1 &
  SSE_PID=$!

  log_info "Waiting for servers to be ready..."
  wait_for_server "$WS_PORT" "WebSocket server"
  wait_for_server "$SSE_PORT" "SSE server"
  log_success "Both servers are ready."
}

stop_servers() {
  if [ -n "$WS_PID" ] && kill -0 "$WS_PID" 2>/dev/null; then
    kill "$WS_PID" 2>/dev/null || true
    wait "$WS_PID" 2>/dev/null || true
    WS_PID=""
  fi

  if [ -n "$SSE_PID" ] && kill -0 "$SSE_PID" 2>/dev/null; then
    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
    SSE_PID=""
  fi

  # Also kill any lingering server processes on our ports
  lsof -ti :"$WS_PORT" 2>/dev/null | xargs kill 2>/dev/null || true
  lsof -ti :"$SSE_PORT" 2>/dev/null | xargs kill 2>/dev/null || true

  sleep 2
}

restart_servers() {
  local extra_args="${1:-}"
  log_info "Restarting servers..."
  stop_servers
  start_servers "$extra_args"
}

################################################################################
# Warmup
################################################################################

run_warmup() {
  local protocol="$1"
  log_info "Warmup: connecting 10 $protocol clients for 5s..."
  node "$CLIENT_SIM" "$protocol" 10 --duration=5 --mode=latency > /dev/null 2>&1 || true
  sleep 2
}

################################################################################
# Test runner
################################################################################

TESTS_COMPLETED=0
TESTS_TOTAL=0

run_test() {
  local protocol="$1"
  local mode="$2"
  local clients="$3"
  local duration="$4"
  local test_name="$5"
  shift 5
  local extra_args=("$@")

  TESTS_COMPLETED=$((TESTS_COMPLETED + 1))
  local pct=$((TESTS_COMPLETED * 100 / TESTS_TOTAL))

  local output_file="$RESULTS_DIR/${test_name}-${protocol}.json"

  log_test "[$TESTS_COMPLETED/$TESTS_TOTAL] ($pct%) ${test_name} | ${protocol} | ${clients} clients | ${duration}s"

  # Build command arguments
  local cmd_args=("$protocol" "$clients" "--duration=$duration" "--mode=$mode")
  for arg in "${extra_args[@]}"; do
    cmd_args+=("$arg")
  done

  # Run warmup
  run_warmup "$protocol"

  # Capture output and save results
  local test_output
  local test_exit_code=0
  test_output=$(node "$CLIENT_SIM" "${cmd_args[@]}" 2>&1) || test_exit_code=$?

  if [ $test_exit_code -ne 0 ]; then
    log_warn "Test exited with code $test_exit_code"
  fi

  # Fetch server metrics
  local metrics_port
  if [ "$protocol" = "websocket" ]; then
    metrics_port=$WS_PORT
  else
    metrics_port=$SSE_PORT
  fi
  local server_metrics
  server_metrics=$(curl -sf "http://localhost:${metrics_port}/metrics" 2>/dev/null || echo '{}')

  # Build result JSON
  cat > "$output_file" <<ENDJSON
{
  "testName": "${test_name}",
  "protocol": "${protocol}",
  "mode": "${mode}",
  "clients": ${clients},
  "duration": ${duration},
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "profile": "${PROFILE}",
  "serverMetrics": ${server_metrics},
  "output": $(echo "$test_output" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
}
ENDJSON

  log_success "Result saved to ${output_file##*/}"
  echo ""
}

################################################################################
# Cleanup / trap handler
################################################################################

cleanup() {
  echo ""
  log_warn "Caught interrupt signal. Cleaning up..."
  stop_servers
  if [ -d "$RESULTS_DIR" ] && [ "$(ls -A "$RESULTS_DIR" 2>/dev/null)" ]; then
    log_info "Partial results saved in $RESULTS_DIR"
  fi
  exit 130
}

trap cleanup SIGINT SIGTERM

################################################################################
# Calculate total test count
################################################################################

calculate_total_tests() {
  # Test types: latency, broadcast, latency(echo), broadcast(throughput),
  #             latency(payload-sweep per size), scalability, latency(connection-cost),
  #             latency(reconnection), latency(churn)
  # Each test type x 2 protocols x client_counts x runs_per_test
  local num_clients=${#CLIENT_COUNTS[@]}
  local payload_sizes=4  # 64, 256, 1024, 16384

  # Per client count, per run:
  #   1. baseline-latency (2 protocols)
  #   2. broadcast (2 protocols)
  #   3. echo (2 protocols)
  #   4. throughput (2 protocols)
  #   5. payload-sweep: 4 sizes x 2 protocols = 8
  #   6. scalability (2 protocols)
  #   7. connection-cost (2 protocols)
  #   8. reconnection (2 protocols)
  #   9. churn (2 protocols)
  # = (8 tests x 2 protocols) + (4 sizes x 2 protocols) = 16 + 8 = 24 per client_count per run

  local tests_per_client_per_run=$(( 8 * 2 + payload_sizes * 2 ))
  TESTS_TOTAL=$(( tests_per_client_per_run * num_clients * RUNS_PER_TEST ))
}

################################################################################
# Main benchmark sequence
################################################################################

main() {
  log_header "SSE vs WebSocket Benchmark Suite"
  echo -e "  Profile:        ${BOLD}${PROFILE}${NC}"
  echo -e "  Client counts:  ${BOLD}${CLIENT_COUNTS[*]}${NC}"
  echo -e "  Duration:       ${BOLD}${DURATION}s${NC} per test"
  echo -e "  Runs per test:  ${BOLD}${RUNS_PER_TEST}${NC}"
  echo -e "  Estimated time: ${BOLD}${ESTIMATED_TIME}${NC}"
  echo -e "  Results dir:    ${BOLD}${RESULTS_DIR}${NC}"
  echo ""

  mkdir -p "$RESULTS_DIR"

  calculate_total_tests
  log_info "Total tests to run: $TESTS_TOTAL"
  echo ""

  local start_time
  start_time=$(date +%s)

  for run in $(seq 1 "$RUNS_PER_TEST"); do
    log_header "Run $run of $RUNS_PER_TEST"

    for clients in "${CLIENT_COUNTS[@]}"; do
      local run_suffix=""
      if [ "$RUNS_PER_TEST" -gt 1 ]; then
        run_suffix="-run${run}"
      fi

      # ── 1. Baseline Latency ──────────────────────────────────────────
      log_header "1. Baseline Latency - ${clients} clients"
      restart_servers
      for proto in websocket sse; do
        run_test "$proto" "latency" "$clients" "$DURATION" \
          "baseline-latency-${clients}${run_suffix}"
      done

      # ── 2. High-Frequency Broadcast ──────────────────────────────────
      log_header "2. High-Frequency Broadcast - ${clients} clients"
      restart_servers "--rate=50"
      for proto in websocket sse; do
        run_test "$proto" "broadcast" "$clients" "$DURATION" \
          "broadcast-${clients}${run_suffix}"
      done

      # ── 3. Echo Round-Trip ───────────────────────────────────────────
      log_header "3. Echo Round-Trip - ${clients} clients"
      restart_servers
      for proto in websocket sse; do
        run_test "$proto" "latency" "$clients" "$DURATION" \
          "echo-${clients}${run_suffix}"
      done

      # ── 4. Throughput Ramp ───────────────────────────────────────────
      log_header "4. Throughput Ramp - ${clients} clients"
      restart_servers "--rate=100"
      for proto in websocket sse; do
        run_test "$proto" "broadcast" "$clients" "$DURATION" \
          "throughput-${clients}${run_suffix}"
      done

      # ── 5. Payload Sweep ─────────────────────────────────────────────
      log_header "5. Payload Sweep - ${clients} clients"
      for size in 64 256 1024 16384; do
        restart_servers "--message-size=$size"
        for proto in websocket sse; do
          run_test "$proto" "latency" "$clients" "$DURATION" \
            "payload-${size}b-${clients}${run_suffix}" \
            "--message-size=$size"
        done
      done

      # ── 6. Scalability ──────────────────────────────────────────────
      log_header "6. Scalability - ${clients} clients"
      restart_servers
      for proto in websocket sse; do
        run_test "$proto" "scalability" "$clients" "$DURATION" \
          "scalability-${clients}${run_suffix}"
      done

      # ── 7. Connection Cost ───────────────────────────────────────────
      log_header "7. Connection Cost - ${clients} clients"
      restart_servers
      for proto in websocket sse; do
        run_test "$proto" "latency" "$clients" 5 \
          "connection-cost-${clients}${run_suffix}"
      done

      # ── 8. Reconnection ─────────────────────────────────────────────
      log_header "8. Reconnection - ${clients} clients"
      restart_servers
      for proto in websocket sse; do
        run_test "$proto" "latency" "$clients" "$DURATION" \
          "reconnection-${clients}${run_suffix}"
      done

      # ── 9. Churn ─────────────────────────────────────────────────────
      log_header "9. Churn - ${clients} clients"
      restart_servers
      for proto in websocket sse; do
        run_test "$proto" "latency" "$clients" "$DURATION" \
          "churn-${clients}${run_suffix}"
      done

    done
  done

  # ── Final cleanup and report ───────────────────────────────────────
  stop_servers

  local end_time
  end_time=$(date +%s)
  local elapsed=$(( end_time - start_time ))
  local minutes=$(( elapsed / 60 ))
  local seconds=$(( elapsed % 60 ))

  log_header "Benchmark Complete"
  echo -e "  Total time:  ${BOLD}${minutes}m ${seconds}s${NC}"
  echo -e "  Results dir: ${BOLD}${RESULTS_DIR}${NC}"
  echo -e "  Tests run:   ${BOLD}${TESTS_COMPLETED}${NC}"
  echo ""

  # Generate comparison report
  log_info "Generating comparison report..."
  if [ -f "$COMPARE_SCRIPT" ]; then
    node "$COMPARE_SCRIPT" "$RESULTS_DIR" || log_warn "Comparison script failed"
  else
    log_warn "Comparison script not found at $COMPARE_SCRIPT"
  fi

  log_success "All done! Results are in $RESULTS_DIR"
}

main
