-- Adds a free-text note to the address (feature shipped without an e2e test on purpose).
ALTER TABLE addresses ADD COLUMN IF NOT EXISTS note text;
