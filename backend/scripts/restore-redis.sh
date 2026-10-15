#!/usr/bin/env bash
#
# Restores Redis from a snapshot taken by backup-redis.sh.
#
# Refuses to run against a Redis instance that already has data (DBSIZE > 0) unless --force
# is passed, because the restore replaces all data: a mistyped target here is unrecoverable.
#
# Usage:
#   scripts/restore-redis.sh --file <snapshot-dir> [--target-url <url>] [--force] [--verify-only]
#
# Environment:
#   REDIS_URL              target connection string, when --target-url is not given
#   REDIS_CONTAINER        container name to copy files into. Default: trustflow-redis
#   REDIS_DATA_DIR         in-container data dir. Default: /data
#
# Exit codes:
#   0  restored (or verified) successfully
#   1  usage / environment error
#   2  checksum or integrity failure — the snapshot must not be trusted
#   3  restore failed

set -euo pipefail

SNAPSHOT_DIR=""
TARGET_URL="${REDIS_URL:-}"
REDIS_CONTAINER="${REDIS_CONTAINER:-trustflow-redis}"
REDIS_DATA_DIR="${REDIS_DATA_DIR:-/data}"
FORCE=0
VERIFY_ONLY=0

log() { echo "[restore-redis $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
fail() { echo "Error: $*" >&2; exit "${2:-1}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --file) SNAPSHOT_DIR="${2:-}"; shift 2 ;;
    --target-url) TARGET_URL="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

[ -n "$SNAPSHOT_DIR" ] || fail "--file is required"
[ -d "$SNAPSHOT_DIR" ] || fail "snapshot directory not found: $SNAPSHOT_DIR" 1

if ! command -v redis-cli >/dev/null 2>&1; then
  fail "redis-cli not found on PATH. Install the Redis client (redis-tools)." 1
fi

# Step 1: verify integrity before touching the target. A corrupt dump.rdb would otherwise
# fail partway through, leaving the target in an undefined state.
CHECKSUM_FILE="${SNAPSHOT_DIR}/manifest.sha256"
if [ -f "$CHECKSUM_FILE" ]; then
  log "Verifying checksum"
  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$SNAPSHOT_DIR" && sha256sum -c manifest.sha256)
  else
    (cd "$SNAPSHOT_DIR" && shasum -a 256 -c manifest.sha256)
  fi
else
  log "WARNING: no manifest.sha256 in snapshot; skipping integrity verification"
fi

# Step 2: verify the snapshot contains a valid dump.rdb
DUMP_FILE="${SNAPSHOT_DIR}/dump.rdb"
[ -f "$DUMP_FILE" ] || fail "dump.rdb not found in snapshot directory" 2
[ -s "$DUMP_FILE" ] || fail "dump.rdb is empty; refusing to restore" 2

log "Verifying dump.rdb structure"
# Redis RDB files start with the magic string "REDIS" followed by a 4-digit version
if ! head -c 9 "$DUMP_FILE" | grep -q '^REDIS[0-9]\{4\}'; then
  fail "dump.rdb does not have a valid RDB header; refusing to restore" 2
fi

# Extract expected dbsize from meta file if available
EXPECTED_DBSIZE=""
if [ -f "${SNAPSHOT_DIR}/meta" ]; then
  EXPECTED_DBSIZE="$(grep '^dbsize=' "${SNAPSHOT_DIR}/meta" | cut -d= -f2 || echo "")"
  [ -n "$EXPECTED_DBSIZE" ] && log "Snapshot metadata indicates ${EXPECTED_DBSIZE} keys"
fi

if [ "$VERIFY_ONLY" -eq 1 ]; then
  log "Snapshot verified; --verify-only set, nothing was written"
  exit 0
fi

[ -n "$TARGET_URL" ] || fail "no target: pass --target-url or set REDIS_URL" 1

# Step 3: refuse to clobber a populated Redis without explicit consent
log "Checking target Redis database"
if ! redis-cli -u "$TARGET_URL" PING >/dev/null 2>&1; then
  fail "cannot connect to target Redis at ${TARGET_URL}" 1
fi

DBSIZE="$(redis-cli -u "$TARGET_URL" DBSIZE 2>/dev/null | tr -d '\r' || echo unknown)"
if [ "$DBSIZE" != "0" ] && [ "$DBSIZE" != "(empty array)" ] && [ "$FORCE" -eq 0 ]; then
  fail "target database has ${DBSIZE} keys. Re-run with --force to flush and replace them." 1
fi

# Step 4: restore via container copy when available, otherwise instruct manual restore
if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$REDIS_CONTAINER"; then
  log "Stopping Redis container ${REDIS_CONTAINER}"
  docker compose stop redis 2>/dev/null || docker stop "$REDIS_CONTAINER" || fail "failed to stop Redis container" 3

  log "Copying dump.rdb into container"
  docker cp "$DUMP_FILE" "${REDIS_CONTAINER}:${REDIS_DATA_DIR}/dump.rdb" || fail "failed to copy dump.rdb" 3

  # Copy appendonlydir if present in snapshot
  if [ -d "${SNAPSHOT_DIR}/appendonlydir" ]; then
    log "Copying appendonlydir into container"
    docker cp "${SNAPSHOT_DIR}/appendonlydir" "${REDIS_CONTAINER}:${REDIS_DATA_DIR}/appendonlydir" || {
      log "WARNING: failed to copy appendonlydir; continuing with RDB only"
    }
  fi

  log "Starting Redis container"
  docker compose start redis 2>/dev/null || docker start "$REDIS_CONTAINER" || fail "failed to start Redis container" 3

  log "Waiting for Redis to become available"
  for i in $(seq 1 30); do
    if redis-cli -u "$TARGET_URL" PING >/dev/null 2>&1; then
      break
    fi
    [ "$i" -lt 30 ] || fail "Redis did not become available within 30s" 3
    sleep 1
  done

else
  log "No local Docker container found. Manual restore required:"
  log "  1. Stop Redis: docker compose stop redis  OR  systemctl stop redis"
  log "  2. Copy dump.rdb: cp ${DUMP_FILE} /path/to/redis/data/dump.rdb"
  if [ -d "${SNAPSHOT_DIR}/appendonlydir" ]; then
    log "  3. Copy appendonlydir: cp -r ${SNAPSHOT_DIR}/appendonlydir /path/to/redis/data/"
    log "  4. Start Redis: docker compose start redis  OR  systemctl start redis"
  else
    log "  3. Start Redis: docker compose start redis  OR  systemctl start redis"
  fi
  fail "Automatic restore via container not available; follow manual steps above" 1
fi

# Step 5: verify restore was successful
log "Verifying restored database"
if ! redis-cli -u "$TARGET_URL" PING >/dev/null 2>&1; then
  fail "Redis is not responding after restore" 3
fi

RESTORED_DBSIZE="$(redis-cli -u "$TARGET_URL" DBSIZE 2>/dev/null | tr -d '\r' || echo 0)"
log "Restored database has ${RESTORED_DBSIZE} keys"

if [ "$RESTORED_DBSIZE" = "0" ]; then
  fail "restore reported success but Redis has no keys" 3
fi

if [ -n "$EXPECTED_DBSIZE" ] && [ "$EXPECTED_DBSIZE" != "unknown" ]; then
  if [ "$RESTORED_DBSIZE" != "$EXPECTED_DBSIZE" ]; then
    log "WARNING: restored ${RESTORED_DBSIZE} keys but snapshot metadata indicated ${EXPECTED_DBSIZE}"
    log "WARNING: this may be normal if the snapshot was taken while writes were in progress"
  else
    log "Restored key count matches snapshot metadata (${EXPECTED_DBSIZE})"
  fi
fi

log "Done"
