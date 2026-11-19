CREATE TABLE ai_providers (
  provider text PRIMARY KEY CHECK (provider IN ('openai', 'anthropic', 'xai')),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  enabled boolean NOT NULL DEFAULT true
);

CREATE TABLE ai_models (
  model text PRIMARY KEY CHECK (model ~ '^[A-Za-z0-9._/-]{1,160}$'),
  provider text NOT NULL REFERENCES ai_providers(provider),
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  enabled boolean NOT NULL DEFAULT true
);

INSERT INTO ai_providers(provider, display_name) VALUES
  ('openai', 'OpenAI'), ('anthropic', 'Anthropic'), ('xai', 'xAI');

INSERT INTO ai_models(provider, model, display_name, enabled) VALUES
  ('openai', 'gpt-4.1', 'GPT-4.1', true),
  ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', false),
  ('xai', 'grok-4.3', 'Grok 4.3', false);

-- Keep model grants already recorded in customer packages available after upgrading.
WITH granted AS (
  SELECT DISTINCT model FROM customers CROSS JOIN LATERAL unnest(allowed_models) AS grant_list(model)
), mapped AS (
  SELECT model, CASE
    WHEN model LIKE 'claude-%' THEN 'anthropic'
    WHEN model LIKE 'grok-%' THEN 'xai'
    WHEN model ~ '^(gpt-|chatgpt-|o[1-9](-|$))' THEN 'openai'
  END AS provider
  FROM granted WHERE model ~ '^[A-Za-z0-9._/-]{1,160}$'
)
INSERT INTO ai_models(provider, model, display_name, enabled)
SELECT provider, model, model, true FROM mapped WHERE provider IS NOT NULL
ON CONFLICT (model) DO UPDATE SET enabled=true;
