-- The update reporter installed by itself on a new (or reinstalled) Linux server: the panel address and the
-- token, encrypted, until the worker has put them into the server's cloud-init and the first report arrived.
ALTER TABLE server_updates ADD COLUMN IF NOT EXISTS install_enc text;
