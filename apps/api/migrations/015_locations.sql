-- Locations: where servers run (city, country, datacenter, coordinates, status, test endpoints). A resource
-- pool belongs to one; resource_pools.location keeps the location's name (shown everywhere it was before).
CREATE TABLE locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
  city text NOT NULL DEFAULT '',
  country_code text NOT NULL DEFAULT '' CHECK (country_code ~ '^([A-Z]{2})?$'),
  datacenter text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  latitude numeric(8,5) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(8,5) CHECK (longitude BETWEEN -180 AND 180),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'hidden')),
  ping_url text NOT NULL DEFAULT '',
  looking_glass_url text NOT NULL DEFAULT '',
  test_ip inet,
  sort integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE resource_pools ADD COLUMN location_id uuid REFERENCES locations(id) ON DELETE SET NULL;

-- Existing pools: one location per distinct name they already used.
INSERT INTO locations (name) SELECT DISTINCT location FROM resource_pools WHERE location <> '' ON CONFLICT DO NOTHING;
UPDATE resource_pools p SET location_id = l.id FROM locations l WHERE l.name = p.location;
