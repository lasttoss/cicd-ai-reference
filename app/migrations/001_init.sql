-- Applied at most once; tracked in schema_migrations.
CREATE TABLE IF NOT EXISTS users (
  id         bigserial PRIMARY KEY,
  email      text UNIQUE NOT NULL,
  pass_hash  text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      text PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS addresses (
  user_id  bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  line     text NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id         bigserial PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item       text NOT NULL,
  status     text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id);
