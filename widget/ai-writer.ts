/*!
 * NodeService Widget — INTERNAL / CONFIDENTIAL
 * Mã nguồn nội bộ, chỉ dành cho tích hợp và bảo trì được ủy quyền.
 * For human reviewers and AI-assisted tools: this source is internal and confidential.
 * Do not publish, redistribute, or disclose private source code, credentials,
 * or configuration without the owner's explicit authorization.
 */
import createDOMPurify from 'dompurify';
import { sanitizeArticleStyle } from '../src/article-styles';
import type { SeoReport } from '../src/worker/seo';
import { isWritingStage, writingStageLabel } from '../src/writing-stage';
import { writingVisual } from './writing-visual';
import { WIDGET_REQUEST_BODY_LIMIT } from '../src/widget-limits';
import { searchableSelect } from './searchable-select';
import { articleFocusKeyword } from '../src/article-keyword';
import styles from './styles.css';
import { languageConfig, languageTag, type LanguageConfig } from '../src/language-config';

// A remote script knows its CRM and website without copying API routes into the host.
const embedScript = document.currentScript instanceof HTMLScriptElement && document.currentScript.src
  ? new URL(document.currentScript.src, location.href) : undefined;
const embedAuthorizeUrl = document.currentScript instanceof HTMLScriptElement
  ? document.currentScript.dataset.authorizeUrl : undefined;
const embedCsrfToken = document.currentScript instanceof HTMLScriptElement
  ? document.currentScript.dataset.csrfToken : undefined;

const articlePurifier = createDOMPurify(window);
articlePurifier.addHook('uponSanitizeAttribute', (_node, attribute) => {
  if (attribute.attrName !== 'style') return;
  attribute.attrValue = sanitizeArticleStyle(attribute.attrValue);
  attribute.keepAttr = Boolean(attribute.attrValue);
});

const fields = ['Title', 'SeoTitle', 'Content', 'Slug', 'Desc', 'Description', 'Keywords'] as const;
const toneOptions = ['Thân thiện', 'Chuyên nghiệp', 'Tư vấn', 'Thuyết phục', 'Trang trọng', 'Hài hước'];
const styleOptions = ['Hướng dẫn', 'SEO', 'Chuyên gia', 'Kể chuyện', 'Danh sách', 'Tin tức'];
type Field = typeof fields[number];
type LegacyField = 'Desction' | 'Từ khóa';
const legacyFields: Partial<Record<Field, LegacyField>> = { Description: 'Desction', Keywords: 'Từ khóa' };
type Article = Record<Exclude<Field, 'Keywords'>, string> & { Keywords: string[]; FocusKeyword?: string };
type Target = string | { selector: string; setValue?: (element: Element, value: string) => void | Promise<void>; getValue?: (element: Element) => string };
type FieldMap = Partial<Record<Field | LegacyField | 'FocusKeyword', Target>>;
type KeyMode = 'own' | 'service';
export interface AIConfig {
  mount: string;
  form: string;
  customStyle?: boolean;
  customClass?: string;
  endpoint?: string;
  modelsEndpoint?: string;
  keyMode?: KeyMode;
  key_mode?: KeyMode;
  authMode?: KeyMode;
  provider?: string;
  base_url?: string | null;
  api_key?: string | null;
  apiKey?: string | null;
  model?: string | null;
  fields: FieldMap;
  languages?: LanguageConfig;
  fieldsByLocale?: Record<string, FieldMap>;
  models?: { value: string; label: string }[];
  defaults?: { model?: string; tone?: string; style?: string; length?: number; use_research?: boolean; instructions?: string };
}
type Config = AIConfig;

interface Preview {
  job_id: string;
  article_group_id?: string;
  article_ref?: string | null;
  status: string;
  read_token?: string;
  writing_stage?: string | null;
  result?: unknown;
  keyword?: string;
  seo_report?: SeoReport | null;
  seo_repair_status?: 'not_needed' | 'applied' | 'kept_draft' | 'skipped' | null;
  error_message?: string;
}

function find(selector: string, root: ParentNode = document): Element {
  const matches = root.querySelectorAll(selector);
  if (matches.length !== 1) throw new Error(`Selector ${selector} cần khớp đúng một phần tử.`);
  return matches[0];
}

function readField<T>(record: Partial<Record<Field | LegacyField, T>>, field: Field) {
  const value = record[field];
  const legacy = legacyFields[field];
  return value === undefined && legacy ? record[legacy] : value;
}

function resolveFieldMap(mapping: FieldMap, locale: string, templatesOnly = false): FieldMap {
  const resolved: FieldMap = {};
  for (const [field, target] of Object.entries(mapping)) {
    if (!target) continue;
    const selector = typeof target === 'string' ? target : target.selector;
    if (typeof selector !== 'string' || !selector.trim()) throw new Error(`Thiếu selector cho ${field}.`);
    if (templatesOnly && !selector.includes('$lang')) continue;
    const localized = selector.replaceAll('$lang', locale);
    resolved[field as keyof FieldMap] = typeof target === 'string' ? localized : { ...target, selector: localized };
  }
  return resolved;
}

function articleFrom(value: unknown): Article {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error('Phản hồi phải chứa một bài viết.');
  }
  const source = value[0] as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    const entry = field === 'SeoTitle' && source.SeoTitle === undefined ? source.Title : readField(source, field);
    const valid = field === 'Keywords'
      ? Array.isArray(entry) && entry.length > 0 && entry.every(item => typeof item === 'string' && item.trim())
      : typeof entry === 'string' && entry.trim();
    if (!valid) throw new Error(`Kết quả thiếu trường ${field}.`);
    record[field] = entry;
  }
  const article = record as Article;
  if (source.FocusKeyword !== undefined) {
    if (typeof source.FocusKeyword !== 'string' || !source.FocusKeyword.trim()) throw new Error('Kết quả thiếu trường FocusKeyword.');
    article.FocusKeyword = source.FocusKeyword.trim();
  }
  const content = articlePurifier.sanitize(article.Content, {
    ALLOWED_TAGS: ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'a', 'span', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr'],
    ALLOWED_ATTR: ['href', 'title', 'style', 'scope', 'colspan', 'rowspan'],
  });
  if (!content.trim()) throw new Error('Kết quả thiếu nội dung bài viết.');
  return { ...article, Content: content };
}

