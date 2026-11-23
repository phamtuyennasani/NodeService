import createDOMPurify from 'dompurify';
import { sanitizeArticleStyle } from '../src/article-styles';
import type { SeoReport } from '../src/worker/seo';
import styles from './styles.css';

const articlePurifier = createDOMPurify(window);
articlePurifier.addHook('uponSanitizeAttribute', (_node, attribute) => {
  if (attribute.attrName !== 'style') return;
  attribute.attrValue = sanitizeArticleStyle(attribute.attrValue);
  attribute.keepAttr = Boolean(attribute.attrValue);
});

const fields = ['Title', 'Content', 'Slug', 'Desc', 'Description', 'Keywords'] as const;
const toneOptions = ['Thân thiện', 'Chuyên nghiệp', 'Tư vấn', 'Thuyết phục', 'Trang trọng', 'Hài hước'];
const styleOptions = ['Hướng dẫn', 'SEO', 'Chuyên gia', 'Kể chuyện', 'Danh sách', 'Tin tức'];
type Field = typeof fields[number];
type LegacyField = 'Desction' | 'Từ khóa';
const legacyFields: Partial<Record<Field, LegacyField>> = { Description: 'Desction', Keywords: 'Từ khóa' };
type Article = Record<Exclude<Field, 'Keywords'>, string> & { Keywords: string[] };
type Target = string | { selector: string; setValue?: (element: Element, value: string) => void | Promise<void> };
type KeyMode = 'own' | 'service';
interface Config {
  mount: string;
  form: string;
  endpoint: string;
  modelsEndpoint?: string;
  keyMode?: KeyMode;
  key_mode?: KeyMode;
  authMode?: KeyMode;
  provider?: string;
  api_key?: string;
  apiKey?: string;
  model?: string;
  fields: Partial<Record<Field | LegacyField | 'FocusKeyword', Target>>;
  models?: { value: string; label: string }[];
  defaults?: { model?: string; tone?: string; style?: string; length?: number; use_research?: boolean; instructions?: string };
}

interface Preview {
  job_id: string;
  status: string;
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

function articleFrom(value: unknown): Article {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error('Phản hồi phải chứa một bài viết.');
  }
  const source = value[0] as Record<string, unknown>;
  const record: Record<string, unknown> = {};
  for (const field of fields) {
    const entry = readField(source, field);
    const valid = field === 'Keywords'
      ? Array.isArray(entry) && entry.length > 0 && entry.every(item => typeof item === 'string' && item.trim())
      : typeof entry === 'string' && entry.trim();
    if (!valid) throw new Error(`Kết quả thiếu trường ${field}.`);
    record[field] = entry;
  }
  const article = record as Article;
  const content = articlePurifier.sanitize(article.Content, {
    ALLOWED_TAGS: ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'a', 'span', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'hr'],
    ALLOWED_ATTR: ['href', 'title', 'style', 'scope', 'colspan', 'rowspan'],
  });
  if (!content.trim()) throw new Error('Kết quả thiếu nội dung bài viết.');
  return { ...article, Content: content };
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

async function requestJson(url: URL, signal: AbortSignal, input?: { body: string; id: string }) {
  const headers = new Headers({ Accept: 'application/json' });
  if (input) {
    const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
    if (!csrf) throw new Error('Trang Laravel cần thẻ meta csrf-token.');
    headers.set('Content-Type', 'application/json');
    headers.set('X-CSRF-TOKEN', csrf);
    headers.set('Idempotency-Key', input.id);
  }
  const response = await fetch(url, {
    method: input ? 'POST' : 'GET', body: input?.body, headers, signal,
    credentials: 'same-origin', mode: 'same-origin', redirect: 'error', cache: 'no-store',
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `Laravel trả lỗi HTTP ${response.status}.`);
  }
  return data;
}

async function request(url: URL, signal: AbortSignal, input?: { body: string; id: string }): Promise<Preview> {
  const data = await requestJson(url, signal, input);
  if (!data || typeof data.status !== 'string' || typeof data.job_id !== 'string') {
    throw new Error('Laravel chưa trả về job_id và trạng thái hợp lệ.');
  }
  return data;
}

