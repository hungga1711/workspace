// @ts-expect-error a plain .mjs tooling script, typed by use
import { ensureTestDatabase } from "../../../tooling/scripts/test-db.mjs";

export default async function setup() {
  await (ensureTestDatabase as () => Promise<void>)();
}
