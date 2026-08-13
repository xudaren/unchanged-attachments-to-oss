#!/bin/bash
set -e

# Obsidian Plugin Release Script
# Usage: ./scripts/release.sh [patch|minor|major]

BUMP_TYPE="${1:-patch}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo "❌ There are uncommitted changes. Please commit or stash them first."
  exit 1
fi

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "Current version: $CURRENT_VERSION"

# Bump version
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
echo "New version: $NEW_VERSION"

# Update manifest.json version
sed -i.bak "s/\"version\": \".*\"/\"version\": \"$NEW_VERSION\"/" manifest.json
rm -f manifest.json.bak

# Build
echo "Building..."
npm run build

# Commit changes (use -f for main.js since it's in .gitignore)
git add package.json package-lock.json manifest.json
git add -f main.js
git commit -m "release: v$NEW_VERSION"

# Create and push tag
git tag "$NEW_VERSION"
git push origin main --tags

echo ""
echo "✅ Released v$NEW_VERSION"
echo "GitHub Actions will create the release automatically."
echo "Check: https://github.com/xudaren/unchanged-attachments-to-oss/releases/tag/$NEW_VERSION"
