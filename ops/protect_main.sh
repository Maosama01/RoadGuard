#!/bin/bash
# Protects the main branch on GitHub: no force pushes, no deleting it. Pushing normally still works.
#   bash ~/Projects/RoadGuard/ops/protect_main.sh
set -euo pipefail
cd "$(dirname "$0")/.."
command -v gh >/dev/null || { echo "Needs the GitHub CLI (brew install gh)."; exit 1; }
REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
if gh api -X PUT "repos/$REPO/branches/main/protection" --input - >/dev/null <<'JSON'
{
  "required_status_checks": null,
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
then
  echo "main is protected on $REPO: no force pushes, no deletion."
else
  echo
  echo "GitHub refused. On a free account, branch protection only works on PUBLIC repos."
  echo "Options: make the repo public, or get GitHub Pro (free with the GitHub Student Developer Pack)."
fi
