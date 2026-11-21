import type { SeoReport } from '../../src/worker/seo.js';
import type { ArticleOutline } from '../../src/worker/provider.js';

export type WritingStage = 'research' | 'outline' | 'draft' | 'seo_check' | 'seo_repair';
export type SeoRepairStatus = 'not_needed' | 'applied' | 'kept_draft' | 'skipped';

export interface Session {
  username: string;
  csrf_token: string;
}

export interface CatalogModel {
  model: string;
  display_name: string;
  enabled: boolean;
}

export interface CatalogProvider {
  provider: string;
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
  allowed_models: string[] | null;
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
  domain: string;
  webhook_url: string | null;
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
  attempts: number;
  history?: { id: string; attempted_at?: string; started_at?: string; finished_at?: string; http_status?: number; error?: string }[];
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
  };
  capacity: {
    writer_per_process: number;
    webhook_per_process: number;
  };
  providers: {
    provider: string;
    writing: number;
    queued: number;
    active_threads: number;
  }[];
  running: (Job & { lease_active: boolean; elapsed_seconds: number })[];
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
    unpriced_attempts: number;
  };
  series: {
    date: string;
    articles: number;
    delivered: number;
    service_cost_usd: string | number;
    customer_cost_usd: string | number;
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
