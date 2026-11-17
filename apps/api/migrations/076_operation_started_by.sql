-- Who started an operation (owner_id is whose server it is): a customer cancels only what they started themselves, not
-- what staff, the billing run, a schedule or the billing integration started (those are NULL or another account).
ALTER TABLE operations ADD COLUMN started_by uuid REFERENCES users(id) ON DELETE SET NULL;
