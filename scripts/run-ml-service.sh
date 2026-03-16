#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ML_DIR="$ROOT_DIR/ml_service"
VENV_DIR="$ML_DIR/.venv"
ML_PORT="${ML_SERVICE_PORT:-8001}"
ML_HOST="${ML_SERVICE_HOST:-0.0.0.0}"

cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a
  source "$ROOT_DIR/.env"
  set +a
fi

if [[ -f "$VENV_DIR/bin/activate" ]]; then
  source "$VENV_DIR/bin/activate"
fi

exec uvicorn ml_service.app:app --host "$ML_HOST" --port "$ML_PORT"
