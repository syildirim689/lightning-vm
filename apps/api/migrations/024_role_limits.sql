-- Roles carry limits besides permissions (role-limits.ts): quotas, counts, operations per hour, session length,
-- required two-factor, allowed locations and addresses. What a customer may do on a server becomes permissions
-- too (server.*), given to every role that could create servers so nobody loses an ability they had.
ALTER TABLE roles ADD COLUMN limits jsonb NOT NULL DEFAULT '{}';
UPDATE roles SET permissions = ARRAY(SELECT DISTINCT p FROM unnest(permissions || ARRAY['server.power', 'server.console', 'server.delete', 'server.snapshots', 'server.iso', 'server.root_password']) p ORDER BY p),
  updated_at = now()
  WHERE key = 'user' OR 'servers.create' = ANY(permissions);
