import type { Connector, Provider } from "../types.js";
import { asana } from "./asana.js";
import { clickup } from "./clickup.js";
import { jira } from "./jira.js";
import { linear } from "./linear.js";

export const CONNECTORS: Record<Provider, Connector> = { asana, clickup, linear, jira };
