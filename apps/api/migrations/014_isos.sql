-- ISO library: storages the admin connects (FTP/FTPS, SFTP, WebDAV, S3, SMB, HTTP; read through rclone),
-- ISO files copied from them into a location's datastore, and the ISO a server's CD-ROM holds.
CREATE TABLE iso_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  protocol text NOT NULL CHECK (protocol IN ('ftp', 'sftp', 'webdav', 's3', 'smb', 'http')),
  config jsonb NOT NULL DEFAULT '{}',      -- rclone options without secrets
  secrets_enc text,                         -- rclone secret options (JSON), encrypted
  base_path text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE isos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  file_name text NOT NULL,
  pool_id uuid NOT NULL REFERENCES resource_pools(id) ON DELETE RESTRICT,
  datastore_moref text NOT NULL,
  source_id uuid REFERENCES iso_sources(id) ON DELETE SET NULL,
  source_path text NOT NULL,
  size_bytes bigint,
  copied_bytes bigint NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'copying' CHECK (state IN ('copying', 'ready', 'failed', 'deleting')),
  error text,
  public boolean NOT NULL DEFAULT true,     -- customers may insert it into their servers
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pool_id, datastore_moref, file_name)
);

ALTER TABLE servers ADD COLUMN iso_id uuid REFERENCES isos(id) ON DELETE SET NULL,
  ADD COLUMN iso_boot boolean NOT NULL DEFAULT false;