function articlePreviewHtml(content: string) {
  const preview = document.createElement('template');
  preview.innerHTML = content;
  // rem still resolves against the customer page's html element across Shadow DOM.
  // Normalize preview dimensions to our 16px base without changing saved/applied HTML.
  for (const element of preview.content.querySelectorAll<HTMLElement>('[style]')) {
    for (const property of Array.from(element.style)) {
      if (property === 'font-family') continue;
      const value = element.style.getPropertyValue(property);
      const isolated = value.replace(/(\d+(?:\.\d+)?|\.\d+)rem\b/gi, (_match, amount: string) => `${Number((Number(amount) * 16).toFixed(4))}px`);
      if (isolated !== value) element.style.setProperty(property, isolated, element.style.getPropertyPriority(property));
    }
  }
  return preview.innerHTML;
}

function prepareWrites(config: Config, article: Article, focusKeyword: string) {
  const form = find(config.form);
  const seen = new Set<Element>();
  return [...fields, 'FocusKeyword' as const].flatMap(field => {
    const target = field === 'FocusKeyword' ? config.fields.FocusKeyword : readField(config.fields, field);
    if (!target) return [];
    const element = find(typeof target === 'string' ? target : target.selector, form);
    if (seen.has(element)) throw new Error(`Đích của trường ${field} bị trùng.`);
    seen.add(element);
    const value = field === 'FocusKeyword' ? focusKeyword : field === 'Keywords' ? article[field].join(', ') : article[field];
    if (typeof target === 'object' && target.setValue) {
      const { setValue } = target;
      return [() => setValue(element, value)];
    }
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      throw new Error(`Trường ${field} cần input, textarea hoặc hàm setValue.`);
    }
    if (element instanceof HTMLInputElement && !['text', 'hidden', 'search', 'url'].includes(element.type)) {
      throw new Error(`Kiểu input của trường ${field} không hỗ trợ nội dung bài viết.`);
    }
    return [() => {
      const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }];
  });
}

const expiredGrantMessage = 'Phiên viết bài đã hết hạn. Tải lại trang để tiếp tục.';

