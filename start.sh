#!/bin/bash

# Floor2CAD Development Setup

set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🚀 Starting Floor2CAD..."
echo ""

# Go to project directory
cd "$PROJECT_DIR"

echo "📦 Starting backend on port 5001..."
echo "🎨 Starting frontend on port 3000..."
echo ""

# Start development servers
npm run dev

# After npm run dev exits
echo ""
echo "✅ Development server has stopped"
