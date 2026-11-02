# Repo rules for the AI reviewer

These replace generic best practice. A finding that cites no rule here is a nit.

- Auth is a per-session token in the `x-token` header, stored in `sessions`. Never
  suggest JWT or an external identity provider for this example.
- Passwords are scrypt-hashed in `users.pass_hash`. Never log, echo or return them.
- Every query touching `orders` or `addresses` must filter by `user_id`. A missing
  filter is a blocker, not a suggestion.
- Migrations are append-only: never edit an applied file in `app/migrations/`,
  add a new one.
- A change to any handler in `app/server.mjs` needs an e2e assertion on the new
  behaviour; flag changed handlers that no test in `docs/features.yaml` covers.
- The UI is deliberately framework-free. Do not propose React, bundlers or a build step.