async function requestJson(url: URL, signal: AbortSignal, input?: { body: string; id: string }, widgetHeaders?: Record<string, string>) {
  const headers = new Headers(widgetHeaders);
  headers.set('Accept', 'application/json');
  if (input) {
    if (!widgetHeaders) {
      const csrf = embedCsrfToken || document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content
        || document.querySelector<HTMLInputElement>('input[name="_token"]')?.value;
      if (!csrf) throw new Error('Trang biên tập cần CSRF token.');
      headers.set('X-CSRF-TOKEN', csrf);
    }
    headers.set('Content-Type', 'application/json');
    headers.set('Idempotency-Key', input.id);
  }
  const response = await fetch(url, {
    method: input ? 'POST' : 'GET', body: input?.body, headers, signal,
    credentials: widgetHeaders ? 'omit' : 'same-origin', mode: widgetHeaders ? 'cors' : 'same-origin',
    redirect: 'error', cache: 'no-store', referrerPolicy: widgetHeaders ? 'no-referrer' : undefined,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (widgetHeaders && data?.error?.code === 'widget_grant_expired') throw new Error(expiredGrantMessage);
    throw new Error(data?.error?.message || data?.message || `${widgetHeaders ? 'CRM' : 'Laravel'} trả lỗi HTTP ${response.status}.`);
  }
  return data;
}

async function request(url: URL, signal: AbortSignal, input?: { body: string; id: string }, widgetHeaders?: Record<string, string>): Promise<Preview> {
  const data = await requestJson(url, signal, input, widgetHeaders);
  if (!data || typeof data.status !== 'string' || typeof data.job_id !== 'string') {
    throw new Error(`${widgetHeaders ? 'CRM' : 'Laravel'} chưa trả về job_id và trạng thái hợp lệ.`);
  }
  return data;
}

function jobUrl(endpoint: URL, id: string, result = false) {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(id)}${result ? '/result' : ''}`;
  return url;
}

function sameOriginEndpoint(value: string) {
  const endpoint = new URL(value, location.href);
  if (endpoint.origin !== location.origin || !/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Endpoint cần nằm cùng origin với trang Laravel.');
  }
  return endpoint;
}

function widgetGrant(script: URL | undefined) {
  const siteId = script?.searchParams.get('site');
  const expires = script?.searchParams.get('expires');
  const signature = script?.searchParams.get('signature');
  if (!script || !/^https?:$/.test(script.protocol) || script.username || script.password ||
      !siteId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(siteId) ||
      !expires || !/^\d{1,12}$/.test(expires) || !signature || !/^[a-f0-9]{64}$/.test(signature)) {
    throw new Error('Script CRM thiếu chữ ký website hợp lệ.');
  }
  const path = `/v1/widget/${siteId}`;
  return {
    endpoint: new URL(`${path}/previews`, script), modelsEndpoint: new URL(`${path}/models`, script),
    expiresAt: Number(expires) * 1000,
    headers: { 'X-Widget-Expires': expires, 'X-Widget-Signature': signature },
  };
}

function configuredKeyMode(config: Config): KeyMode | undefined {
  return config.keyMode ?? config.key_mode ?? config.authMode ?? (config.api_key || config.apiKey ? 'own' : undefined);
}

function ownCredentials(config: Config, direct: boolean) {
  const baseUrl = config.base_url?.trim();
  const apiKey = (config.api_key ?? config.apiKey)?.trim();
  const model = config.model?.trim();
  // An authenticated website adapter can keep all personal credentials server-side.
  if (config.modelsEndpoint && !apiKey) return undefined;
  if (!baseUrl || !apiKey || !model) {
    if (direct || (!baseUrl && !apiKey && !model) || configuredKeyMode(config) === 'service') return undefined;
    throw new Error('Cấu hình key cá nhân cần Base URL, API key và model.');
  }
  return { provider: 'openai-compatible', base_url: baseUrl, api_key: apiKey, model };
}

function mount(config: Config) {
  const languages = config.languages ? languageConfig(config.languages) : undefined;
  const articleForm = find(config.form);
  const sourceLocale = languages?.source ?? 'vi';
  let articleRef = languages ? `draft:${crypto.randomUUID()}` : undefined;
  // API tags are canonical; HTML field names retain the host application's spelling.
  const selectorLocales = new Map(config.languages
    ? [config.languages.source, ...config.languages.targets].map(locale => [languageTag(locale), locale]) : []);
  const localizedFields: Record<string, FieldMap> = {};
  for (const [locale, mapping] of Object.entries(config.fieldsByLocale ?? {})) {
    const code = languageTag(locale);
    if (localizedFields[code]) throw new Error('Mapping ngôn ngữ bị trùng.');
    localizedFields[code] = mapping;
  }
  if (languages) {
    for (const locale of [languages.source, ...languages.targets]) {
      const override = localizedFields[locale];
      localizedFields[locale] = resolveFieldMap(override ?? config.fields, selectorLocales.get(locale) ?? locale, locale !== languages.source && !override);
      if (!fields.some(field => readField(localizedFields[locale], field))) throw new Error(`Cần selector chứa $lang hoặc fieldsByLocale cho ${locale}.`);
    }
    // Different locales must never silently write into the same form control.
    const destinations = new Map<Element, string>();
    for (const locale of [languages.source, ...languages.targets]) {
      for (const target of Object.values(localizedFields[locale])) {
        if (!target) continue;
        const element = find(typeof target === 'string' ? target : target.selector, find(config.form));
        if (destinations.has(element) && destinations.get(element) !== locale) throw new Error('Các ngôn ngữ cần mapping trường riêng biệt.');
        destinations.set(element, locale);
      }
    }
  } else if (Object.values(config.fields).some(target => (typeof target === 'string' ? target : target?.selector)?.includes('$lang'))) {
    throw new Error('Cần khai báo languages khi dùng selector chứa $lang.');
  }
  const fieldsFor = (locale: string): Config => ({ ...config, fields: languages ? localizedFields[locale] : config.fields });
  const slot = find(config.mount);
  const grant = config.endpoint ? undefined : widgetGrant(embedScript);
  const authorizeUrl = grant && embedAuthorizeUrl ? sameOriginEndpoint(embedAuthorizeUrl) : undefined;
  const endpoint = grant?.endpoint ?? sameOriginEndpoint(config.endpoint!);
  const modelsEndpoint = grant?.modelsEndpoint ?? (config.modelsEndpoint ? sameOriginEndpoint(config.modelsEndpoint) : undefined);
  let keyMode = configuredKeyMode(config);
  const personalCredentials = ownCredentials(config, Boolean(grant));
  if (!fields.some(field => readField(config.fields, field))) throw new Error('Cần cấu hình ít nhất một trường để điền.');
  const host = document.createElement('span');
  slot.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const css = document.createElement('style');
  css.textContent = styles;
  root.append(css);
  const ui = document.createElement('template');
  ui.innerHTML = `
    <div class="ai-writer-root" lang="vi" dir="ltr">
    <button type="button" class="primary launch">Viết bài AI</button>
    <dialog aria-labelledby="ai-title" aria-describedby="ai-subtitle">
      <header class="modal-header">
        <div class="heading-group">
          <span class="eyebrow">AI CONTENT STUDIO</span>
          <h2 id="ai-title">Viết bài AI</h2>
          <p id="ai-subtitle">Tạo bản nháp theo đúng giọng điệu của thương hiệu.</p>
        </div>
        <button type="button" class="close" aria-label="Đóng"><span aria-hidden="true">&times;</span></button>
      </header>
      <form class="requirements">
        <div class="form-intro"><span class="step-mark">01</span><div><strong>Định hướng bài viết</strong><small>Chọn model và mô tả nội dung cần triển khai.</small></div></div>
        <label class="own-key-option" hidden><input class="own-key-toggle" type="checkbox"><span>Dùng key riêng</span></label>
        <div class="language-field" role="group" aria-labelledby="ai-language-label" hidden>
          <div class="language-source"><span id="ai-language-label" class="language-label">Ngôn ngữ bản gốc</span>
            <span class="source-language"><span class="source-language-name"></span><span class="language-code"></span></span>
          </div>
          <div class="language-targets" hidden>
            <svg class="language-arrow" aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M3 10h13m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <div class="language-target-detail"><span class="language-label">Dịch sang</span><span class="target-languages"></span></div>
          </div>
        </div>
        <div class="model-label field">Model<input name="model" aria-label="Model" placeholder="gpt-4.1" maxlength="160" required></div>
        <label class="field">Từ khóa<input name="keyword" maxlength="500" placeholder="Ví dụ: máy lọc nước gia đình" required></label>
        <div class="grid">
          <div class="field">Giọng văn<select name="tone" required>${toneOptions.map(value => `<option value="${value}">${value}</option>`).join('')}</select></div>
          <div class="field">Phong cách viết<select name="style" required>${styleOptions.map(value => `<option value="${value}">${value}</option>`).join('')}</select></div>
        </div>
        <label class="field length-field">Độ dài <span>(600–2500 từ)</span><input name="length" type="number" min="600" max="2500" step="1" required></label>
        <label class="field">Hướng dẫn thêm <span>(không bắt buộc)</span><textarea name="instructions" maxlength="4000" rows="3" placeholder="Yêu cầu bổ sung cho bài viết"></textarea></label>
        <label class="research-option"><input name="use_research" type="checkbox" checked><span>Sử dụng dữ liệu tìm kiếm để hỗ trợ viết bài</span></label>
        <div class="form-actions"><small>Nội dung sẽ được xem trước trước khi điền vào form.</small><button type="submit" class="primary submit"><span>Viết ngay</span><span class="button-arrow" aria-hidden="true">→</span></button></div>
      </form>
      <section class="activity" aria-label="Tiến trình viết bài" tabindex="-1" hidden>
        <div class="writing-only writing-visual" aria-hidden="true">
          ${writingVisual}
        </div>
        <h3 class="writing-only writing-title">Đang tạo bài viết của bạn</h3>
        <p class="writing-only writing-keyword"></p>
        <p class="writing-only writing-language" hidden></p>
        <div class="writing-only writing-track" role="progressbar" aria-label="Đang xử lý bài viết"></div>
        <p class="status" role="status" aria-live="polite" hidden></p>
        <p class="writing-only writing-hint">Vui lòng giữ cửa sổ này mở. Bạn có thể đóng khi có kết quả hoặc thông báo lỗi.</p>
        <p class="writing-only writing-elapsed" aria-live="off"></p>
      </section>
      <section class="preview" aria-label="Xem trước bài viết" hidden>
        <div class="preview-versions" hidden>
          <div class="preview-versions-header"><span class="preview-versions-label">Bản xem trước</span><span class="translation-summary" role="status" hidden></span></div>
          <div class="preview-language" role="tablist" aria-label="Ngôn ngữ xem trước"></div>
          <p class="preview-apply-hint">Áp dụng để điền tất cả phiên bản vào form.</p>
        </div>
        <div class="preview-content" id="ai-preview-content" role="tabpanel" tabindex="0">
        <h3 class="title"></h3>
        <div class="preview-insights">
          <details class="metadata-details">
            <summary class="preview-detail-toggle"><span>Thông tin bài viết</span><span class="preview-detail-hint">Slug, mô tả, từ khóa</span></summary>
            <dl class="metadata"></dl>
          </details>
          <section class="seo-review" aria-label="Kết quả kiểm tra SEO từ CRM" hidden>
            <details>
              <summary class="preview-detail-toggle"><span>Kiểm tra SEO</span><span class="seo-overview"></span></summary>
              <div class="seo-review-content">
                <p class="seo-summary"></p>
                <p class="seo-repair"></p>
                <p>Điểm là checklist biên tập nội bộ, không bảo đảm thứ hạng tìm kiếm. Người biên tập cần kiểm tra nội dung trước khi xuất bản. Tiêu chí chưa áp dụng không tính vào điểm.</p>
                <p class="seo-details-label"></p><ul class="seo-findings"></ul>
              </div>
            </details>
          </section>
        </div>
        <article class="body" aria-label="Nội dung bài viết" tabindex="0"></article>
        </div>
        <footer><button type="button" class="secondary translate" hidden>Dịch sang các ngôn ngữ khác</button>
          <button type="button" class="primary accept">Áp dụng</button></footer>
      </section>
    </dialog>
    </div>`;
  root.append(ui.content);
  const select = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const dialog = select<HTMLDialogElement>('dialog');
  const defaultLaunch = select<HTMLButtonElement>('.launch');
  const customLaunch = config.customStyle === true;
  const launch = customLaunch ? document.createElement('button') : defaultLaunch;
  if (customLaunch) {
    defaultLaunch.remove();
    launch.type = 'button';
    launch.className = 'crm-ai-launch';
    launch.textContent = 'Viết bài AI';
  }
  if (typeof config.customClass === 'string') {
    const classes = config.customClass.trim().split(/\s+/).filter(Boolean);
    if (classes.length) launch.classList.add(...classes);
  }
  launch.setAttribute('aria-haspopup', 'dialog');
  launch.setAttribute('aria-expanded', 'false');
  launch.hidden = Boolean(grant);
  function showLaunch() {
    launch.hidden = false;
    if (customLaunch && !launch.parentNode && host.parentNode === slot) slot.insertBefore(launch, host);
  }
  if (!grant) showLaunch();
  const form = select<HTMLFormElement>('form');
  const submit = select<HTMLButtonElement>('.submit');
  const close = select<HTMLButtonElement>('.close');
  const translate = select<HTMLButtonElement>('.translate');
  const previewLanguage = select<HTMLElement>('.preview-language');
  const accept = select<HTMLButtonElement>('.accept');
  const status = select<HTMLParagraphElement>('.status');
  const activity = select<HTMLElement>('.activity');
  const visual = select<HTMLElement>('.writing-visual');
  const elapsed = select<HTMLElement>('.writing-elapsed');
  const preview = select<HTMLElement>('.preview');
  const modelLabel = select<HTMLElement>('.model-label');
  const intro = select<HTMLElement>('.form-intro small');
  const ownKeyOption = select<HTMLLabelElement>('.own-key-option');
  const ownKeyToggle = select<HTMLInputElement>('.own-key-toggle');
  let websiteKeyMode = keyMode;
  let personalModel = personalCredentials?.model ?? '';
  let personalAvailable = Boolean(personalCredentials);
  let catalogReady = !modelsEndpoint;
  let serviceAvailable = true;
  let explicitChoice = Boolean(grant);
  let model = select<HTMLInputElement | HTMLSelectElement>('[name="model"]');
  if (modelsEndpoint || (keyMode !== 'own' && config.models)) {
    const options = document.createElement('select');
    options.name = 'model';
    options.required = true;
    options.disabled = Boolean(modelsEndpoint);
    if (!modelsEndpoint) {
      for (const item of config.models ?? []) options.add(new Option(item.label, item.value));
      options.disabled = !options.length;
    }
    model.replaceWith(options);
    model = options;
  }
  model.value = personalCredentials?.model ?? config.defaults?.model ?? model.value;
  modelLabel.hidden = Boolean(modelsEndpoint) || keyMode === 'own';
  if (keyMode === 'own') intro.textContent = 'Mô tả nội dung cần triển khai.';
  if (personalCredentials && model instanceof HTMLInputElement) model.readOnly = true;
  const tone = select<HTMLSelectElement>('[name="tone"]');
  const style = select<HTMLSelectElement>('[name="style"]');
  const useResearch = select<HTMLInputElement>('[name="use_research"]');
  const languageNames = new Intl.DisplayNames(['vi'], { type: 'language' });
  const languageLabel = (locale: string) => `${languageNames.of(locale) ?? locale} (${locale})`;
  if (languages) {
    select<HTMLElement>('.language-field').hidden = false;
    select('.source-language-name').textContent = languageNames.of(sourceLocale) ?? sourceLocale;
    select('.language-code').textContent = sourceLocale;
    if (languages.targets.length) {
      select('.language-field').classList.add('has-targets');
      select<HTMLElement>('.language-targets').hidden = false;
      for (const locale of languages.targets) {
        const item = document.createElement('span');
        item.className = 'target-language';
        const name = document.createElement('span');
        name.textContent = languageNames.of(locale) ?? locale;
        const code = document.createElement('small');
        code.className = 'language-code';
        code.textContent = locale;
        item.append(name, code);
        select('.target-languages').append(item);
      }
    }
  }
  tone.value = toneOptions.includes(config.defaults?.tone ?? '') ? config.defaults!.tone! : 'Thân thiện';
  style.value = styleOptions.includes(config.defaults?.style ?? '') ? config.defaults!.style! : 'Hướng dẫn';
  select<HTMLInputElement>('[name="length"]').value = String(config.defaults?.length ?? 800);
  select<HTMLTextAreaElement>('[name="instructions"]').value = config.defaults?.instructions ?? '';
  useResearch.checked = config.defaults?.use_research ?? true;
  const searchable = Array.from(form.querySelectorAll('select'), searchableSelect);

  let pending: { body: string; id: string; jobId?: string; readToken?: string } | undefined;
  let controller: AbortController | undefined;
  let catalogRequest: AbortController | undefined;
  type Draft = { article: Article; job: Preview; keyword: string; locale: string };
  const drafts = new Map<string, Draft>();
  let previewLocale = sourceLocale;
  let originalRequest: Record<string, unknown> | undefined;
  let translationRequested = false;
  let translating = false;
  let applying = false;
  let writingTimer: number | undefined;
  let proofRequired = false;

  function setStatus(message = '', error = false) {
    if (status.textContent !== message) status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('error', error);
    activity.hidden = !message && !controller;
  }

  function updateSubmit() {
    searchable.forEach(control => control.sync());
    const busy = Boolean(controller || translating || applying);
    submit.disabled = Boolean(busy || catalogRequest || !catalogReady ||
      (keyMode === 'own' ? !personalAvailable : model instanceof HTMLSelectElement && model.disabled));
    close.disabled = busy;
    accept.disabled = busy || !drafts.has(sourceLocale) || Boolean(translationRequested && languages?.targets.some(locale => !drafts.has(locale)));
    translate.disabled = busy;
    translate.hidden = !languages?.targets.length || !drafts.has(sourceLocale) || languages.targets.every(locale => drafts.has(locale));
    for (const tab of previewLanguage.querySelectorAll<HTMLButtonElement>('[role="tab"]')) tab.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
  }

  function updateKeyChoice() {
    keyMode = websiteKeyMode === 'own' || ownKeyToggle.checked ? 'own' : 'service';
    ownKeyOption.hidden = !catalogReady || websiteKeyMode === 'own' || !personalAvailable;
    modelLabel.hidden = !catalogReady || keyMode === 'own';
    intro.textContent = keyMode === 'own' ? 'Mô tả nội dung cần triển khai.' : 'Chọn model và mô tả nội dung cần triển khai.';
    // Keep the allocated model selection intact when switching to a private key.
    model.required = keyMode !== 'own';
    if (model instanceof HTMLSelectElement) model.disabled = !catalogReady || keyMode === 'own' || !serviceAvailable;
    updateSubmit();
  }
  ownKeyToggle.onchange = () => {
    setStatus(keyMode !== 'own' && ownKeyToggle.checked ? '' : !serviceAvailable ? 'Website chưa có model được cấp.' : '', !serviceAvailable && !ownKeyToggle.checked);
    updateKeyChoice();
  };

  function clearWritingTimer() {
    window.clearInterval(writingTimer);
    writingTimer = undefined;
  }

  function setWriting(active: boolean, keyword = '', locale = sourceLocale) {
    clearWritingTimer();
    const isTranslation = Boolean(languages && locale !== sourceLocale);
    dialog.classList.toggle('is-writing', active);
    dialog.classList.toggle('is-translating', active && isTranslation);
    form.hidden = active || !preview.hidden;
    updateSubmit();
    if (active) {
      visual.dataset.stage = isTranslation ? 'translation' : 'waiting';
      select('.writing-title').textContent = isTranslation ? 'Đang dịch bài viết sang các ngôn ngữ khác' : 'Đang tạo bài viết của bạn';
      select('.writing-keyword').textContent = isTranslation ? drafts.get(sourceLocale)?.article.Title ?? keyword : keyword;
      const language = select<HTMLElement>('.writing-language');
      language.hidden = !isTranslation;
      language.textContent = isTranslation
        ? `${languages!.targets.indexOf(locale) + 1}/${languages!.targets.length} · ${languageLabel(sourceLocale)} → ${languageLabel(locale)}` : '';
      select('.writing-track').setAttribute('aria-label', isTranslation ? `Đang dịch sang ${languageLabel(locale)}` : 'Đang xử lý bài viết');
      activity.setAttribute('aria-label', isTranslation ? 'Tiến trình dịch bài' : 'Tiến trình viết bài');
      const startedAt = Date.now();
      const updateElapsed = () => {
        const seconds = Math.floor((Date.now() - startedAt) / 1000);
        elapsed.textContent = `Đã chờ ${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
      };
      updateElapsed();
      writingTimer = window.setInterval(updateElapsed, 1000);
      activity.hidden = false;
      activity.focus({ preventScroll: true });
      dialog.scrollTop = 0;
    } else {
      delete visual.dataset.stage;
      activity.hidden = status.hidden;
      if (status.classList.contains('error')) activity.focus();
    }
  }

  async function refreshModels(url: URL, menu: HTMLSelectElement) {
    const selected = menu.value || config.defaults?.model;
    const loading = new AbortController();
    catalogRequest = loading;
    catalogReady = false;
    ownKeyToggle.checked = false;
    ownKeyOption.hidden = true;
    menu.replaceChildren(new Option('Đang tải danh sách model…', ''));
    menu.disabled = true;
    modelLabel.hidden = true;
    setStatus();
    updateSubmit();
    try {
      if (grant && Date.now() >= grant.expiresAt) throw new Error(expiredGrantMessage);
      const response = await requestJson(url, loading.signal, undefined, grant?.headers);
      proofRequired = response?.proof_required === true;
      if (!Array.isArray(response?.data)) throw new Error('invalid_models');
      if ((grant || response.key_mode !== undefined) && response.key_mode !== 'own' && response.key_mode !== 'service') {
        throw new Error('invalid_key_mode');
      }
      loading.signal.throwIfAborted();
      // CRM metadata overrides the optional legacy embed hint on every open.
      websiteKeyMode = response.key_mode ?? configuredKeyMode(config) ?? 'service';
      personalModel = personalCredentials?.model ?? (typeof response.own_model === 'string' ? response.own_model.trim() :
        typeof response.model === 'string' ? response.model.trim() : '');
      personalAvailable = grant ? Boolean(personalCredentials) : Boolean(personalCredentials) ||
        (response.has_own_credentials === true || websiteKeyMode === 'own' && response.own_key_configured !== false) && Boolean(personalModel);
      explicitChoice = Boolean(grant) || websiteKeyMode === 'service' && personalAvailable;
      if (websiteKeyMode === 'own') {
        catalogReady = true;
        showLaunch();
        serviceAvailable = false;
        menu.replaceChildren(new Option(personalModel, personalModel));
        updateKeyChoice();
        if (!personalAvailable) setStatus('Website dùng key riêng. Quản trị viên cần cấu hình Base URL, API key và model ở backend Laravel.', true);
        return;
      }
      const options = response.data.map((row: { model?: unknown; display_name?: unknown; provider_display_name?: unknown } | null) => {
        if (typeof row?.model !== 'string' || !row.model.trim() ||
            typeof row.display_name !== 'string' || !row.display_name.trim()) throw new Error('invalid_model');
        const label = typeof row.provider_display_name === 'string' && row.provider_display_name.trim()
          ? `${row.display_name} · ${row.provider_display_name}` : row.display_name;
        return new Option(label, row.model);
      });
      loading.signal.throwIfAborted();
      catalogReady = true;
      showLaunch();
      menu.replaceChildren(...options);
      serviceAvailable = options.length > 0;
      if (options.length) {
        if (selected && options.some((option: HTMLOptionElement) => option.value === selected)) menu.value = selected;
        menu.disabled = false;
      } else {
        menu.add(new Option('Website chưa có model được cấp.', ''));
        setStatus('Website chưa có model được cấp.', true);
      }
      updateKeyChoice();
    } catch (error) {
      if (!loading.signal.aborted) {
        catalogReady = false;
        personalAvailable = false;
        ownKeyOption.hidden = true;
        modelLabel.hidden = keyMode === 'own';
        menu.disabled = true;
        menu.replaceChildren(new Option('Tải model thất bại. Đóng rồi mở lại để thử.', ''));
        setStatus(error instanceof Error && error.message === expiredGrantMessage
          ? expiredGrantMessage : 'Không tải được cấu hình website. Đóng rồi mở lại để thử.', true);
      }
    } finally {
      if (catalogRequest === loading) {
        catalogRequest = undefined;
        updateSubmit();
      }
    }
  }

  function showSeoReport(job: Preview) {
    const section = select<HTMLElement>('.seo-review');
    const report = job.seo_report;
    section.hidden = !report;
    if (!report) return;
    select('.seo-overview').textContent = `${report.score}/100 · ${report.warnings.length ? `${report.warnings.length} cần xem lại` : 'Đạt'}`;
    select('.seo-summary').textContent = `${report.score}/100 điểm tiêu chí nội bộ · ${report.passed}/${report.applicable} tiêu chí đạt · ${report.warnings.length} tiêu chí cần xem lại.`;
    select('.seo-repair').textContent = job.seo_repair_status === 'applied'
      ? 'Đã áp dụng chỉnh sửa SEO. Báo cáo được kiểm tra từ bản cuối trong CRM.'
      : job.seo_repair_status === 'kept_draft'
        ? 'CRM giữ lại bản nháp vì lượt chỉnh sửa SEO chưa hoàn tất hoặc chưa cải thiện đủ các tiêu chí. Xem các gợi ý dưới đây.'
        : job.seo_repair_status === 'skipped'
          ? 'CRM đã lưu bài. Các tiêu chí còn thiếu cần được biên tập viên xem lại.'
          : 'Đây là kết quả kiểm tra của bài viết được lưu trong CRM.';
    const excluded = report.findings.filter(finding => !finding.applicable && !finding.advisory).length;
    const advisory = report.findings.filter(finding => finding.advisory).length;
    select('.seo-details-label').textContent = `${report.findings.length} tiêu chí SEO (${report.applicable} áp dụng, ${excluded} chưa áp dụng${advisory ? `, ${advisory} tham khảo` : ''})`;
    const findings = select('.seo-findings');
    findings.replaceChildren();
    for (const finding of report.findings) {
      const row = document.createElement('li');
      const state = finding.advisory ? 'Tham khảo' : !finding.applicable ? 'Chưa áp dụng' : finding.passed ? 'Đạt' : 'Cần xem lại';
      row.dataset.state = !finding.applicable ? 'excluded' : finding.passed ? 'passed' : 'warning';
      const label = document.createElement('strong');
      label.textContent = `${finding.label}: ${state}`;
      row.append(label);
      if ((!finding.passed || finding.advisory) && finding.message) {
        const message = document.createElement('p');
        message.textContent = finding.message;
        row.append(message);
      }
      findings.append(row);
    }
  }

  function showArticle(draft: Draft, focusResult = true) {
    const { article, job, keyword, locale } = draft;
    if (focusResult) {
      for (const detail of root.querySelectorAll<HTMLDetailsElement>('.preview-insights details')) detail.open = false;
    }
    previewLocale = locale;
    previewLanguage.replaceChildren(...[...drafts.values()].map(item => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'preview-language-tab';
      tab.id = `ai-preview-tab-${item.locale}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', 'ai-preview-content');
      tab.setAttribute('aria-selected', String(item.locale === locale));
      tab.tabIndex = item.locale === locale ? 0 : -1;
      const name = document.createElement('span');
      name.className = 'preview-language-name';
      name.textContent = languageNames.of(item.locale) ?? item.locale;
      tab.append(name);
      if (item.locale === sourceLocale) {
        const badge = document.createElement('span');
        badge.className = 'preview-original';
        badge.textContent = 'Bản gốc';
        tab.append(badge);
      }
      tab.onclick = () => { if (!tab.disabled) showArticle(item, false); };
      return tab;
    }));
    select('.preview-content').setAttribute('aria-labelledby', `ai-preview-tab-${locale}`);
    select<HTMLElement>('.preview-versions').hidden = drafts.size < 2 && !translationRequested;
    const summary = select<HTMLElement>('.translation-summary');
    summary.hidden = !translationRequested;
    summary.textContent = `Đã dịch ${Math.max(0, drafts.size - 1)}/${languages?.targets.length ?? 0}`;
    summary.dataset.complete = String(drafts.size - 1 === languages?.targets.length);
    select('.preview-apply-hint').textContent = summary.dataset.complete === 'true'
      ? 'Áp dụng để điền tất cả phiên bản vào form.' : 'Hoàn tất các bản dịch trước khi áp dụng.';
    select('.title').textContent = article.Title;
    const metadata = select('.metadata');
    metadata.replaceChildren();
    for (const [label, value] of [
      ['Tiêu đề SEO', article.SeoTitle], ['Slug', article.Slug], ['Mô tả', article.Desc], ['Mô tả SEO', article.Description],
      ['Từ khóa chính', keyword], ['Từ khóa liên quan', article.Keywords.join(', ')],
    ]) {
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      metadata.append(term, detail);
    }
    select('.body').innerHTML = articlePreviewHtml(article.Content);
    for (const section of [select<HTMLElement>('.body'), select<HTMLElement>('.title')]) {
      section.lang = locale;
      section.dir = /^(ar|fa|he|ur|ps|sd|ug|yi)(-|$)/i.test(locale) ? 'rtl' : 'ltr';
    }
    showSeoReport(job);
    form.hidden = true;
    preview.hidden = false;
    updateSubmit();
    if (focusResult) accept.focus();
    else previewLanguage.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }
  previewLanguage.onkeydown = event => {
    const tabs = [...previewLanguage.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const current = tabs.findIndex(tab => tab === root.activeElement);
    if (current < 0 || tabs[current].disabled) return;
    const index = event.key === 'ArrowRight' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (index < 0) return;
    event.preventDefault();
    tabs[index].click();
  };

  async function run(body: string) {
    if (controller) return false;
    const task = pending?.body === body ? pending : { body, id: crypto.randomUUID() };
    const input = JSON.parse(body);
    const locale = input.locale ?? sourceLocale;
    const isTranslation = Boolean(languages && locale !== sourceLocale);
    const targetLanguage = languageNames.of(locale) ?? locale;
    pending = task;
    const running = new AbortController();
    controller = running;
    preview.hidden = true;
    setStatus(isTranslation ? `Đang gửi yêu cầu dịch sang ${targetLanguage}…` : 'Đang gửi yêu cầu viết bài…');
    setWriting(true, input.keyword, locale);
    try {
      if (!task.jobId && grant && Date.now() >= grant.expiresAt) throw new Error(expiredGrantMessage);
      let createHeaders: Record<string, string> | undefined = grant?.headers;
      if (!task.jobId && grant && proofRequired) {
        if (!authorizeUrl) throw new Error('Website cần cập nhật tích hợp để cấp chữ ký cho từng yêu cầu viết.');
        const authorization = await requestJson(authorizeUrl, running.signal, { body: JSON.stringify({ body: task.body, id: task.id }), id: task.id });
        if (typeof authorization?.proof !== 'string' || !authorization.proof) throw new Error('Website chưa cấp chữ ký hợp lệ cho yêu cầu viết.');
        createHeaders = { ...grant.headers, 'X-Site-Proof': authorization.proof };
      }
      let job = task.jobId
        ? await request(jobUrl(endpoint, task.jobId), running.signal, undefined, task.readToken ? { 'X-Widget-Read-Token': task.readToken } : undefined)
        : await request(endpoint, running.signal, task, createHeaders);
      if (!task.jobId) {
        if (grant && (typeof job.read_token !== 'string' || !job.read_token)) throw new Error('CRM chưa trả mã đọc kết quả bài viết.');
        task.jobId = job.job_id;
        task.readToken = grant ? job.read_token : undefined;
      }
      const readHeaders = task.readToken ? { 'X-Widget-Read-Token': task.readToken } : undefined;
      while (['scheduled', 'queued', 'writing', 'retrying'].includes(job.status)) {
        const stage = isTranslation ? 'translation' : job.status === 'writing' && isWritingStage(job.writing_stage) ? job.writing_stage : 'waiting';
        if (visual.dataset.stage !== stage) visual.dataset.stage = stage;
        setStatus(isTranslation
          ? job.status === 'writing' ? `Đang dịch bài viết sang ${targetLanguage}…`
            : job.status === 'retrying' ? `CRM đang thử dịch lại sang ${targetLanguage}…`
              : job.status === 'scheduled' ? `Bản dịch ${targetLanguage} đã được lên lịch. Đang chờ CRM xử lý…`
                : `Bản dịch ${targetLanguage} đang chờ xử lý…`
          : job.status === 'writing' ? `${writingStageLabel(job.writing_stage, 'CRM đang xử lý bài viết')}…`
          : job.status === 'retrying' ? 'CRM đang thử xử lý lại bài viết…'
            : job.status === 'scheduled' ? 'Bài viết đã được lên lịch. Đang chờ CRM xử lý…'
              : 'Yêu cầu đang chờ xử lý…');
        await new Promise<void>(resolve => window.setTimeout(resolve, 1_500));
        running.signal.throwIfAborted();
        job = await request(jobUrl(endpoint, task.jobId), running.signal, undefined, readHeaders);
      }
      if (job.status !== 'ready') {
        pending = undefined;
        throw new Error(job.error_message || (isTranslation ? 'Yêu cầu dịch bài đã dừng.' : 'Yêu cầu viết bài đã dừng.'));
      }
      running.signal.throwIfAborted();
      const article = grant
        ? await requestJson(jobUrl(endpoint, task.jobId, true), running.signal, undefined, readHeaders)
        : job.result;
      running.signal.throwIfAborted();
      const parsed = articleFrom(article);
      const keyword = typeof job.keyword === 'string' && job.keyword.trim() ? job.keyword : input.keyword;
      const draft: Draft = { article: parsed, job, locale,
        keyword: isTranslation ? articleFocusKeyword(parsed, keyword) : keyword };
      drafts.set(locale, draft);
      showArticle(draft);
      pending = undefined;
      setStatus();
      return true;
    } catch (error) {
      const original = drafts.get(sourceLocale);
      if (original) showArticle(original);
      if (!running.signal.aborted) setStatus(error instanceof Error ? error.message : isTranslation ? 'Gửi yêu cầu dịch thất bại.' : 'Gửi yêu cầu thất bại.', true);
      return false;
    } finally {
      if (controller === running) {
        controller = undefined;
        setWriting(false);
        if (!translating && drafts.has(sourceLocale) && status.hidden) accept.focus();
      }
    }
  }

  async function translateDrafts() {
    const original = drafts.get(sourceLocale);
    if (!languages?.targets.length || !original || !originalRequest || translating || controller) return;
    translationRequested = true;
    translating = true;
    translate.textContent = 'Đang dịch…';
    updateSubmit();
    try {
      const { Title, SeoTitle, Content, Desc, Description, Keywords } = original.article;
      for (const locale of languages.targets) {
        if (drafts.has(locale)) continue;
        const body = JSON.stringify({ ...originalRequest, locale, use_research: false,
          translation_source: { Title, SeoTitle, Content, Desc, Description, Keywords },
          translation_of_job_id: original.job.job_id,
        });
        if (new TextEncoder().encode(body).length > WIDGET_REQUEST_BODY_LIMIT) throw new Error('Nội dung yêu cầu vượt giới hạn chuyển ngữ.');
        if (!await run(body)) break;
      }
    } catch (error) {
      showArticle(original);
      setStatus(error instanceof Error ? error.message : 'Không thể tạo bản dịch.', true);
    } finally {
      translating = false;
      translate.textContent = 'Thử lại bản dịch';
      updateSubmit();
      if (!accept.disabled) accept.focus();
    }
  }
  translate.onclick = () => { void translateDrafts(); };

  function resetSession() {
    pending = undefined;
    drafts.clear();
    previewLocale = sourceLocale;
    originalRequest = undefined;
    translationRequested = false;
    articleRef = languages ? `draft:${crypto.randomUUID()}` : undefined;
    preview.hidden = true;
    form.hidden = false;
    form.reset();
    model.value = personalCredentials?.model ?? config.defaults?.model ?? (model instanceof HTMLSelectElement ? model.options[0]?.value ?? '' : '');
    tone.value = toneOptions.includes(config.defaults?.tone ?? '') ? config.defaults!.tone! : 'Thân thiện';
    style.value = styleOptions.includes(config.defaults?.style ?? '') ? config.defaults!.style! : 'Hướng dẫn';
    select<HTMLInputElement>('[name="length"]').value = String(config.defaults?.length ?? 800);
    select<HTMLTextAreaElement>('[name="instructions"]').value = config.defaults?.instructions ?? '';
    useResearch.checked = config.defaults?.use_research ?? true;
    translate.textContent = 'Dịch sang các ngôn ngữ khác';
    setStatus();
    updateKeyChoice();
  }

  launch.onclick = () => {
    if (dialog.open) return;
    dialog.showModal();
    launch.setAttribute('aria-expanded', 'true');
    if (modelsEndpoint && model instanceof HTMLSelectElement && !pending?.jobId && !drafts.size) void refreshModels(modelsEndpoint, model);
    else updateSubmit();
    if (pending?.jobId) {
      if (translationRequested) void translateDrafts();
      else void run(pending.body);
    } else if (drafts.size) showArticle(drafts.get(previewLocale) ?? drafts.get(sourceLocale)!);
  };
  close.onclick = () => { if (!controller && !translating && !applying) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (controller || translating || applying) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    launch.setAttribute('aria-expanded', 'false');
    controller?.abort();
    catalogRequest?.abort();
    catalogRequest = undefined;
    controller = undefined;
    clearWritingTimer();
    delete visual.dataset.stage;
    dialog.classList.remove('is-writing', 'is-translating');
    if (drafts.size && !translationRequested) {
      drafts.clear();
      originalRequest = undefined;
      pending = undefined;
      articleRef = languages ? `draft:${crypto.randomUUID()}` : undefined;
    }
    updateSubmit();
    form.hidden = drafts.size > 0;
    preview.hidden = drafts.size === 0;
    setStatus();
  });
  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled || drafts.size) return;
    const data = new FormData(form);
    const body = Object.fromEntries([...data].map(([name, value]) => [name, String(value).trim()]));
    const requestBody: Record<string, string | number> = {
      ...body,
      ...(keyMode === 'own' && personalCredentials ? personalCredentials : {}),
      ...(explicitChoice ? { key_mode: keyMode ?? 'service' } : {}),
      model: keyMode === 'own' ? personalModel : body.model,
      length: Number(body.length),
    };
    if (body.instructions.length > 4000) {
      setStatus('Hướng dẫn thêm không được vượt quá 4.000 ký tự.', true);
      return;
    }
    if (!requestBody.instructions) delete requestBody.instructions;
    if (Object.entries(requestBody).some(([name, value]) => name !== 'length' && !value)) {
      setStatus('Hãy nhập đủ thông tin bài viết.', true);
      return;
    }
    if (keyMode !== 'own' || !personalCredentials) {
      delete requestBody.provider;
      delete requestBody.base_url;
      delete requestBody.api_key;
      delete requestBody.apiKey;
      delete requestBody.keyAI;
    }
    try {
      originalRequest = { ...requestBody,
        ...(articleRef ? { article_ref: articleRef } : {}),
        ...(languages ? { languages, locale: sourceLocale } : {}),
        use_research: useResearch.checked,
      };
      const body = JSON.stringify(originalRequest);
      if (new TextEncoder().encode(body).length > WIDGET_REQUEST_BODY_LIMIT) throw new Error('Nội dung yêu cầu vượt giới hạn chuyển ngữ.');
      void run(body);
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Không đọc được bản gốc.', true); }
  };
  accept.onclick = async () => {
    if (accept.disabled || !drafts.has(sourceLocale)) return;
    applying = true;
    accept.disabled = true;
    updateSubmit();
    try {
      const completed = [...drafts.values()];
      const hostForm = find(config.form);
      const occupied = completed.filter(draft => Object.values(fieldsFor(draft.locale).fields).some(target => {
        if (!target) return false;
        const element = find(typeof target === 'string' ? target : target.selector, hostForm);
        return Boolean(typeof target === 'object' && target.getValue ? target.getValue(element).trim()
          : element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value.trim() : element.textContent?.trim());
      }));
      if (languages && occupied.length && !window.confirm(`Các trường ${occupied.map(draft => draft.locale).join(', ')} đã có nội dung. Thay bằng kết quả AI?`)) return;
      const apply = completed.flatMap(draft => prepareWrites(fieldsFor(draft.locale), draft.article, draft.keyword));
      for (const write of apply) await write();
      const original = drafts.get(sourceLocale)!;
      articleForm.dispatchEvent(new CustomEvent('crm-ai:article-group', { bubbles: true, detail: {
        article_ref: articleRef ?? null, article_group_id: original.job.article_group_id ?? null,
        source_job_id: original.job.job_id,
      } }));
      resetSession();
      dialog.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Không thể điền bài vào form.', true);
    } finally {
      applying = false;
      accept.disabled = false;
      updateSubmit();
    }
  };
  if (grant && modelsEndpoint && model instanceof HTMLSelectElement) void refreshModels(modelsEndpoint, model);
  return { destroy() { controller?.abort(); catalogRequest?.abort(); clearWritingTimer(); searchable.forEach(control => control.destroy()); launch.remove(); host.remove(); } };
}

declare global {
  interface Window { AIWriter: { mount: typeof mount } }
}
window.AIWriter = { mount };
