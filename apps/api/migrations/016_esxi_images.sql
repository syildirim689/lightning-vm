-- Nested ESXi images: an image family whose template is set up through vApp (OVF) properties, not cloud-init.
ALTER TABLE os_images DROP CONSTRAINT IF EXISTS os_images_family_check;
ALTER TABLE os_images ADD CONSTRAINT os_images_family_check CHECK (family IN ('linux', 'windows', 'esxi'));
