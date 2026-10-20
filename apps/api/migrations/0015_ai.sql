-- 0015 AI layer (Phase 22; docs/ai-strategy.md; D-163..). One row per AI invocation for cost, latency, error,
-- fallback and evaluation tracking. Deliberately no prompt or response text, no user, no IP (D-166).
CREATE SCHEMA ai;

CREATE TABLE ai.invocations (
  id               uuid PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  feature          text NOT NULL CHECK (feature IN ('SEARCH_INTENT')),
  provider         text NOT NULL CHECK (provider IN ('anthropic', 'scripted', 'rules')),  -- who produced the answer
  model            text CHECK (char_length(model) <= 80),
  fallback_reason  text CHECK (fallback_reason IN ('NO_PROVIDER', 'BUDGET', 'TIMEOUT', 'ERROR', 'INVALID_OUTPUT')),
  error_code       text CHECK (char_length(error_code) <= 80),
  latency_ms       integer NOT NULL CHECK (latency_ms >= 0),        -- model call only (0 for rules)
  total_ms         integer NOT NULL CHECK (total_ms >= 0),          -- whole request incl. tools
  input_tokens     integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens    integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_micro_usd   bigint NOT NULL DEFAULT 0 CHECK (cost_micro_usd >= 0),
  tool_calls       integer NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
  fields_understood integer NOT NULL DEFAULT 0 CHECK (fields_understood >= 0),
  not_understood   integer NOT NULL DEFAULT 0 CHECK (not_understood >= 0),
  feedback         text CHECK (feedback IN ('HELPFUL', 'NOT_HELPFUL')),
  feedback_at      timestamptz,
  CHECK ((feedback IS NULL) = (feedback_at IS NULL)),
  CHECK (provider <> 'rules' OR (input_tokens = 0 AND output_tokens = 0 AND cost_micro_usd = 0))
);
CREATE INDEX invocations_at_ix ON ai.invocations (at);
