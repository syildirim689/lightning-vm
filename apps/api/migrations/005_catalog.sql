-- Projects group a customer's servers; quotas can apply per user or per project.
CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

-- A resource pool opens existing capacity (one cluster or host, chosen datastores, one network)
-- for sale or use. It creates no physical resources. Overcommit is set per resource type.
CREATE TABLE resource_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  location text NOT NULL DEFAULT '' CHECK (length(location) <= 100),
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE RESTRICT,
  compute_moref text NOT NULL,
  datastore_morefs text[] NOT NULL CHECK (cardinality(datastore_morefs) >= 1),
  network_moref text NOT NULL,
  cpu_overcommit numeric(5,2) NOT NULL DEFAULT 4 CHECK (cpu_overcommit BETWEEN 1 AND 32),
  memory_overcommit numeric(5,2) NOT NULL DEFAULT 1 CHECK (memory_overcommit BETWEEN 1 AND 4),
  storage_overcommit numeric(5,2) NOT NULL DEFAULT 1 CHECK (storage_overcommit BETWEEN 1 AND 10),
  reserve_cpu_pct int NOT NULL DEFAULT 10 CHECK (reserve_cpu_pct BETWEEN 0 AND 90),
  reserve_memory_pct int NOT NULL DEFAULT 10 CHECK (reserve_memory_pct BETWEEN 0 AND 90),
  reserve_storage_pct int NOT NULL DEFAULT 15 CHECK (reserve_storage_pct BETWEEN 0 AND 90),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Operating system images are VM templates in a connection's inventory.
CREATE TABLE os_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  family text NOT NULL CHECK (family IN ('linux', 'windows')),
  connection_id uuid NOT NULL REFERENCES vmware_connections(id) ON DELETE RESTRICT,
  template_moref text NOT NULL,
  min_disk_gb int NOT NULL DEFAULT 10 CHECK (min_disk_gb BETWEEN 1 AND 65536),
  cloud_init boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, template_moref)
);

-- Money is numeric with an ISO 4217 currency; never floating point.
CREATE TABLE packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  vcpu int NOT NULL CHECK (vcpu BETWEEN 1 AND 256),
  memory_mb int NOT NULL CHECK (memory_mb BETWEEN 512 AND 4194304),
  disk_gb int NOT NULL CHECK (disk_gb BETWEEN 1 AND 65536),
  price_monthly numeric(12,2) NOT NULL CHECK (price_monthly >= 0),
  price_hourly numeric(12,4) CHECK (price_hourly >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  sort int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE package_pools (
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  pool_id uuid NOT NULL REFERENCES resource_pools(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, pool_id)
);
CREATE TABLE package_images (
  package_id uuid NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  image_id uuid NOT NULL REFERENCES os_images(id) ON DELETE CASCADE,
  PRIMARY KEY (package_id, image_id)
);

-- Custom-resource offering of one pool: ranges, steps, allowed RAM-per-vCPU ratio and unit prices.
CREATE TABLE custom_rules (
  pool_id uuid PRIMARY KEY REFERENCES resource_pools(id) ON DELETE CASCADE,
  cpu_min int NOT NULL, cpu_max int NOT NULL, cpu_step int NOT NULL,
  memory_min_mb int NOT NULL, memory_max_mb int NOT NULL, memory_step_mb int NOT NULL,
  disk_min_gb int NOT NULL, disk_max_gb int NOT NULL, disk_step_gb int NOT NULL,
  min_memory_mb_per_vcpu int NOT NULL DEFAULT 512, max_memory_mb_per_vcpu int NOT NULL DEFAULT 16384,
  price_vcpu numeric(12,4) NOT NULL CHECK (price_vcpu >= 0),
  price_memory_gb numeric(12,4) NOT NULL CHECK (price_memory_gb >= 0),
  price_disk_gb numeric(12,4) NOT NULL CHECK (price_disk_gb >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  CHECK (cpu_min >= 1 AND cpu_min <= cpu_max AND cpu_step >= 1),
  CHECK (memory_min_mb >= 512 AND memory_min_mb <= memory_max_mb AND memory_step_mb >= 128),
  CHECK (disk_min_gb >= 1 AND disk_min_gb <= disk_max_gb AND disk_step_gb >= 1),
  CHECK (min_memory_mb_per_vcpu >= 1 AND min_memory_mb_per_vcpu <= max_memory_mb_per_vcpu)
);

-- One default row; user and project rows override it. A NULL limit means "no limit".
CREATE TABLE quotas (
  scope text NOT NULL CHECK (scope IN ('default', 'user', 'project')),
  subject_id uuid,
  max_servers int CHECK (max_servers >= 0),
  max_vcpu int CHECK (max_vcpu >= 0),
  max_memory_mb int CHECK (max_memory_mb >= 0),
  max_disk_gb int CHECK (max_disk_gb >= 0),
  CHECK ((scope = 'default') = (subject_id IS NULL))
);
CREATE UNIQUE INDEX quotas_scope_subject_key ON quotas (scope, COALESCE(subject_id, '00000000-0000-0000-0000-000000000000'));
INSERT INTO quotas (scope, max_servers, max_vcpu, max_memory_mb, max_disk_gb) VALUES ('default', 5, 16, 32768, 500);

-- IPv4 ranges handed out on a pool's network. Allocation (atomic, per server) comes with provisioning.
CREATE TABLE ip_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  pool_id uuid NOT NULL REFERENCES resource_pools(id) ON DELETE RESTRICT,
  cidr cidr NOT NULL CHECK (family(cidr) = 4),
  gateway inet NOT NULL,
  dns inet[] NOT NULL DEFAULT '{}',
  range_start inet NOT NULL,
  range_end inet NOT NULL,
  excluded inet[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ip_pools_inside_cidr CHECK (gateway << cidr AND range_start << cidr AND range_end << cidr),
  CONSTRAINT ip_pools_range_order CHECK (range_start <= range_end),
  CONSTRAINT ip_pools_gateway_outside_range CHECK (gateway < range_start OR gateway > range_end)
);
