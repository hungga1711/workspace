import { describe, expect, it } from "vitest";
import { missingInLog } from "./workflows.js";

describe("missingInLog (what a version 2 runner could not hand back)", () => {
  it("reads refusals and files over a limit, and leaves an empty file out", () => {
    const log = [
      "handed back report.md",
      "not handed back: hello.txt: POST /runner/runs/x/artifacts: the key was refused (HTTP 403). Create a new key.",
      "not handed back (over 50 MB): video.mp4",
      "not handed back (over 30 files): extra - a.csv",
      "not handed back (empty): blank.txt",
      "nothing in the out folder",
    ].join("\n");
    expect(missingInLog(log)).toEqual([
      { name: "hello.txt", why: "POST /runner/runs/x/artifacts: the key was refused (HTTP 403). Create a new key." },
      { name: "video.mp4", why: "over 50 MB" },
      { name: "extra - a.csv", why: "over 30 files" },
    ]);
  });

  it("finds nothing when everything was handed back", () => {
    expect(missingInLog("handed back a.md\nhanded back b.csv\n")).toEqual([]);
    expect(missingInLog("")).toEqual([]);
  });
});
