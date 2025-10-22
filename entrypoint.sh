#!/bin/bash
set -e

echo "🦀 Rust: $(rustc --version)"
echo "📦 Cargo: $(cargo --version)"
echo "🪶 Starting compiler service..."

exec node dist/index.js
