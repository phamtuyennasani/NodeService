let nextId = 0;

const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLocaleLowerCase('vi').trim();

/** Keep the native select as the form value; expose an editable, keyboard-friendly combobox. */
export function searchableSelect(select: HTMLSelectElement) {
  const label = select.closest<HTMLElement>('.field')!;
  const dialog = select.closest('dialog')!;
  const lifecycle = new AbortController();
  const id = `ai-select-${++nextId}`;
  const caption = document.createElement('label');
  caption.htmlFor = id;
  const captionText = label.firstChild?.textContent?.trim() ?? '';
  caption.textContent = captionText;
  label.firstChild?.replaceWith(caption);

  const control = document.createElement('div');
  control.className = 'search-select';
  control.innerHTML = '<span class="select-search-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 20 20" fill="none"><circle cx="8.5" cy="8.5" r="5.5" stroke="currentColor" stroke-width="1.5"/><path d="m13 13 4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span><span class="select-chevron" aria-hidden="true"></span>';
  const input = document.createElement('input');
  input.id = id;
  input.className = 'select-search';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', `${id}-list`);
  input.placeholder = 'Tìm hoặc chọn…';
  const popup = document.createElement('div');
  popup.className = 'select-popup';
  popup.hidden = true;
  const list = document.createElement('div');
  list.id = `${id}-list`;
  list.className = 'select-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', caption.textContent);
  const empty = document.createElement('div');
  empty.className = 'select-empty';
  empty.setAttribute('role', 'status');
  empty.textContent = 'Không tìm thấy kết quả';
  empty.hidden = true;
  popup.append(list, empty);
  control.append(input, popup);
  select.before(control);
  select.hidden = true;
  select.tabIndex = -1;

  let open = false;
  let active = -1;
  let matches: HTMLOptionElement[] = [];
  let signature = '';

  const selectedLabel = () => select.selectedOptions[0]?.label ?? '';
  function close() {
    open = false;
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    input.value = selectedLabel();
    control.classList.remove('is-open');
  }
  function highlight(index: number, scroll = false) {
    active = index;
    Array.from(list.children).forEach((option, i) => option.classList.toggle('is-active', i === active));
    const option = list.children[active];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      if (scroll) option.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(option: HTMLOptionElement) {
    select.value = option.value;
    close();
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function position() {
    const bounds = control.getBoundingClientRect();
    const viewport = window.visualViewport;
    const dialogBounds = dialog.getBoundingClientRect();
    const top = Math.max(dialogBounds.top + 8, viewport?.offsetTop ?? 0);
    const bottom = Math.min(dialogBounds.bottom - 8, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
    const below = bottom - bounds.bottom - 6;
    const above = bounds.top - top - 6;
    const upwards = below < 200 && above > below;
    popup.classList.toggle('opens-up', upwards);
    list.style.maxHeight = `${Math.max(48, Math.min(224, upwards ? above : below) - 10)}px`;
  }
  function render(query = '') {
    const term = normalize(query);
    matches = Array.from(select.options).filter(option => !option.disabled && !option.hidden && normalize(option.label).includes(term));
    list.replaceChildren(...matches.map((option, index) => {
      const item = document.createElement('div');
      item.id = `${id}-option-${index}`;
      item.className = 'select-option';
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.textContent = option.label;
      item.onmousedown = event => event.preventDefault();
      item.onpointermove = () => highlight(index);
      item.onclick = () => choose(option);
      return item;
    }));
    empty.hidden = matches.length > 0;
    highlight(matches.length ? term ? 0 : Math.max(0, matches.findIndex(option => option.selected)) : -1);
    position();
  }
  function show(selectText = true) {
    if (input.disabled || open) return;
    open = true;
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    control.classList.add('is-open');
    render();
    if (selectText) input.select();
  }
  function sync() {
    const nextSignature = JSON.stringify([select.value, select.disabled, Array.from(select.options, option => [option.value, option.label, option.disabled, option.hidden])]);
    input.disabled = select.disabled;
    input.setAttribute('aria-required', String(select.required));
    if (signature !== nextSignature || select.disabled || label.hidden || select.form?.hidden || !dialog.open) close();
    signature = nextSignature;
  }
  input.onfocus = () => input.select();
  input.onclick = () => show();
  input.oninput = () => {
    const query = input.value;
    show(false);
    render(query);
  };
  input.onblur = close;
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) show();
      else if (matches.length) highlight((active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length, true);
    } else if (event.key === 'Enter' && open) {
      event.preventDefault();
      if (matches[active]) choose(matches[active]);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') close();
  };
  select.addEventListener('change', sync);
  dialog.addEventListener('close', close);
  // A label click focuses an already-focused input without firing blur.
  dialog.addEventListener('pointerdown', event => {
    if (open && !control.contains(event.target as Node)) close();
  });
  dialog.addEventListener('scroll', () => { if (open) position(); });
  const reposition = () => { if (open) position(); };
  window.addEventListener('resize', reposition, { signal: lifecycle.signal });
  window.visualViewport?.addEventListener('resize', reposition, { signal: lifecycle.signal });
  window.visualViewport?.addEventListener('scroll', reposition, { signal: lifecycle.signal });
  sync();
  return { sync, destroy() { lifecycle.abort(); close(); } };
}
