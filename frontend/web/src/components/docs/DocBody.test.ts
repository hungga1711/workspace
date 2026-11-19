import { describe, expect, it } from "vitest";
import { dropTitleHeading } from "./DocBody";

describe("dropTitleHeading", () => {
  it("drops a first heading that repeats the title", () => {
    expect(dropTitleHeading("<h1>Quy trình phát hành</h1><p>Nội dung</p>", "Quy trình phát hành")).toBe("<p>Nội dung</p>");
    expect(dropTitleHeading('\n<h2 id="x">Q&amp;A  <b>nhanh</b></h2><p>a</p>', "Q&A nhanh")).toBe("<p>a</p>");
    // The page's emoji is a separate field, so the heading may carry it and the title not.
    expect(dropTitleHeading("<h1>Welcome to Brightline 👋</h1><p>a</p>", "Welcome to Brightline")).toBe("<p>a</p>");
    expect(dropTitleHeading("<h1>🛠️ Kỹ thuật</h1><p>a</p>", "Kỹ thuật")).toBe("<p>a</p>");
  });
  it("keeps other headings and other first blocks", () => {
    expect(dropTitleHeading("<h1>Mục lục</h1><p>a</p>", "Quy trình")).toBe("<h1>Mục lục</h1><p>a</p>");
    expect(dropTitleHeading("<p>Quy trình</p>", "Quy trình")).toBe("<p>Quy trình</p>");
    expect(dropTitleHeading("<h1>A</h1>", undefined)).toBe("<h1>A</h1>");
  });
});
