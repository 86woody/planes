import { describe, expect, test } from "vitest";
import { fixText } from "../src/format.js";

describe("fix-it text", () => {
  test("EL-01 target_elevated has the DESIGN.md 7 text and platform_error still uses the detail", () => {
    expect(fixText("target_elevated")).toBe(
      "Running as administrator. Restore cannot bring it forward; switch to it yourself.",
    );
    expect(fixText("platform_error", "boom")).toBe("boom");
  });
});
