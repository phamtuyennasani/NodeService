import DOMPurify from 'dompurify';
import styles from './styles.css';

const fields = ['Title', 'Content', 'Slug', 'Desc', 'Desction', 'Từ khóa'] as const;
type Field = typeof fields[number];
type Article = Record<Exclude<Field, 'Từ khóa'>, string> & { 'Từ khóa': string[] };
type Target = string | { selector: string; setValue?: (element: Element, value: string) => void | Promise<void> };
interface Config {
  mount: string;
  form: string;
  endpoint: string;
  modelsEndpoint?: string;
  fields: Partial<Record<Field, Target>>;
  models?: { value: string; label: string }[];
  defaults?: { model?: string; tone?: string; style?: string; length?: number };
}

interface Preview {
  job_id: string;
  status: string;
  result?: unknown;
  error_message?: string;
}

function find(selector: string, root: ParentNode = document): Element {
  const matches = root.querySelectorAll(selector);
  if (matches.length !== 1) throw new Error(`Selector ${selector} cần khớp đúng một phần tử.`);
  return matches[0];
}

function articleFrom(value: unknown): Article {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== 'object') {
    throw new Error('Phản hồi phải chứa một bài viết.');
  }
  const record = value[0] as Record<string, unknown>;
  for (const field of fields) {
    const entry = record[field];
    const valid = field === 'Từ khóa'
      ? Array.isArray(entry) && entry.length > 0 && entry.every(item => typeof item === 'string' && item.trim())
      : typeof entry === 'string' && entry.trim();
    if (!valid) throw new Error(`Kết quả thiếu trường ${field}.`);
  }
  const article = record as Article;
  const content = DOMPurify.sanitize(article.Content, {
    ALLOWED_TAGS: ['p', 'br', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'table', 'thead', 'tbody', 'tr', 'td', 'th'],
    ALLOWED_ATTR: ['href', 'title'],
  });
  if (!content.trim()) throw new Error('Kết quả thiếu nội dung bài viết.');
  return { ...article, Content: content };
}

function prepareWrites(config: Config, article: Article) {
  const form = find(config.form);
  const seen = new Set<Element>();
  return fields.flatMap(field => {
    const target = config.fields[field];
    if (!target) return [];
    const element = find(typeof target === 'string' ? target : target.selector, form);
    if (seen.has(element)) throw new Error(`Đích của trường ${field} bị trùng.`);
    seen.add(element);
    const value = field === 'Từ khóa' ? article[field].join(', ') : article[field];
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

function mount(config: Config) {
  const slot = find(config.mount);
  const endpoint = sameOriginEndpoint(config.endpoint);
  const modelsEndpoint = config.modelsEndpoint ? sameOriginEndpoint(config.modelsEndpoint) : undefined;
  if (!fields.some(field => config.fields[field])) throw new Error('Cần cấu hình ít nhất một trường để điền.');
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
          <label class="field">Giọng văn<input name="tone" maxlength="240" placeholder="Thân thiện" required></label>
          <label class="field">Phong cách viết<input name="style" maxlength="500" placeholder="Hướng dẫn" required></label>
        </div>
        <label class="field length-field">Độ dài <span>(số từ)</span><input name="length" type="number" min="1" max="25000" step="1" required></label>
        <div class="form-actions"><small>Nội dung sẽ được xem trước trước khi điền vào form.</small><button type="submit" class="primary submit"><span>Viết ngay</span><span class="button-arrow" aria-hidden="true">→</span></button></div>
      </form>
      <p class="status" role="status" aria-live="polite" hidden></p>
      <section class="preview" aria-label="Xem trước bài viết" hidden>
        <h3 class="title"></h3>
        <dl class="metadata"></dl>
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
  if (modelsEndpoint || config.models) {
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
  model.value = config.defaults?.model ?? model.value;
  select<HTMLInputElement>('[name="tone"]').value = config.defaults?.tone ?? 'Thân thiện';
  select<HTMLInputElement>('[name="style"]').value = config.defaults?.style ?? 'Hướng dẫn';
  select<HTMLInputElement>('[name="length"]').value = String(config.defaults?.length ?? 800);

  let pending: { body: string; id: string; jobId?: string } | undefined;
  let controller: AbortController | undefined;
  let catalogRequest: AbortController | undefined;
  let result: Article | undefined;
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
      const options = response.data.map((row: { model?: unknown; display_name?: unknown } | null) => {
        if (typeof row?.model !== 'string' || !row.model.trim() ||
            typeof row.display_name !== 'string' || !row.display_name.trim()) throw new Error('invalid_model');
        return new Option(row.display_name, row.model);
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

  function showArticle(article: Article) {
    result = article;
    select('.title').textContent = article.Title;
    const metadata = select('.metadata');
    metadata.replaceChildren();
    for (const [label, value] of [
      ['Slug', article.Slug], ['Mô tả', article.Desc], ['Mô tả SEO', article.Desction],
      ['Từ khóa', article['Từ khóa'].join(', ')],
    ]) {
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      metadata.append(term, detail);
    }
    select('.body').innerHTML = article.Content;
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
      showArticle(articleFrom(job.result));
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
    form.hidden = false;
    preview.hidden = true;
    setStatus();
  });
  form.onsubmit = event => {
    event.preventDefault();
    if (submit.disabled) return;
    const data = new FormData(form);
    const body = Object.fromEntries([...data].map(([name, value]) => [name, String(value).trim()]));
    if (Object.values(body).some(value => !value)) {
      setStatus('Hãy nhập đủ thông tin bài viết.', true);
      return;
    }
    void run(JSON.stringify({ ...body, length: Number(body.length) }));
  };
  accept.onclick = async () => {
    if (!result || applying) return;
    applying = true;
    accept.disabled = true;
    try {
      const apply = prepareWrites(config, result);
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
