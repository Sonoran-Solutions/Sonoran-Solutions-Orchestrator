#!/usr/bin/env bash
#
# deploy-fix-build-skill.sh — deploy the repo-controlled fix-build skill into the
# sandboxed Hermes HOME in the layout Hermes v0.21.1 resolves.
#
# The source of truth is hermes-watch/fix-build.skill.md (this repo). This script
# derives the installed SKILL.md from it — there is no manually divergent copy.
#
# Layout:  <sandbox-home>/.hermes/skills/<category>/fix-build/SKILL.md
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source="$here/fix-build.skill.md"

SANDBOX_HOME="${SONORAN_SANDBOX_HOME:-/home/dq/.hermes-sandbox/home}"
category="software-development"
dest="$SANDBOX_HOME/.hermes/skills/$category/fix-build/SKILL.md"

mkdir -p "$(dirname "$dest")"
cp "$source" "$dest"
echo "deployed fix-build skill -> $dest"

# Git identity is task-local in each router-created private repository. The
# sandbox ignores global/system Git config, so this deployment never creates or
# imports a credential helper.
# Verify the deployed skill exists and has the expected frontmatter name.
grep -q '^name: fix-build$' "$dest"
echo "verified: deployed SKILL.md declares name 'fix-build'"
