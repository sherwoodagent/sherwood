/**
 * Unit tests for agent utility functions.
 */

import { describe, it, expect } from "vitest";
import { clamp } from "./utils.js";

describe("clamp", () => {
  it("returns value unchanged when within default bounds [-1, 1]", () => {
    expect(clamp(0)).toBe(0);
    expect(clamp(0.5)).toBe(0.5);
    expect(clamp(-0.5)).toBe(-0.5);
    expect(clamp(1)).toBe(1);
    expect(clamp(-1)).toBe(-1);
  });

  it("clamps value above default max to 1", () => {
    expect(clamp(1.5)).toBe(1);
    expect(clamp(100)).toBe(1);
    expect(clamp(Infinity)).toBe(1);
  });

  it("clamps value below default min to -1", () => {
    expect(clamp(-1.5)).toBe(-1);
    expect(clamp(-100)).toBe(-1);
    expect(clamp(-Infinity)).toBe(-1);
  });

  it("uses default bounds of [-1, 1] when no bounds provided", () => {
    expect(clamp(2)).toBe(1);
    expect(clamp(-2)).toBe(-1);
    expect(clamp(0.99)).toBe(0.99);
  });

  it("respects custom min and max bounds", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("handles custom bounds where min equals max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
    expect(clamp(1, 3, 3)).toBe(3);
  });

  it("handles zero as a boundary", () => {
    expect(clamp(-0.5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(1.5, 0, 1)).toBe(1);
  });

  it("handles negative custom bounds", () => {
    expect(clamp(-5, -10, -2)).toBe(-5);
    expect(clamp(-1, -10, -2)).toBe(-2);
    expect(clamp(-15, -10, -2)).toBe(-10);
  });
});
