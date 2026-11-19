ALTER TABLE ai_models
  DROP CONSTRAINT IF EXISTS ai_models_model_check,
  ADD CONSTRAINT ai_models_model_check CHECK (model ~ '^[A-Za-z0-9._/-]{1,160}$');