function jobUrl(endpoint: URL, id: string) {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${encodeURIComponent(id)}`;
  return url;
}

function sameOriginEndpoint(value: string) {
  const endpoint = new URL(value, location.href);
  if (endpoint.origin !== location.origin || !/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Endpoint cần nằm cùng origin với trang Laravel.');
  }
  return endpoint;
}

function configuredKeyMode(config: Config): KeyMode | undefined {
  return config.keyMode ?? config.key_mode ?? config.authMode ?? (config.api_key || config.apiKey ? 'own' : undefined);
}

function ownCredentials(config: Config) {
  if (configuredKeyMode(config) !== 'own') return undefined;
  const provider = config.provider?.trim();
  const apiKey = (config.api_key ?? config.apiKey)?.trim();
  const model = config.model?.trim();
  if (!provider || !apiKey || !model) {
    throw new Error('Cấu hình key cá nhân cần provider, api_key và model.');
  }
  return { provider, api_key: apiKey, model };
}

function mount(config: Config) {
  const slot = find(config.mount);
  const endpoint = sameOriginEndpoint(config.endpoint);
  const modelsEndpoint = config.modelsEndpoint ? sameOriginEndpoint(config.modelsEndpoint) : undefined;
  const keyMode = configuredKeyMode(config);
  const personalCredentials = ownCredentials(config);
  if (!fields.some(field => readField(config.fields, field))) throw new Error('Cần cấu hình ít nhất một trường để điền.');
  const host = document.createElement('span');
  slot.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const css = document.createElement('style');
  css.textContent = styles;
  root.append(css);
  const ui = document.createElement('template');
  ui.innerHTML = `
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
        <label class="model-label field">Model<input name="model" placeholder="gpt-4.1" maxlength="160" required></label>
        <label class="field">Từ khóa<input name="keyword" maxlength="500" placeholder="Ví dụ: máy lọc nước gia đình" required></label>
        <div class="grid">
          <label class="field">Giọng văn<select name="tone" required>${toneOptions.map(value => `<option value="${value}">${value}</option>`).join('')}</select></label>
          <label class="field">Phong cách viết<select name="style" required>${styleOptions.map(value => `<option value="${value}">${value}</option>`).join('')}</select></label>
        </div>
        <label class="field length-field">Độ dài <span>(600–2500 từ)</span><input name="length" type="number" min="600" max="2500" step="1" required></label>
        <label class="field">Hướng dẫn thêm <span>(không bắt buộc)</span><textarea name="instructions" maxlength="4000" rows="3" placeholder="Yêu cầu bổ sung cho bài viết"></textarea></label>
        <label class="research-option"><input name="use_research" type="checkbox" checked><span>Sử dụng dữ liệu tìm kiếm để hỗ trợ viết bài</span></label>
        <div class="form-actions"><small>Nội dung sẽ được xem trước trước khi điền vào form.</small><button type="submit" class="primary submit"><span>Viết ngay</span><span class="button-arrow" aria-hidden="true">→</span></button></div>
      </form>
      <p class="status" role="status" aria-live="polite" hidden></p>
      <section class="preview" aria-label="Xem trước bài viết" hidden>
        <h3 class="title"></h3>
        <dl class="metadata"></dl>
        <section class="seo-review" aria-label="Kết quả kiểm tra SEO từ CRM" hidden>
          <h4>Kiểm tra SEO từ CRM</h4>
          <p class="seo-summary"></p>
          <p class="seo-repair"></p>
          <p>Điểm là checklist biên tập nội bộ, không bảo đảm thứ hạng tìm kiếm. Người biên tập cần kiểm tra nội dung trước khi xuất bản.</p>
          <details><summary class="seo-details-label"></summary><ul class="seo-findings"></ul></details>
        </section>
        <article class="body"></article>
        <footer><button type="button" class="secondary discard">Đóng</button>
          <button type="button" class="primary accept">Chấp nhận</button></footer>
      </section>
    </dialog>`;
  root.append(ui.content);
  const select = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
  const dialog = select<HTMLDialogElement>('dialog');
  const launch = select<HTMLButtonElement>('.launch');
  const form = select<HTMLFormElement>('form');
  const submit = select<HTMLButtonElement>('.submit');
  const accept = select<HTMLButtonElement>('.accept');
  const status = select<HTMLParagraphElement>('.status');
  const preview = select<HTMLElement>('.preview');
  let model = select<HTMLInputElement | HTMLSelectElement>('[name="model"]');
  if (keyMode !== 'own' && (modelsEndpoint || config.models)) {
    const options = document.createElement('select');
    options.name = 'model';
    options.required = true;
    if (!modelsEndpoint) {
      for (const item of config.models ?? []) options.add(new Option(item.label, item.value));
      options.disabled = !options.length;
    }
    model.replaceWith(options);
    model = options;
  }
  model.value = personalCredentials?.model ?? config.defaults?.model ?? model.value;
  if (personalCredentials) {
    if (model instanceof HTMLInputElement) model.readOnly = true;
    else model.disabled = true;
  }
  const tone = select<HTMLSelectElement>('[name="tone"]');
  const style = select<HTMLSelectElement>('[name="style"]');
  const useResearch = select<HTMLInputElement>('[name="use_research"]');
  tone.value = toneOptions.includes(config.defaults?.tone ?? '') ? config.defaults!.tone! : 'Thân thiện';
  style.value = styleOptions.includes(config.defaults?.style ?? '') ? config.defaults!.style! : 'Hướng dẫn';
  select<HTMLInputElement>('[name="length"]').value = String(config.defaults?.length ?? 800);
  select<HTMLTextAreaElement>('[name="instructions"]').value = config.defaults?.instructions ?? '';
  useResearch.checked = config.defaults?.use_research ?? true;

  let pending: { body: string; id: string; jobId?: string } | undefined;
  let controller: AbortController | undefined;
  let catalogRequest: AbortController | undefined;
  let result: Article | undefined;
  let resultKeyword = '';
  let applying = false;

  function setStatus(message = '', error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.classList.toggle('error', error);
  }

  function updateSubmit() {
    submit.disabled = Boolean(controller || (model instanceof HTMLSelectElement && model.disabled));
  }

  async function refreshModels(url: URL, menu: HTMLSelectElement) {
    const selected = menu.value || config.defaults?.model;
    const loading = new AbortController();
    catalogRequest = loading;
    menu.replaceChildren(new Option('Đang tải danh sách model…', ''));
    menu.disabled = true;
    updateSubmit();
    try {
      const response = await requestJson(url, loading.signal);
      if (!Array.isArray(response?.data)) throw new Error('invalid_models');
      const options = response.data.map((row: { model?: unknown; display_name?: unknown; provider_display_name?: unknown } | null) => {
        if (typeof row?.model !== 'string' || !row.model.trim() ||
            typeof row.display_name !== 'string' || !row.display_name.trim()) throw new Error('invalid_model');
        const label = typeof row.provider_display_name === 'string' && row.provider_display_name.trim()
          ? `${row.display_name} · ${row.provider_display_name}` : row.display_name;
        return new Option(label, row.model);
      });
      loading.signal.throwIfAborted();
      menu.replaceChildren(...options);
      if (options.length) {
        if (selected && options.some((option: HTMLOptionElement) => option.value === selected)) menu.value = selected;
        menu.disabled = false;
      } else {
        menu.add(new Option('Website chưa có model được cấp.', ''));
      }
    } catch {
      if (!loading.signal.aborted) menu.replaceChildren(new Option('Tải model thất bại. Đóng rồi mở lại để thử.', ''));
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
    select('.seo-summary').textContent = `${report.score}/100 điểm tiêu chí nội bộ · ${report.passed}/${report.applicable} tiêu chí đạt · ${report.warnings.length} tiêu chí cần xem lại.`;
    select('.seo-repair').textContent = job.seo_repair_status === 'applied'
      ? 'Đã áp dụng chỉnh sửa SEO. Báo cáo được kiểm tra từ bản cuối trong CRM.'
      : job.seo_repair_status === 'kept_draft'
        ? 'CRM giữ lại bản nháp vì lượt chỉnh sửa SEO chưa hoàn tất hoặc chưa cải thiện đủ các tiêu chí. Xem các gợi ý dưới đây.'
        : job.seo_repair_status === 'skipped'
          ? 'CRM đã lưu bài. Các tiêu chí còn thiếu cần được biên tập viên xem lại.'
          : 'Đây là kết quả kiểm tra của bài viết được lưu trong CRM.';
    select('.seo-details-label').textContent = `Xem ${report.findings.length} tiêu chí SEO`;
    const findings = select('.seo-findings');
    findings.replaceChildren();
    for (const finding of report.findings) {
      const row = document.createElement('li');
      const state = !finding.applicable ? 'Chưa áp dụng' : finding.passed ? 'Đạt' : 'Cần xem lại';
      row.dataset.state = !finding.applicable ? 'excluded' : finding.passed ? 'passed' : 'warning';
      const label = document.createElement('strong');
      label.textContent = `${finding.label}: ${state}`;
      row.append(label);
      if (!finding.passed && finding.message) {
        const message = document.createElement('p');
        message.textContent = finding.message;
        row.append(message);
      }
      findings.append(row);
    }
  }

  function showArticle(article: Article, job: Preview, keyword: string) {
    result = article;
    resultKeyword = typeof job.keyword === 'string' && job.keyword.trim() ? job.keyword : keyword;
    select('.title').textContent = article.Title;
    const metadata = select('.metadata');
    metadata.replaceChildren();
    for (const [label, value] of [
      ['Slug', article.Slug], ['Mô tả', article.Desc], ['Mô tả SEO', article.Description],
      ['Từ khóa chính', resultKeyword], ['Từ khóa liên quan', article.Keywords.join(', ')],
    ]) {
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      metadata.append(term, detail);
    }
    select('.body').innerHTML = article.Content;
    showSeoReport(job);
    form.hidden = true;
    preview.hidden = false;
    accept.focus();
  }

  async function run(body: string) {
    if (controller) return;
    const task = pending?.body === body ? pending : { body, id: crypto.randomUUID() };
    pending = task;
    const running = new AbortController();
    controller = running;
    submit.disabled = true;
    setStatus('Đang gửi yêu cầu viết bài…');
    try {
      let job = task.jobId
        ? await request(jobUrl(endpoint, task.jobId), running.signal)
        : await request(endpoint, running.signal, task);
      task.jobId = job.job_id;
      while (['scheduled', 'queued', 'writing', 'retrying'].includes(job.status)) {
        setStatus(job.status === 'writing' ? 'AI đang viết bài…' : 'Yêu cầu đang chờ xử lý…');
        await new Promise<void>(resolve => window.setTimeout(resolve, 1_500));
        running.signal.throwIfAborted();
        job = await request(jobUrl(endpoint, task.jobId), running.signal);
      }
      if (job.status !== 'ready') {
        pending = undefined;
        throw new Error(job.error_message || 'Yêu cầu viết bài đã dừng.');
      }
      running.signal.throwIfAborted();
      showArticle(articleFrom(job.result), job, JSON.parse(task.body).keyword);
      pending = undefined;
      setStatus();
    } catch (error) {
      if (!running.signal.aborted) setStatus(error instanceof Error ? error.message : 'Gửi yêu cầu thất bại.', true);
    } finally {
      if (controller === running) {
        controller = undefined;
        updateSubmit();
      }
    }
  }

  launch.onclick = () => {
    if (dialog.open) return;
    dialog.showModal();
    if (modelsEndpoint && model instanceof HTMLSelectElement) void refreshModels(modelsEndpoint, model);
    else updateSubmit();
    if (pending?.jobId) void run(pending.body);
  };
  select<HTMLButtonElement>('.close').onclick = () => { if (!applying) dialog.close(); };
  select<HTMLButtonElement>('.discard').onclick = () => { if (!applying) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (applying) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    controller?.abort();
    catalogRequest?.abort();
    catalogRequest = undefined;
    controller = undefined;
    updateSubmit();
    result = undefined;
    resultKeyword = '';
    form.hidden = false;
    preview.hidden = true;
    setStatus();
  });
  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled) return;
    const data = new FormData(form);
    const body = Object.fromEntries([...data].map(([name, value]) => [name, String(value).trim()]));
    const requestBody: Record<string, string | number> = {
      ...body,
      ...(personalCredentials ? personalCredentials : {}),
      model: personalCredentials?.model ?? body.model,
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
    if (!personalCredentials) {
      delete requestBody.provider;
      delete requestBody.api_key;
      delete requestBody.apiKey;
      delete requestBody.keyAI;
    }
    void run(JSON.stringify({ ...requestBody, use_research: useResearch.checked }));
  };
  accept.onclick = async () => {
    if (!result || applying) return;
    applying = true;
    accept.disabled = true;
    try {
      const apply = prepareWrites(config, result, resultKeyword);
      for (const write of apply) await write();
      dialog.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Không thể điền bài vào form.', true);
    } finally {
      applying = false;
      accept.disabled = false;
    }
  };
  return { destroy() { controller?.abort(); catalogRequest?.abort(); host.remove(); } };
}

declare global {
  interface Window { AIWriter: { mount: typeof mount } }
}
window.AIWriter = { mount };
