-- Backfill a default address so the UI never renders an empty state.
INSERT INTO addresses (user_id, line)
SELECT id, 'not set' FROM users
ON CONFLICT (user_id) DO NOTHING;
