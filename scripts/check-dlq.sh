#!/usr/bin/env bash
# Inspect artist delivery queue consumers and tail live Worker logs for DLQ activity.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

QUEUE="${ARTIST_QUEUE_NAME:-telegram-radiojavan-artist-delivery}"
DLQ="${ARTIST_DLQ_NAME:-telegram-radiojavan-artist-delivery-dlq}"
WORKER="${WORKER_NAME:-telegram-radiojavan}"

echo "== Queue consumers: ${QUEUE} =="
npx --yes wrangler@4.103.0 queues consumer list "$QUEUE"

echo
echo "== Queue consumers: ${DLQ} =="
npx --yes wrangler@4.103.0 queues consumer list "$DLQ"

echo
echo "Tip: stalled artist jobs land on ${DLQ} after max_retries."
echo "Watch live delivery/DLQ logs with:"
echo "  npx wrangler tail ${WORKER} --format pretty"
echo
echo "Warm only uncached songs for an artist (writes cache intentionally):"
echo "  curl -X POST \"https://${WORKER}.amirhy.workers.dev/internal/warm-artist\" \\"
echo "    -H \"Authorization: Bearer \$JOB_RUNNER_SECRET\" \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -d '{\"chatId\":\"YOUR_TELEGRAM_USER_ID\",\"artistName\":\"chaartaar\"}'"
