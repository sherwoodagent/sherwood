import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readJsonFile, readJsonlTail } from "./serve.js";

const TEST_DIR = join(tmpdir(), "sherwood-serve-test-" + Date.now());

beforeEach(async () => { await mkdir(TEST_DIR, { recursive: true }); });
afterEach(async () => { await rm(TEST_DIR, { recursive: true, force: true }); });

describe("readJsonFile", () => {
  it("reads and parses a JSON file", async () => {
    const path = join(TEST_DIR, "test.json");
    await writeFile(path, JSON.stringify({ cash: 5000, positions: [] }));
    const result = await readJsonFile(path);
    expect(result).toEqual({ cash: 5000, positions: [] });
  });
  it("returns null for missing file", async () => {
    const result = await readJsonFile(join(TEST_DIR, "missing.json"));
    expect(result).toBeNull();
  });
});

describe("readJsonlTail", () => {
  it("returns last N lines parsed as JSON", async () => {
    const path = join(TEST_DIR, "test.jsonl");
    const lines = [
      JSON.stringify({ cycleNumber: 1, timestamp: 1000 }),
      JSON.stringify({ cycleNumber: 2, timestamp: 2000 }),
      JSON.stringify({ cycleNumber: 3, timestamp: 3000 }),
    ];
    await writeFile(path, lines.join("\n") + "\n");
    const result = await readJsonlTail(path, 2);
    expect(result).toHaveLength(2);
    expect(result[0].cycleNumber).toBe(2);
    expect(result[1].cycleNumber).toBe(3);
  });
  it("returns empty array for missing file", async () => {
    const result = await readJsonlTail(join(TEST_DIR, "missing.jsonl"), 10);
    expect(result).toEqual([]);
  });
  it("skips malformed lines", async () => {
    const path = join(TEST_DIR, "bad.jsonl");
    await writeFile(path, '{"ok":true}\nbroken\n{"ok":false}\n');
    const result = await readJsonlTail(path, 10);
    expect(result).toHaveLength(2);
  });
});
