-- Accounts the billing integration created (external.ts), and for which system. A later order from that system finds its
-- own account again; any other existing account is matched only when its owner proved the address (and it is not a
-- reseller's or a reseller), otherwise the integration is told to have staff resolve it.
-- Accounts from before this column are not marked: an account that merely owns an externally billed server may be one
-- somebody else registered for the buyer's address, which is what this guards against.
ALTER TABLE users ADD COLUMN external_source text;
