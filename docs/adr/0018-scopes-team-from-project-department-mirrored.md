# ADR-0018: TEAM scope comes from the project, DEPARTMENT scope is mirrored from the org chart

- Status: Accepted
- Date: 2026-10-18
- Relates to: the permission + scope model in [`backend/packages/shared/src/authz`](../../backend/packages/shared/src/authz.ts)

## Context

Grants carry a scope (SELF, TEAM, DEPARTMENT, WORKSPACE…) and `authorize()` compares the resource's `teamId` /
`departmentId` with the principal's. Two things kept the narrower scopes from ever matching:

- `members.department_id` (identity schema, read into every principal) was never written. Departments live in the
  employee module (`employees.department_id`, `departments.head_id`), owned by HR in Admin › Team & phòng ban.
- Projects only received a `team_id` at creation and the web never sent one; tasks inherit the project's team, so
  every task had `team_id = NULL`. The built-in Manager role is TEAM-scoped, so it granted nothing.

The principal is built in identity (`resolvePrincipal`) and cached by the gateway for 60 s; a cross-service call
to employee on every resolve would put the employee module on the hot path of every request.

## Decision

1. **TEAM is the work scope.** A project has a team (project edit dialog; `PATCH /work/projects/:id { teamId }`), and
   its tasks always carry the project's team: set on create, backfilled when the project's team changes, cleared
   when the team is deleted (`identity.team.deleted.v1`, projected by work-service). The Manager role stays
   TEAM-scoped: a manager acts on the projects and tasks of the teams they belong to.
2. **DEPARTMENT is mirrored, not fetched.** Employee already publishes `employee.profile.updated.v1` (department,
   manager) for every org change; identity now consumes it (`identity-org` consumer, `org-mirror.ts`) and keeps
   `members.department_id` in step. DEPARTMENT-scope grants, on resources that carry a department (salary today,
   custom roles tomorrow), resolve from that column with no extra call. The gateway evicts cached principals on
   employee profile and department changes so the mirror is visible at once.
3. **Routing is authority for leave.** A request goes to `employees.manager_id` (or their delegate); whoever it is
   routed to decides it without `leave.approve`, which remains the HR-wide grant.
4. Roles, teams and departments are full CRUD (edit, members, delete) with the rules: built-in roles keep their
   names, Owner/Admin cannot be edited, assigned roles need `?force=1` to delete, deleting a department with
   people needs `?move=1` (they end up with no department and the mirror follows).

## Consequences

- One scope per permission per role (the `role_grants` primary key), so a role is TEAM- or DEPARTMENT-scoped per
  permission, never both; department heads who need task rights use a team or a custom role.
- The mirror lags by one event delivery (well under a second in practice); the gateway eviction covers the cache.
- Deleting a team or department is reversible only by recreating it: ids are not reused.
