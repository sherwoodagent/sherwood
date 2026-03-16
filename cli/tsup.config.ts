import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  // MUST enable splitting so xmtp.ts stays in a separate chunk.
  // Without this, @xmtp/node-bindings imports end up at the top of
  // index.js and Node eagerly resolves them, crashing on startup.
  splitting: true,
  clean: true,
  sourcemap: true,
  // Keep XMTP packages external — they have native bindings
  external: [
    "@xmtp/node-sdk",
    "@xmtp/node-bindings",
    "@xmtp/content-type-primitives",
  ],
  // Inject PINATA_JWT at build time if available
  define: {
    "process.env.PINATA_JWT_BUILD": JSON.stringify(
      process.env.PINATA_JWT || ""
    ),
  },
});
