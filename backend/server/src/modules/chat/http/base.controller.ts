import { Inject } from "@nestjs/common";
import { type ObjectStorage } from "@workspace/service-kit";
import type { Pool } from "pg";
import type { Realtime } from "../realtime.js";

import { CFG, POOL, REALTIME, SEARCH, STORAGE, type ChatCfg } from "./common.js";

/** The dependencies every Chat controller is given. Controllers extend it and inherit the constructor, so Nest injects the same tokens into each. */
export abstract class ChatControllerBase {
  constructor(
    @Inject(POOL) protected readonly pool: Pool,
    @Inject(REALTIME) protected readonly rt: Realtime,
    /** The search database (Postgres full-text search, filled by the search module). */
    @Inject(SEARCH) protected readonly searchDb: Pool,
    @Inject(STORAGE) protected readonly storage: ObjectStorage,
    @Inject(CFG) protected readonly cfg: ChatCfg,
  ) {}
}
