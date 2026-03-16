#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ML_DIR="$ROOT_DIR/ml_service"
VENV_DIR="$ML_DIR/.venv"
PYTHON_BIN="${PYTHON_BIN:-python3}"
INSTALL_MODE="${ML_INSTALL_MODE:-base}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "Python not found: $PYTHON_BIN" >&2
  exit 1
fi

rm -rf "$VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip setuptools wheel

if [[ "$INSTALL_MODE" == "full" ]]; then
  python -m pip install -r "$ML_DIR/requirements.txt"
elif [[ "$INSTALL_MODE" == "ocr" ]]; then
  python -m pip install -r "$ML_DIR/requirements-ocr.txt"
else
  python -m pip install -r "$ML_DIR/requirements-base.txt"
fi

echo "ML service environment ready at $VENV_DIR ($INSTALL_MODE mode)"
