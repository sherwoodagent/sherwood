#!/usr/bin/env node
/**
 * Force the @xmtp/node-bindings dev build into this install.
 *
 * Why this exists:
 *   cli/package.json pins "@xmtp/node-bindings": "1.10.0-dev.97e86c6" in the
 *   `overrides` block. That pin IS honored during local development
 *   (cli/package.json is the root of its install tree) but is silently
 *   dropped on global install — `npm i -g @sherwoodagent/cli` treats the CLI
 *   as a dependency of an implicit "global root" package, and npm only
 *   applies `overrides` from the true root.
 *
 *   Result: `npm i -g` pulls the published @xmtp/node-bindings@1.10.0
 *   (requires glibc 2.38), not the pinned dev build (max glibc 2.18).
 *   Hosts on glibc 2.36 (e.g. Debian 12 containers Hermes often runs in)
 *   then see `GLIBC_2.38 not found` on any XMTP call.
 *
 *   This postinstall forcibly replaces the installed binding with the dev
 *   version. --no-save keeps package.json unchanged. --force tells npm to
 *   ignore the semver conflict with @xmtp/node-sdk's own dep range (the
 *   dev pre-release doesn't satisfy `^1.10.0` under npm's strict semver).
 *   After the force-install, `npm dedupe` collapses any nested copies
 *   inside @xmtp/node-sdk's own node_modules.
 *
 *   If npm isn't available or the network is unreachable at postinstall
 *   time, this script exits quietly with status 0. Runtime XMTP calls
 *   will still fail the same way they would without this fix, but the
 *   install itself isn't blocked — non-XMTP CLI commands keep working.
 *
 *   Proper long-term fix: adopt the sidecar pattern already in use by
 *   sherwoodagent/sherwood-hermes-plugin — bundle XMTP in a sub-install
 *   tree whose own package.json IS a root and whose overrides WILL apply.
 *   Tracked as a future refactor.
 */

"use strict";

const { execSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const PINNED = "@xmtp/node-bindings@1.10.0-dev.97e86c6";

// Skip in CI / test / sandbox envs where network is unavailable or unwanted.
if (process.env.SHERWOOD_SKIP_XMTP_BINDING_PIN === "1") {
  process.stderr.write(
    "[sherwood-cli] postinstall: binding pin skipped (env)\n",
  );
  process.exit(0);
}

// Skip when running from the monorepo (cli/ is itself the root during dev;
// overrides work and this would create a redundant nested copy).
const parentDir = path.resolve(__dirname, "..", "..");
if (existsSync(path.join(parentDir, "contracts")) && existsSync(path.join(parentDir, "cli"))) {
  process.stderr.write(
    "[sherwood-cli] postinstall: monorepo dev install detected — skipping binding pin\n",
  );
  process.exit(0);
}

try {
  process.stderr.write(
    `[sherwood-cli] postinstall: forcing ${PINNED} to work around npm global-install override limitation\n`,
  );
  execSync(`npm install --no-save --force ${PINNED}`, {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: path.resolve(__dirname, ".."),
  });
  // Collapse any nested copies that @xmtp/node-sdk installed separately
  // (its own deps range `^1.10.0` rejects our pre-release by strict semver).
  try {
    execSync("npm dedupe @xmtp/node-bindings", {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: path.resolve(__dirname, ".."),
    });
  } catch {
    // dedupe is best-effort; failure doesn't mean the primary install failed.
  }
  process.stderr.write("[sherwood-cli] postinstall: binding pin applied\n");
} catch (err) {
  // Don't fail the install — non-XMTP commands still work. The error
  // message is printed so users on broken-binding hosts can see why chat
  // is failing and run the pin manually.
  process.stderr.write(
    `[sherwood-cli] postinstall: binding pin failed (${err && err.message ? err.message : err}). ` +
      "XMTP features may fail at runtime. To retry manually:\n" +
      `  cd $(dirname $(readlink -f $(which sherwood)))/../lib/node_modules/@sherwoodagent/cli && npm install --no-save --force ${PINNED}\n`,
  );
  process.exit(0);
}
