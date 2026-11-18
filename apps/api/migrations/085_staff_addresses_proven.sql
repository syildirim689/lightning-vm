-- users.email_verified now means "the address is proven": an account without it loses what was set up before (API
-- tokens, passkeys, SSH keys, saved cards, ...) at its first password reset by mail or sign-in by link or code, because
-- somebody else may have registered the address first (better-auth.ts, addressProven). The setup administrator and the
-- accounts staff make in Admin → Users are marked proven when they are created, but only since this version: the ones
-- that were there before carry no mark, and an administrator's first "forgot password" would take their passkeys and
-- tokens. They are marked here from what staff have already vouched for:
--   * holding any role besides the customer role ("user"): roles are given by staff (users.roles), by the setup wizard
--     or by a directory mapping, never by registering;
--   * the audit row 'admin.user.create' (target: the account), which the Admin → Users route has written since its
--     first version and nothing else writes: a reseller's customers and the billing integration's are made without a
--     request and leave no such row.
-- Everything else stays as it is: accounts people registered themselves, a reseller's customers and those of a billing
-- system prove their address the usual way. Running it again changes nothing.
UPDATE users u SET email_verified = true
WHERE NOT coalesce(u.email_verified, false)
  AND (EXISTS (SELECT 1 FROM unnest(string_to_array(coalesce(u.role, 'user'), ',')) AS held(key) WHERE btrim(held.key) NOT IN ('', 'user'))
    OR EXISTS (SELECT 1 FROM audit_events e WHERE e.action = 'admin.user.create' AND e.outcome = 'success'
               AND e.metadata->>'target' = u.id::text AND e.actor_id IS NOT NULL AND e.actor_id::text <> u.id::text));
