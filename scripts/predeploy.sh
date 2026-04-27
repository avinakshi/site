#!/usr/bin/env sh
# Railway pre-deploy hook. Sequenced explicitly because Railway's
# preDeployCommand array silently drops everything after `&&` when
# given an inline chain. Each step prints its own progress, and any
# non-zero exit aborts the whole hook (set -e).
set -e

echo "[predeploy] migrate"
pnpm --filter @csm-chat/db db:migrate

echo "[predeploy] seed"
pnpm --filter @csm-chat/db db:seed

echo "[predeploy] done"
