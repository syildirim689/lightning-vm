-- Optional root password chosen at order time (passwords.ts): the guest gets the SHA-512 crypt hash through
-- cloud-init; the encrypted copy lets the owner look it up until they choose to forget it.
ALTER TABLE servers
  ADD COLUMN root_password_hash text,
  ADD COLUMN root_password_enc text;
