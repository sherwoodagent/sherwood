#!/usr/bin/env bash
# Mirror the sherwood skill pack into hermes-plugin/skills/sherwood-agent.
# Run from hermes-plugin/ directory.
#
# DRIFT GUARDRAIL: This is a snapshot, not a symlink. Anyone updating the
# canonical `skill/` tree (addresses, governance, research, etc.) must re-run
# this script and commit the refreshed mirror. Post-migration to a standalone
# `sherwood-hermes-plugin` repo, a CI job will refresh nightly and open a PR
# when drift is detected. Until then the script is the contract.
#
# The mirror also preserves the `skills/sherwood-agent/skills/remember-settlement/`
# subskill that the plugin adds on top of the canonical pack — that subskill is
# plugin-specific, NOT in `skill/`, so we keep it before wiping.

set -euo pipefail

SRC="${1:-../skill}"
DEST="skills/sherwood-agent"
# Plugin-local subskills that are NOT in the canonical skill/ tree:
PLUGIN_LOCAL_SUBSKILLS=("remember-settlement")

if [[ ! -d "$SRC" ]]; then
    echo "source not found: $SRC" >&2
    exit 1
fi

# Stash plugin-local subskills so the rm -rf doesn't nuke them.
STASH="$(mktemp -d)"
for name in "${PLUGIN_LOCAL_SUBSKILLS[@]}"; do
    if [[ -d "$DEST/skills/$name" ]]; then
        mkdir -p "$STASH/skills"
        cp -r "$DEST/skills/$name" "$STASH/skills/$name"
    fi
done

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC"/* "$DEST"/

# Restore plugin-local subskills.
for name in "${PLUGIN_LOCAL_SUBSKILLS[@]}"; do
    if [[ -d "$STASH/skills/$name" ]]; then
        mkdir -p "$DEST/skills"
        cp -r "$STASH/skills/$name" "$DEST/skills/$name"
    fi
done
rm -rf "$STASH"

echo "skill pack mirrored from $SRC to $DEST (plugin-local subskills preserved: ${PLUGIN_LOCAL_SUBSKILLS[*]})"
