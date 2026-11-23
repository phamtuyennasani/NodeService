import type { SeoReport } from '../../src/worker/seo.js';
import type { ArticleOutline } from '../../src/worker/provider.js';

export type WritingStage = 'research' | 'outline' | 'draft' | 'seo_check' | 'seo_repair';
export type SeoRepairStatus = 'not_needed' | 'applied' | 'kept_draft' | 'skipped';

export interface Session {
  username: string;
  csrf_token: string;
  browser_binding?: string;
  server_time?: number;
  display_name?: string;
  email?: string | null;
  email_verified?: boolean;
  remember_me?: boolean;
}

export interface LoginChallenge {
  otp_required: true;
  challenge_id: string;
  email_hint: string;
  expires_in: number;
  resend_after: number;
  server_time?: number;
}

export interface AccountProfile {
  username: string;
  display_name: string;
  email: string | null;
  email_verified: boolean;
  mail_configured: boolean;
  remember_me: boolean;
  devices: {
    id: string;
    label: string;
    created_at: string;
    last_used_at: string;
    expires_at: string;
    current: boolean;
  }[];
}

export interface EmailChallenge {
  challenge_id: string;
  email_hint: string;
  current_email_hint?: string;
  requires_current_code: boolean;
  expires_in: number;
  resend_after: number;
}

export interface CatalogModel {
  model: string;
  upstream_model?: string;
  display_name: string;
  enabled: boolean;
}

export interface CatalogProvider {
  provider: string;
  kind?: 'openai' | 'anthropic' | 'xai' | 'openai-compatible';
  display_name: string;
  service_key_configured: boolean;
  base_url?: string | null;
  api_key_configured?: boolean;
  enabled: boolean;
  models: CatalogModel[];
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notes: string | null;
  key_mode: 'own' | 'service';
  daily_limit: number | null;
  monthly_limit: number | null;
  allowed_models: string[];
  max_length: number | null;
  active_from: string | null;
  active_until: string | null;
  website_count: number;
  article_count: number;
}

export interface Website {
  id: string;
  name: string;
  customer_id: string;
  customer_name: string;
  key_mode?: 'own' | 'service';
  domain: string;
  webhook_url: string | null;
  content_catalog_url?: string | null;
  content_catalog_checked_at?: string | null;
  content_catalog_synced_at?: string | null;
  content_catalog_error?: string | null;
  content_catalog_count?: number;
  token_hint: string | null;
  webhook_secret_configured?: boolean;
  last_seen_at: string | null;
  article_count: number;
}

export interface UsagePeriod {
  limit: number;
  used: number;
  reserved: number;
  remaining: number;
  resets_at: string;
}

export interface Usage {
  day: UsagePeriod | null;
  month: UsagePeriod | null;
  reservations?: {
    job_id: string;
    quota_day: string;
    status: 'used' | 'reserved';
    keyword: string;
    scheduled_at: string | null;
    website_name: string;
  }[];
}

