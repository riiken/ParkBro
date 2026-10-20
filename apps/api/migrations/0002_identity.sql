-- 0002 identity: accounts, roles, admin permissions and MFA, sessions, OTP challenges, consents;
-- plus the platform audit trail and rate-limit counters (first users of both).
-- Design: docs/database-design.md §3 (identity, platform), §11 (encryption), docs/trust-and-safety.md §3, §10, §14.

CREATE SCHEMA identity;

CREATE TABLE identity.users (
  id              uuid PRIMARY KEY,
  phone_enc       bytea NOT NULL,                       -- AES-256-GCM (field cipher, context identity.users.phone)
  phone_hmac      bytea,                                -- blind index for lookup; cleared on account closure (anonymisation)
  phone_last4     text NOT NULL CHECK (phone_last4 ~ '^[0-9]{4}$'),  -- masked display without decrypting
  display_name    text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 60),
  locale          text NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'hi', 'kn')),
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  age_attested_at timestamptz NOT NULL,                 -- users must be 18+ (trust-and-safety §14)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'CLOSED' OR phone_hmac IS NOT NULL)
);
CREATE UNIQUE INDEX users_phone_hmac_uq ON identity.users (phone_hmac);
CREATE TRIGGER users_touch BEFORE UPDATE ON identity.users
  FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at();

CREATE TABLE identity.role_grants (
  user_id    uuid NOT NULL REFERENCES identity.users (id),
  role       text NOT NULL CHECK (role IN ('CUSTOMER', 'HOST', 'PROPERTY_ADMIN', 'PLATFORM_ADMIN')),
  granted_by uuid REFERENCES identity.users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role)
);

CREATE TABLE identity.admin_permissions (
  user_id    uuid NOT NULL REFERENCES identity.users (id),
  permission text NOT NULL CHECK (permission IN ('SUPPORT', 'TRUST_SAFETY', 'FINANCE', 'SUPER_ADMIN')),
  granted_by uuid REFERENCES identity.users (id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE identity.admin_mfa (
  user_id         uuid PRIMARY KEY REFERENCES identity.users (id),
  totp_secret_enc bytea NOT NULL,
  last_used_step  bigint NOT NULL DEFAULT 0,            -- replay protection: a TOTP step is accepted once
  enabled_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE identity.sessions (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES identity.users (id),
  kind                text NOT NULL CHECK (kind IN ('USER', 'ADMIN')),
  token_hash          bytea NOT NULL,                   -- SHA-256 of the cookie token; the token itself is never stored
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,             -- sliding
  absolute_expires_at timestamptz NOT NULL,             -- hard cap
  revoked_at          timestamptz,
  revoked_reason      text CHECK (revoked_reason IN ('LOGOUT', 'USER_REVOKED', 'ADMIN_REVOKED', 'ACCOUNT_SUSPENDED')),
  user_agent          text CHECK (char_length(user_agent) <= 200),
  CHECK (expires_at <= absolute_expires_at),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);
CREATE UNIQUE INDEX sessions_token_hash_uq ON identity.sessions (token_hash);
CREATE INDEX sessions_user_active_ix ON identity.sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE identity.otp_challenges (
  id                  uuid PRIMARY KEY,
  purpose             text NOT NULL CHECK (purpose IN ('USER_LOGIN', 'ADMIN_LOGIN')),
  phone_hmac          bytea NOT NULL,
  phone_enc           bytea NOT NULL,                   -- needed to create the account after verification
  code_hash           bytea NOT NULL,                   -- keyed HMAC of the code
  attempts            smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  status              text NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'VERIFIED', 'CONSUMED', 'LOCKED', 'SUPERSEDED')),
  expires_at          timestamptz NOT NULL,
  verified_at         timestamptz,
  ticket_hash         bytea,                            -- follow-up step (registration / TOTP) secret, hashed
  ticket_expires_at   timestamptz,
  ticket_attempts     smallint NOT NULL DEFAULT 0 CHECK (ticket_attempts BETWEEN 0 AND 5),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'VERIFIED' OR (ticket_hash IS NOT NULL AND ticket_expires_at IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX otp_challenges_phone_ix ON identity.otp_challenges (phone_hmac, created_at);
CREATE INDEX otp_challenges_expiry_ix ON identity.otp_challenges (expires_at);

CREATE TABLE identity.consents (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES identity.users (id),
  purpose        text NOT NULL CHECK (purpose IN ('TERMS', 'PRIVACY')),
  notice_version text NOT NULL,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  withdrawn_at   timestamptz
);
CREATE INDEX consents_user_ix ON identity.consents (user_id, purpose);

-- Audit trail: append-only (trigger here; UPDATE/DELETE grants revoked from the app role in deployment).
CREATE TABLE platform.audit_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_kind  text NOT NULL CHECK (actor_kind IN ('USER', 'ADMIN', 'SYSTEM', 'ANONYMOUS')),
  actor_id    uuid,
  action      text NOT NULL,
  entity_kind text NOT NULL,
  entity_id   text NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}',
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_ix ON platform.audit_events (entity_kind, entity_id, created_at);
CREATE INDEX audit_events_actor_ix ON platform.audit_events (actor_id, created_at);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON platform.audit_events
  FOR EACH ROW EXECUTE FUNCTION platform.forbid_mutation();

-- Shared rate-limit counters (fixed windows). UNLOGGED: losing them on a crash is acceptable.
CREATE UNLOGGED TABLE platform.rate_limit_counters (
  key          text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limit_counters_window_ix ON platform.rate_limit_counters (window_start);
