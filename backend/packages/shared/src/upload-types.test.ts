import { describe, expect, it } from "vitest";
import { inlineSafe, uploadRefusal } from "./upload-types.js";

describe("what may be uploaded", () => {
  it("accepts the files an office uses, HTML and unknown kinds included", () => {
    for (const [name, type] of [
      ["report.html", "text/html"],
      ["logo.svg", "image/svg+xml"],
      ["plan.pdf", "application/pdf"],
      ["budget.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["old.doc", "application/msword"],
      ["data.json", "application/json"],
      ["export.xml", "text/xml"],
      ["site.zip", "application/zip"],
      ["drawing.fig", "application/octet-stream"],
      ["clip.mov", "video/quicktime"],
      ["notes", "application/octet-stream"],
      ["page.htm", "text/html; charset=utf-8"],
      ["build.sh.txt", "text/plain"],
      ["Báo cáo quý 3.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ] as const)
      expect(uploadRefusal(name, type), name).toBeNull();
  });

  it("refuses programs, installers and scripts by extension, whatever type is claimed", () => {
    for (const name of [
      "setup.exe",
      "Setup.EXE",
      "tool.msi",
      "run.bat",
      "x.cmd",
      "a.ps1",
      "a.vbs",
      "wsh.js",
      "app.jar",
      "Tool.app",
      "disk.dmg",
      "i.pkg",
      "p.deb",
      "p.rpm",
      "go.sh",
      "m.apk",
      "s.scr",
      "l.lnk",
    ])
      for (const type of ["application/octet-stream", "text/plain", "image/png"]) expect(uploadRefusal(name, type), `${name} as ${type}`).toMatch(/cannot be uploaded/);
  });

  it("is not fooled by a second extension, a trailing dot or a space", () => {
    expect(uploadRefusal("invoice.pdf.exe", "application/pdf")).toMatch(/\.exe/);
    expect(uploadRefusal("invoice.exe.", "application/pdf")).toMatch(/\.exe/);
    expect(uploadRefusal("invoice.exe ", "application/pdf")).toMatch(/\.exe/);
  });

  it("refuses a program under an innocent name by its content type", () => {
    expect(uploadRefusal("photo.png", "application/x-msdownload")).toMatch(/cannot be uploaded/);
    expect(uploadRefusal("readme", "application/x-sh")).toMatch(/cannot be uploaded/);
    expect(uploadRefusal("lib.zip", "application/java-archive")).toMatch(/cannot be uploaded/);
  });

  it("refuses a content type that is not one", () => {
    for (const type of ["", "html", "text/html\r\nx-evil: 1", "a/b c", "text/"])
      expect(uploadRefusal("a.txt", type), JSON.stringify(type)).toMatch(/not allowed: it is not a valid type/);
  });
});

describe("what may be shown inline", () => {
  it("shows pictures, PDF, sound, video and plain text", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "application/pdf", "video/mp4", "audio/mpeg", "text/plain", "text/plain; charset=utf-8", "IMAGE/PNG"])
      expect(inlineSafe(type), type).toBe(true);
  });

  it("never shows what a browser would run", () => {
    for (const type of [
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml",
      "text/xml",
      "application/xml",
      "text/javascript",
      "application/javascript",
      "text/css",
      "application/octet-stream",
      "text/html; charset=utf-8",
    ])
      expect(inlineSafe(type), type).toBe(false);
  });
});
