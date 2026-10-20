-- 0017 data-rights requests (Phase 23; D-169; R-55; trust-and-safety §14, database-design §3). Customers ask for
-- access (a copy), correction or erasure in the app; trust & safety fulfils within the due date and records the
-- outcome. Erasure is anonymisation in place by an audited runbook (production-readiness §6) until automated.
CREATE TABLE users.data_requests (
  id           uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES identity.users (id),
  kind         text NOT NULL CHECK (kind IN ('ACCESS', 'CORRECTION', 'ERASURE')),
  details      text CHECK (char_length(details) <= 500),
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'COMPLETED', 'REJECTED')),
  due_at       timestamptz NOT NULL,
  resolution   text CHECK (char_length(resolution) <= 500),
  resolved_by  uuid REFERENCES identity.users (id),
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'OPEN') = (resolved_at IS NULL)),
  CHECK (status = 'OPEN' OR resolution IS NOT NULL)
);
-- One open request of each kind per person: a second tap returns the first.
CREATE UNIQUE INDEX data_requests_open_uq ON users.data_requests (user_id, kind) WHERE status = 'OPEN';
CREATE INDEX data_requests_status_ix ON users.data_requests (status, due_at);
