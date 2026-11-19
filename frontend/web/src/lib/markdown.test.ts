import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

const html = (source: string) => renderToStaticMarkup(Markdown({ source }));

describe("Markdown links", () => {
  it("links http(s) addresses and paths on this site", () => {
    expect(html("[a](https://example.com/x)")).toContain('href="https://example.com/x"');
    expect(html("[task](/app/work/tasks/1)")).toContain('href="/app/work/tasks/1"');
  });
  it("leaves other schemes and protocol-relative addresses as text", () => {
    for (const src of ["[x](javascript:alert(1))", "[x](//evil.example/a)", "[x](/\\evil.example)", "[x](data:text/html,hi)"]) expect(html(src)).not.toContain("<a ");
  });
});

describe("Markdown formatting", () => {
  it("renders checklists, strike and underscore italics", () => {
    const out = html("- [ ] call the bank\n- [x] send the quote\n\n~~old~~ and _new_ but not snake_case_name");
    expect(out.match(/type="checkbox"/g)).toHaveLength(2);
    expect(out).toContain("checked");
    expect(out).toContain("<s>old</s>");
    expect(out).toContain("<em>new</em>");
    expect(out).toContain("snake_case_name");
  });
});

describe("Markdown in AI answers", () => {
  it("renders GFM tables with alignment and escaped pipes", () => {
    const out = html("| Tên | Số |\n|---|---:|\n| An \\| Bình | **12** |\n| Chi | 3 |");
    expect(out).toContain("<table");
    expect(out.match(/<th /g)).toHaveLength(2);
    expect(out.match(/<tr /g)).toHaveLength(2);
    expect(out).toContain("An | Bình");
    expect(out).toContain("<strong>12</strong>");
    expect(out).toContain("text-right");
  });
  it("keeps a numbered list whole across blank lines and nests indented items", () => {
    const out = html("1. Một\n\n2. Hai\n   - con a\n   - con b\n3. Ba");
    expect(out.match(/<ol /g)).toHaveLength(1);
    expect(out.match(/<ul /g)).toHaveLength(1);
    expect(out.match(/<li>/g)).toHaveLength(5);
  });
  it("keeps the first number of an ordered list", () => {
    expect(html("Đoạn\n\n3. Ba\n4. Bốn")).toContain('start="3"');
  });
  it("renders rules, deeper headings and a code block's language", () => {
    const out = html("---\n#### Ghi chú\n```ts\nconst a = 1;\n```");
    expect(out).toContain("<hr");
    expect(out).toContain("<h5");
    expect(out).toContain(">ts</span>");
    expect(out).toContain("const a = 1;");
  });
  it("ends a paragraph where a list or table starts", () => {
    const out = html("Kết quả:\n- một\n- hai");
    expect(out).toContain("<p");
    expect(out.match(/<li>/g)).toHaveLength(2);
  });
  it("counts checklist items in document order, nested ones included", () => {
    const out = html("- [ ] a\n  - [x] b\n- [ ] c");
    expect(out.match(/type="checkbox"/g)).toHaveLength(3);
  });
});

describe("Markdown blocks nested in AI lists", () => {
  it("keeps a fenced block indented under a list item as a block, and a fenced plain table as a table", () => {
    const out = html("- Kết quả:\n    ```\n    | Month | Theme |\n    |---|---|\n    | Oct | Billing |\n    ```\n- Next\n\n```js\nconst a = 1;\n```");
    expect(out).toContain("<table");
    expect(out).toContain("<td");
    expect(out).not.toContain("```");
    expect(out.match(/<li/g)).toHaveLength(2);
    expect(out).toContain("const a = 1;");
  });
  it("shows a picture from another site as a link", () => {
    const out = html("![chart](https://example.com/c.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain('href="https://example.com/c.png"');
  });
});
