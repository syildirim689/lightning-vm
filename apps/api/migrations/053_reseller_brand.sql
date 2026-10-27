-- A reseller's own brand (reseller.ts): their customers see this name and colour in the panel instead of the operator's.
ALTER TABLE resellers ADD COLUMN brand_name text CHECK (brand_name IS NULL OR length(brand_name) BETWEEN 1 AND 60),
  ADD COLUMN brand_accent text CHECK (brand_accent IS NULL OR brand_accent ~ '^#[0-9a-fA-F]{6}$');
