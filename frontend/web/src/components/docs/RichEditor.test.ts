import { describe, expect, it } from "vitest";
import { generateText, getSchema } from "@tiptap/core";
import { mentionLabel, pageExtensions } from "./RichEditor";

const exts = pageExtensions({ editable: true, placeholder: "" });
const doc = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Nhờ " },
        { type: "mention", attrs: { id: "u1", label: "Freya Ali" } },
      ],
    },
  ],
};

describe("RichEditor mentions", () => {
  // The idle suggestion trigger is a NUL: in a saved mention Postgres would refuse the save.
  it("writes @Name, never the suggestion trigger", () => {
    const text = generateText(doc, exts);
    expect(text).toBe("Nhờ @Freya Ali");
    expect(text).not.toContain("\u0000");
  });

  it("renders the saved HTML span with @Name", () => {
    const schema = getSchema(exts);
    const node = schema.nodeFromJSON(doc).firstChild!.child(1);
    const out = node.type.spec.toDOM!(node) as unknown as [string, Record<string, string>, string];
    expect(out[0]).toBe("span");
    expect(out[1]["data-type"]).toBe("mention");
    expect(out[2]).toBe("@Freya Ali");
  });

  it("falls back to the id when a mention has no label", () => {
    expect(mentionLabel({ id: "u1" })).toBe("@u1");
  });
});
