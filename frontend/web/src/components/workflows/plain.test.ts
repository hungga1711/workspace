import { describe, expect, it } from "vitest";
import { plainText } from "./plain";

describe("plainText", () => {
  it("drops Markdown marks and keeps the words on one line", () => {
    expect(plainText("## Fix a bug\n\n- **Reproduce** it\n- open a [PR](https://x.test)\n\n> `npm test` first")).toBe("Fix a bug Reproduce it open a PR npm test first");
  });

  it("leaves plain text and snake_case alone", () => {
    expect(plainText("Runs on the assignee's computer: run_tests.sh")).toBe("Runs on the assignee's computer: run_tests.sh");
  });
});
