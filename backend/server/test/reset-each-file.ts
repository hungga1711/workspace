import { beforeAll } from "vitest";
import { resetTestDatabase } from "./test-db.js";

// Every test file starts from an empty installation: rows another file left behind would otherwise show up in
// this one's lists and counts (there is one workspace, so nothing tells them apart).
beforeAll(() => resetTestDatabase());
