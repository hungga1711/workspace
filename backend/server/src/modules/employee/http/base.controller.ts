import { Inject, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

import { workspaceTz } from "../time-zone.js";
import { POOL, type EmployeeRow } from "./common.js";

/** What every Employee controller shares: the injected dependencies and loading one profile. Controllers extend it and inherit the constructor. */
export abstract class EmployeeControllerBase {
  constructor(@Inject(POOL) protected readonly pool: Pool) {}

  protected async employee(c: PoolClient, userId: string): Promise<EmployeeRow> {
    const r = await c.query<EmployeeRow>(
      "SELECT user_id, code, display_name, title, department_id, manager_id, job_level, hire_date::text, location, phone, active, version FROM employees WHERE user_id = $1",
      [userId],
    );
    if (!r.rows[0]) throw new NotFoundException("employee not found");
    return r.rows[0];
  }

  /** The workspace's time zone, for "today" (check-in), the current year and month. */
  protected timeZone(): Promise<string> {
    return workspaceTz(this.pool);
  }
}
