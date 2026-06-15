#!/usr/bin/env bash
# publish.sh — Publica @romatech/orm-providers-mysql no npm.
# Requer: npm login (previamente autenticado)
# Uso: ./publish.sh [--dry-run]

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN="${1:-}"
NPM_FLAGS=""
[ "$DRY_RUN" = "--dry-run" ] && NPM_FLAGS="--dry-run"

echo "Publishing @romatech/orm-providers-mysql..."
cd "$DIR"
npm publish --access public $NPM_FLAGS
echo "Done."
