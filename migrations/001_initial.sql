CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text,
  phone text,
  notes text,
  key_mode text NOT NULL DEFAULT 'own' CHECK (key_mode IN ('own', 'service')),
  daily_limit integer CHECK (daily_limit >= 0),
  monthly_limit integer CHECK (monthly_limit >= 0),
  starts_at timestamptz,
  ends_at timestamptz,
  allowed_models text[] NOT NULL DEFAULT '{}',
  max_length integer CHECK (max_length > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR starts_at < ends_at)
);

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id),
  name text NOT NULL,
  domain text NOT NULL,
  webhook_url text NOT NULL,
  webhook_secret text NOT NULL,
  token_hash text UNIQUE,
  token_prefix text,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sites_customer ON sites(customer_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id uuid NOT NULL REFERENCES sites(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  client_request_id text NOT NULL,
  request_hash text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('scheduled', 'preview', 'rewrite')),
  source_article_id uuid REFERENCES jobs(id),
  version integer NOT NULL DEFAULT 1,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'xai')),
  model text NOT NULL,
  keyword text NOT NULL,
  tone text NOT NULL,
  style text NOT NULL,
  length integer NOT NULL CHECK (length > 0),
  instructions text,
  key_mode text NOT NULL CHECK (key_mode IN ('own', 'service')),
  encrypted_key text,
  status text NOT NULL CHECK (status IN ('scheduled', 'queued', 'writing', 'ready', 'failed', 'canceled')),
  scheduled_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(site_id, client_request_id),
  CHECK (mode <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK (mode <> 'rewrite' OR source_article_id IS NOT NULL),
  CHECK (status <> 'ready' OR (result IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX jobs_queue ON jobs(available_at, id) WHERE status IN ('scheduled', 'queued');
CREATE INDEX jobs_lease ON jobs(lease_expires_at) WHERE status = 'writing';
CREATE INDEX jobs_site_schedule ON jobs(site_id, scheduled_at, id) WHERE mode = 'scheduled';
CREATE INDEX jobs_site_articles ON jobs(site_id, completed_at DESC, id DESC) WHERE status = 'ready';
CREATE INDEX jobs_customer_created ON jobs(customer_id, created_at DESC, id DESC);
CREATE INDEX jobs_customer_dispatch ON jobs(customer_id, started_at DESC) WHERE started_at IS NOT NULL;

CREATE TABLE quota_reservations (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id),
  quota_day date NOT NULL,
  quota_month date NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'used', 'released'))
);
CREATE INDEX quota_by_day ON quota_reservations(customer_id, quota_day) WHERE status IN ('reserved', 'used');
CREATE INDEX quota_by_month ON quota_reservations(customer_id, quota_month) WHERE status IN ('reserved', 'used');

CREATE TABLE model_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'xai')),
  model text NOT NULL,
  effective_at timestamptz NOT NULL,
  source_url text NOT NULL,
  rates jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model, effective_at)
);

CREATE TABLE ai_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'xai')),
  model text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  provider_response_id text,
  pricing_id uuid REFERENCES model_prices(id),
  pricing_snapshot jsonb,
  usage jsonb,
  cost_usd numeric(30, 12) CHECK (cost_usd >= 0),
  cost_source text,
  status text NOT NULL DEFAULT 'running',
  error_code text,
  error text
);
CREATE INDEX ai_attempts_job ON ai_attempts(job_id, requested_at);
CREATE INDEX ai_attempts_provider_running ON ai_attempts(provider, requested_at) WHERE finished_at IS NULL;

CREATE TABLE provider_limits (
  provider text PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz,
  requests integer NOT NULL DEFAULT 0,
  tokens bigint NOT NULL DEFAULT 0
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  site_id uuid NOT NULL REFERENCES sites(id),
  event text NOT NULL CHECK (event IN ('article.ready', 'article.failed')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempt_count integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  delivered_at timestamptz,
  error text,
  http_status integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, event)
);
CREATE INDEX webhook_queue ON webhook_deliveries(next_attempt_at, id) WHERE status = 'pending';
CREATE INDEX webhook_lease ON webhook_deliveries(lease_expires_at) WHERE status = 'sending';

CREATE TABLE webhook_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  http_status integer,
  error text
);
CREATE INDEX webhook_attempts_delivery ON webhook_attempts(delivery_id, attempted_at);
