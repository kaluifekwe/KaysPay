#!/usr/bin/env bash
# Runs before every `git push` (wired via .husky/pre-push). Scans only what
# is actually about to be pushed -- not the whole repo -- so it stays fast
# enough to run on every push instead of becoming the kind of slow gate people
# route around with --no-verify. Uses Docker for every tool so nothing needs
# a separate local install (gitleaks/semgrep/osv-scanner are all Go/Python
# tools with no single cross-platform package manager story on Windows).
set -euo pipefail

# Git Bash (MSYS) auto-converts a leading /path in any argument into a
# Windows path (e.g. "/repo" -> "C:/Program Files/Git/repo") before it ever
# reaches docker.exe, which breaks every -v/--config path below. This is a
# well-known MSYS+Docker-on-Windows gotcha, not a typo -- confirmed by
# actually running this script and watching Gitleaks fail with
# "stat C:/Program Files/Git/repo: no such file or directory". Harmless
# no-op on real Linux/macOS shells.
export MSYS_NO_PATHCONV=1

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't running -- can't run the pre-push security scan."
  echo "Start Docker Desktop, or push with --no-verify if you deliberately want to skip this (not recommended)."
  exit 1
fi

# git passes one line per ref being pushed on stdin:
#   <local ref> <local sha1> <remote ref> <remote sha1>
LOCAL_SHAS=()
while read -r local_ref local_sha remote_ref remote_sha; do
  [ -z "$local_sha" ] && continue
  [ "$local_sha" = "0000000000000000000000000000000000000000" ] && continue # deleting a ref
  LOCAL_SHAS+=("$local_sha:$remote_sha")
done

if [ "${#LOCAL_SHAS[@]}" -eq 0 ]; then
  echo "Nothing to scan (no ref updates)."
  exit 0
fi

FAIL=0

for pair in "${LOCAL_SHAS[@]}"; do
  local_sha="${pair%%:*}"
  remote_sha="${pair##*:}"
  if [ -z "$remote_sha" ] || [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    # New branch on the remote -- diff against the merge-base with master instead.
    base_sha="$(git merge-base "$local_sha" origin/master 2>/dev/null || echo "$local_sha~20")"
  else
    base_sha="$remote_sha"
  fi

  CHANGED_FILES="$(git diff --name-only "$base_sha" "$local_sha" -- . ':!*.lock' ':!package-lock.json' || true)"
  if [ -z "$CHANGED_FILES" ]; then
    continue
  fi

  echo ""
  echo "== Scanning $(echo "$CHANGED_FILES" | wc -l) changed file(s) between ${base_sha:0:8} and ${local_sha:0:8} =="

  echo ""
  echo "-- Gitleaks (secrets) --"
  if ! docker run --rm -v "$REPO_ROOT:/repo" zricethezav/gitleaks:latest detect \
      --source="/repo" --log-opts="${base_sha}..${local_sha}" --no-banner -v; then
    echo "Gitleaks found a likely secret in these commits. Fix it before pushing."
    FAIL=1
  fi

  SEMGREP_FILES=$(echo "$CHANGED_FILES" | grep -E '\.(ts|tsx|js|jsx)$' || true)
  if [ -n "$SEMGREP_FILES" ]; then
    SRC_ARGS=$(echo "$SEMGREP_FILES" | sed 's|^|/src/|')

    echo ""
    echo "-- Semgrep: community security rules (blocking) --"
    SEMGREP_STATUS=0
    docker run --rm -v "$REPO_ROOT:/src" semgrep/semgrep:latest \
      semgrep --config=p/security-audit --config=p/javascript --config=p/typescript \
      --error $SRC_ARGS || SEMGREP_STATUS=$?
    if [ "$SEMGREP_STATUS" -ne 0 ]; then
      echo "Semgrep found a real finding above. Fix it before pushing."
      FAIL=1
    fi

    echo ""
    echo "-- Semgrep: KaysPay-specific rules (informational -- read, don't just dismiss) --"
    docker run --rm -v "$REPO_ROOT:/src" semgrep/semgrep:latest \
      semgrep --config=/src/.semgrep/kayspay-rules.yml $SRC_ARGS || true
  else
    echo ""
    echo "-- Semgrep --"
    echo "(no JS/TS files changed, skipped)"
  fi

  if echo "$CHANGED_FILES" | grep -qE 'package\.json$'; then
    echo ""
    echo "-- OSV-Scanner (dependency CVEs) --"
    # `scan source` is the current (v2.x) subcommand -- the old flat
    # `osv-scanner --recursive ...` form silently ignores --config entirely
    # rather than erroring, which looks like a clean pass when it's actually
    # not applying .osv-scanner.toml's ignore list at all. Confirmed by
    # testing directly. --experimental-exclude is kept even though its
    # documented directory-exclusion effect didn't reproduce here, because
    # its presence is what made --config start being honored in recursive
    # mode -- an apparent tool quirk, not something to rely on being fixed.
    if ! docker run --rm -v "$REPO_ROOT:/repo" ghcr.io/google/osv-scanner:latest \
        scan source --recursive --experimental-exclude ".tmp" \
        --config=/repo/.osv-scanner.toml /repo 2>/dev/null; then
      echo "OSV-Scanner found a known-vulnerable dependency. Review before pushing (not always a hard blocker -- use judgment)."
    fi
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "Push blocked -- see findings above. If a finding is a false positive, fix the rule rather than routing around it with --no-verify."
  exit 1
fi

echo ""
echo "Pre-push security scan passed."
exit 0
