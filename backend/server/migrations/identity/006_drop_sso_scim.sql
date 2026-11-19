-- Single sign-on and SCIM provisioning removed: people sign in with their email and password only.
-- A person marked "SSO only" gets their password sign-in back (they set one through a reset link if they have none);
-- sessions opened through the IdP stay valid until they expire.
UPDATE auth_sessions SET method = 'password' WHERE method = 'sso';
ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_method_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_method_check CHECK (method = 'password');
ALTER TABLE auth_sessions DROP COLUMN idp;
ALTER TABLE users DROP COLUMN sso_only;
-- SCIM's externalId; nothing else sets it.
DROP INDEX members_external_id;
ALTER TABLE members DROP COLUMN external_id;
DROP TABLE user_identities;
DROP TABLE sso_states;
DROP TABLE sso_configs;
-- The SCIM-only permission: off every role and API key.
DELETE FROM role_grants WHERE permission = 'member.provision';
UPDATE api_keys SET permissions = array_remove(permissions, 'member.provision') WHERE 'member.provision' = ANY(permissions);
DELETE FROM agent_grants WHERE permission = 'member.provision';
