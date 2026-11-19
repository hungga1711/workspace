-- ai.prompt.manage: who may set up the company's prompt library. Roles that already manage AI policy get
-- it at the same scope, and the default Manager role gets it for its own department, so a manager can publish
-- prompts for their department. Idempotent.
INSERT INTO role_grants (role_id, permission, scope)
SELECT role_id, 'ai.prompt.manage', scope FROM role_grants WHERE permission = 'ai.policy.manage'
ON CONFLICT (role_id, permission) DO NOTHING;

INSERT INTO role_grants (role_id, permission, scope)
SELECT id, 'ai.prompt.manage', 'DEPARTMENT' FROM roles WHERE name = 'Manager' AND system
ON CONFLICT (role_id, permission) DO NOTHING;
