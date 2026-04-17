#!/usr/bin/env bash
# Install Sherwood cron skills + jobs into a hermes-agent install.
#
# Prerequisites:
#   - hermes-agent installed (hermes CLI on PATH, gateway running)
#   - sherwood CLI 0.40.2 or later on PATH (`which sherwood`)
#   - You have created your syndicate and know its vault address + chat name
#
# Usage:
#   ./cron/install.sh                # interactive prompts
#   REPO_DIR=... SYNDICATE_NAME=... VAULT_ADDRESS=... CHAIN=... AGENT_WALLET=... ./cron/install.sh
#
# Idempotent: rerunning re-syncs skills and re-creates any missing jobs.
# Will NOT modify already-existing jobs (delete via `hermes cron remove <id>` first).

set -euo pipefail

# ── Resolve paths ──
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
SKILLS_SRC="$SCRIPT_DIR/skills"
JOBS_TEMPLATE="$SCRIPT_DIR/jobs.example.json"
HERMES_SKILLS_DIR="${HERMES_SKILLS_DIR:-$HOME/.hermes/skills/sherwood}"

# ── Sanity checks ──
command -v hermes >/dev/null 2>&1 || {
  echo "ERROR: hermes CLI not found on PATH. Install hermes-agent first." >&2
  exit 1
}
command -v sherwood >/dev/null 2>&1 || {
  echo "ERROR: sherwood CLI not found on PATH. Run 'npm i -g @sherwoodagent/cli' or build the local checkout first." >&2
  exit 1
}
SHERWOOD_VER=$(sherwood --version 2>/dev/null || echo "0.0.0")
# Compare against minimum 0.40.2 — needed for `chat send --stdin`
if ! printf '%s\n%s\n' "0.40.2" "$SHERWOOD_VER" | sort -V -C; then
  echo "ERROR: sherwood CLI is $SHERWOOD_VER; need ≥ 0.40.2 for 'chat send --stdin'." >&2
  exit 1
fi

# ── Gather config (env vars or interactive prompts) ──
prompt_var() {
  local name="$1" desc="$2" default="${3:-}"
  local current="${!name:-}"
  if [[ -n "$current" ]]; then
    echo "  $name = $current  (from env)"
    return
  fi
  if [[ -n "$default" ]]; then
    read -rp "  $name [$default]: " val
    val="${val:-$default}"
  else
    read -rp "  $name ($desc): " val
  fi
  if [[ -z "$val" ]]; then
    echo "ERROR: $name is required." >&2
    exit 1
  fi
  printf -v "$name" '%s' "$val"
  export "${name?}"
}

echo "Sherwood cron installer"
echo "──────────────────────────────────────────"
prompt_var REPO_DIR        "absolute path to sherwood checkout" "$(cd "$SCRIPT_DIR/.." && pwd)"
prompt_var SYNDICATE_NAME  "XMTP chat identifier (e.g. hyperliquid-algo)"
prompt_var CHAIN           "chain alias (e.g. hyperevm, base)" "hyperevm"
prompt_var VAULT_ADDRESS   "vault contract address (0x...)"
prompt_var AGENT_WALLET    "agent wallet address (0x...)"
echo

# ── Step 1: Install skills ──
echo "Installing skills to $HERMES_SKILLS_DIR ..."
mkdir -p "$HERMES_SKILLS_DIR"
for skill_dir in "$SKILLS_SRC"/*/; do
  skill_name=$(basename "$skill_dir")
  dest="$HERMES_SKILLS_DIR/$skill_name"
  mkdir -p "$dest"
  cp "$skill_dir/SKILL.md" "$dest/SKILL.md"
  echo "  ✓ $skill_name"
done
echo

# CRITICAL: Hermes resolves --skill by directory name, NOT by frontmatter.
# Verify each dir name matches the skill name in its frontmatter.
echo "Verifying skill directory names match frontmatter ..."
for skill_dir in "$HERMES_SKILLS_DIR"/*/; do
  dir_name=$(basename "$skill_dir")
  fm_name=$(grep -m1 '^name:' "$skill_dir/SKILL.md" | sed 's/^name: *//; s/[[:space:]]*$//')
  if [[ "$dir_name" != "$fm_name" ]]; then
    echo "  ✗ $dir_name has frontmatter name '$fm_name' — hermes will not find it." >&2
    exit 1
  fi
  echo "  ✓ $dir_name"
done
echo

# ── Step 2: Render the jobs template ──
echo "Rendering jobs from $JOBS_TEMPLATE ..."
RENDERED_JOBS=$(mktemp)
trap 'rm -f "$RENDERED_JOBS"' EXIT
sed \
  -e "s|<REPO_DIR>|${REPO_DIR}|g" \
  -e "s|<SYNDICATE_NAME>|${SYNDICATE_NAME}|g" \
  -e "s|<CHAIN>|${CHAIN}|g" \
  -e "s|<VAULT_ADDRESS>|${VAULT_ADDRESS}|g" \
  -e "s|<AGENT_WALLET>|${AGENT_WALLET}|g" \
  "$JOBS_TEMPLATE" > "$RENDERED_JOBS"

# ── Step 3: Register jobs with hermes ──
echo "Registering jobs (skipping any that already exist by name) ..."
EXISTING=$(hermes cron list 2>/dev/null | grep -E '^\s+Name:' | sed 's/^[[:space:]]*Name:[[:space:]]*//' || true)
JOB_COUNT=$(python3 -c "import json,sys; d=json.load(open('$RENDERED_JOBS')); print(len(d['jobs']))")
for i in $(seq 0 $((JOB_COUNT - 1))); do
  NAME=$(python3 -c "import json,sys; d=json.load(open('$RENDERED_JOBS')); print(d['jobs'][$i]['name'])")
  if grep -qx "$NAME" <<< "$EXISTING" 2>/dev/null; then
    echo "  - $NAME already exists — skip (delete with 'hermes cron remove <id>' to re-register)"
    continue
  fi
  SCHEDULE=$(python3 -c "import json; d=json.load(open('$RENDERED_JOBS')); s=d['jobs'][$i]['schedule']; print(s.get('display') or f\"every {s['minutes']}m\")")
  PROMPT=$(python3 -c "import json; d=json.load(open('$RENDERED_JOBS')); print(d['jobs'][$i]['prompt'])")
  SKILLS=$(python3 -c "import json; d=json.load(open('$RENDERED_JOBS')); print(' '.join('--skill ' + s for s in d['jobs'][$i]['skills']))")
  # shellcheck disable=SC2086
  hermes cron create "$SCHEDULE" "$PROMPT" --name "$NAME" $SKILLS >/dev/null
  echo "  ✓ $NAME registered ($SCHEDULE)"
done
echo

# ── Step 4: Stagger schedules ──
# Hermes interval jobs fire from creation time + N minutes. Jobs created
# in the same shell run land on the same boundary. Recommend a manual
# stagger via `hermes cron edit <id> --schedule` after install, OR pause
# and resume to shift each anchor.

echo "Done. Next steps:"
echo "  1. hermes cron list              # verify the 4 jobs are active"
echo "  2. hermes cron run <job-id>      # trigger one tick to test"
echo "  3. tail -f ~/.hermes/sessions/session_cron_*.json | grep -i error"
echo
echo "If a job session shows '⚠️ Skill(s) not found and skipped', the skill"
echo "directory name does not match the frontmatter 'name:' field. Re-run"
echo "this installer (it verifies dir names) and check ~/.hermes/skills/sherwood/."