export interface Job {
  id: string;
  job_id?: string;
  customer_id: string;
  customer_name: string;
  website_id: string;
  website_name: string;
  mode: string;
  status: string;
  writing_stage?: WritingStage | null;
  can_rewrite?: boolean;
  keyword: string;
  model: string;
  upstream_model?: string;
  provider_display_name?: string;
  tone: string;
  style: string;
  length: number;
  use_research?: boolean;
  created_at: string;
  updated_at?: string;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  source_article_id: string | null;
  retry_of_job_id?: string | null;
  idempotency_key?: string;
  cost_usd?: string | null;
  cost_vnd?: string | null;
  provider?: string;
  key_mode?: string;
  attempt_count?: number;
  delivery_status?: string | null;
  instructions?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface Article {
  Title: string;
  Content: string;
  Slug: string;
  Desc: string;
  Description: string;
  Keywords: string[];
}

export interface Attempt {
  id: string;
  provider: string;
  model: string;
  upstream_model?: string;
  status: string;
  stage?: 'outline' | 'draft' | 'seo_repair' | null;
  started_at: string;
  called_at?: string;
  pricing_id?: string | null;
  pricing_snapshot?: object | null;
  provider_response_id?: string | null;
  usage?: object | null;
  finished_at?: string | null;
  cost_usd?: string | number | null;
  cost_vnd?: string | number | null;
  cost_source?: string | null;
  error_code?: string | null;
  error_message?: string | null;
}

export interface Delivery {
  id: string;
  job_id: string;
  website_name: string;
  customer_name?: string;
  status: string;
  event_type: string;
  keyword?: string;
  attempt_count: number;
  last_http_status?: number | null;
  last_error?: string | null;
  id_post?: string | number | null;
  acknowledged_at?: string | null;
  attempts: number;
  history?: { id: string; attempted_at?: string; started_at?: string; finished_at?: string; http_status?: number | null; error?: string | null; id_post?: string | number | null; acknowledged_at?: string | null }[];
  next_attempt_at?: string | null;
  delivered_at?: string | null;
  created_at: string;
}

export type JobDetails = Job & {
  rewrite_key_mode?: 'own' | 'service';
  outline?: ArticleOutline | null;
  result?: Article[] | null;
  seo_report?: SeoReport | null;
  seo_repair_status?: SeoRepairStatus | null;
  internal_link_report?: {
    status: 'checked' | 'no_candidates' | 'unavailable';
    candidates: number;
    used: { url: string; anchor: string }[];
    removed: number;
    checked_at: string;
  } | null;
  attempts?: Attempt[];
  deliveries?: Delivery[];
};

export interface DashboardRuntime {
  observed_at: string;
  summary: {
    writing: number;
    queued: number;
    scheduled: number;
    active_threads: number;
    stale_writing: number;
    overdue_schedules?: number;
    oldest_wait_seconds?: number | null;
  };
  capacity: {
    writer_per_process: number;
    webhook_per_process: number;
  };
  providers: {
    provider: string;
    display_name?: string;
    writing: number;
    queued: number;
    active_threads: number;
  }[];
  running: (Job & { lease_active: boolean; elapsed_seconds: number })[];
  deliveries?: {
    pending: number; sending: number; failed: number; active_threads: number;
    stale_sending: number; oldest_wait_seconds: number | null;
  };
  attention?: {
    write_errors: number; delivery_errors: number; stale_writing: number;
    stale_sending: number; unpriced_attempts: number;
  };
  workers?: Record<'writer' | 'webhook', {
    processes: number; accepting_processes?: number; concurrency: number; active_tasks: number; last_heartbeat_at: string | null;
  }>;
  write_failures?: Job[];
  delivery_failures?: Delivery[];
}

export interface DashboardData {
  metrics: {
    customers: number;
    websites: number;
    articles: number;
    delivered: number;
    pending: number;
    write_errors: number;
    delivery_errors: number;
    service_cost_usd: string | number;
    customer_cost_usd: string | number;
    service_cost_vnd: string | number;
    customer_cost_vnd: string | number;
    total_cost_vnd: string | number;
    unpriced_attempts: number;
  };
  series: {
    date: string;
    articles: number;
    delivered: number;
    service_cost_usd: string | number;
    customer_cost_usd: string | number;
    service_cost_vnd: string | number;
    customer_cost_vnd: string | number;
    unpriced_attempts: number;
  }[];
  upcoming: Job[];
  failures: Job[];
}

export interface Price {
  id: string;
  provider: string;
  model: string;
  effective_at: string;
  total_vnd: string | null;
  input_usd?: string | null;
  cached_input_usd?: string | null;
  output_usd?: string | null;
  cache_write_5m_usd?: string | null;
  cache_write_1h_usd?: string | null;
  source_url: string | null;
  request_usd?: string | null;
  long_context_threshold?: number | null;
  long_context_input_usd?: string | null;
  long_context_cached_input_usd?: string | null;
  long_context_output_usd?: string | null;
}

export interface Collection<T> {
  data: T[];
  next_cursor?: string | null;
}
