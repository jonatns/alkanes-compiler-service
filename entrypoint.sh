#!/bin/bash
set -e

echo "🔧 Checking Rust toolchain..."
export PATH="/usr/local/cargo/bin:$PATH"

if command -v cargo >/dev/null 2>&1; then
  echo "✅ cargo found: $(cargo --version)"
else
  echo "🚨 cargo not found!"
  exit 1
fi

echo "🦀 rustc version: $(rustc --version)"
echo "🪶 Starting compiler service..."
exec node dist/index.js