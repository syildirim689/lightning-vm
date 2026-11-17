-- The billing integration now binds an order only to an account it created itself for that system (users.external_source);
-- an address that was marked verified later no longer makes another account a match. Accounts the integration created
-- before migration 075 carry no mark, so they are marked here from the record of their creation: the audit row
-- 'external.customer_created' the integration has written since its first version (target: the account, source: the
-- system). Owning a server of that system is not taken as proof: such an account may be one somebody else registered
-- for the buyer's address, which the old rule matched once it was verified. Those answer CUSTOMER_NEEDS_REVIEW at the
-- next order, and staff hand them over deliberately (POST /admin/external/:source/customers/:id/claim).
UPDATE users u SET external_source = e.source
FROM (SELECT DISTINCT ON (metadata->>'target') metadata->>'target' AS target, metadata->>'source' AS source FROM audit_events
      WHERE action = 'external.customer_created' AND outcome = 'success' AND metadata->>'source' ~ '^[A-Za-z0-9_-]{1,60}$'
      ORDER BY metadata->>'target', created_at) e
WHERE u.id::text = e.target AND u.external_source IS NULL AND u.reseller_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM resellers r WHERE r.user_id = u.id);
