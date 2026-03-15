#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

rsvg-convert -w 256 -h 256 "$ROOT_DIR/assets/icon.svg" -o "$ROOT_DIR/assets/icon.png"
rsvg-convert -w 1280 -h 720 "$ROOT_DIR/assets/marketplace-hero.svg" -o "$ROOT_DIR/assets/marketplace-hero.png"
