ALTER TABLE ai_providers
  DROP CONSTRAINT ai_providers_provider_check,
  ADD CONSTRAINT ai_providers_provider_check CHECK (provider IN ('openai', 'anthropic', 'xai', 'openai-compatible'));

ALTER TABLE jobs
  DROP CONSTRAINT jobs_provider_check,
  ADD CONSTRAINT jobs_provider_check CHECK (provider IN ('openai', 'anthropic', 'xai', 'openai-compatible'));

ALTER TABLE model_prices
  DROP CONSTRAINT model_prices_provider_check,
  ADD CONSTRAINT model_prices_provider_check CHECK (provider IN ('openai', 'anthropic', 'xai', 'openai-compatible'));

ALTER TABLE ai_attempts
  DROP CONSTRAINT ai_attempts_provider_check,
  ADD CONSTRAINT ai_attempts_provider_check CHECK (provider IN ('openai', 'anthropic', 'xai', 'openai-compatible'));

ALTER TABLE ai_providers
  ADD COLUMN base_url text,
  ADD COLUMN encrypted_api_key text;

INSERT INTO ai_providers(provider, display_name, enabled)
VALUES ('openai-compatible', 'OpenAI Compatible', false)
ON CONFLICT (provider) DO NOTHING;
