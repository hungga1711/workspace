import type { Integration } from "./define.js";
import { figma } from "./providers/figma.js";
import { github } from "./providers/github.js";
import { gitlab } from "./providers/gitlab.js";

/**
 * Every integration the hub offers, in the order their tiles show. Adding one is adding a line here (and its file in
 * `providers/`): docs/integrations/hub.md.
 */
export const INTEGRATIONS: readonly Integration[] = [github, gitlab, figma];

if (new Set(INTEGRATIONS.map((i) => i.id)).size !== INTEGRATIONS.length) throw new Error("two integrations share an id");

export const integrationOf = (id: string): Integration | undefined => INTEGRATIONS.find((i) => i.id === id);
