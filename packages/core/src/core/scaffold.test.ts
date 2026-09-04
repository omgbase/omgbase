import { describe, it, expect } from "vitest";
import { VERSION } from "./index.js";

describe("scaffold", () => {
  it("exports a version", () => {
    expect(VERSION).toBe("0.0.0");
  });
});
