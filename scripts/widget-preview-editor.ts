import {
  BlockQuote, Bold, ClassicEditor, Code, CodeBlock, Essentials, GeneralHtmlSupport,
  Heading, HorizontalLine, Italic, Link, List, Paragraph, SourceEditing,
  Table, TableToolbar, Underline,
} from 'ckeditor5'
import vi from 'ckeditor5/translations/vi.js'
import 'ckeditor5/ckeditor5.css'
import './widget-preview-editor.css'
import type { AIConfig } from '../widget/ai-writer'
import { articleStyleRules } from '../src/article-styles'
import { previewLanguages, previewLocales } from '../src/widget-preview-page'

async function start() {
  const form = document.querySelector<HTMLFormElement>('#article')!
  const applied = document.querySelector<HTMLElement>('#applied')!
  const editors = new Map<string, ClassicEditor>()
  const sources = new Map(previewLocales.map(locale => [locale, form.querySelector<HTMLTextAreaElement>(`#article-content-${locale}`)!]))
  const tabs = Array.from(form.querySelectorAll<HTMLButtonElement>('[data-article-tab]'))
  const tablist = form.querySelector<HTMLElement>('.article-tabs')!
  for (const tab of tabs) tab.onclick = () => {
    for (const item of tabs) {
      const active = item === tab
      item.setAttribute('aria-selected', String(active))
      item.tabIndex = active ? 0 : -1
      form.querySelector<HTMLElement>(`#${item.getAttribute('aria-controls')}`)!.hidden = !active
    }
  }
  tablist.onkeydown = event => {
    const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
    if (current < 0) return
    const next = event.key === 'ArrowRight' ? (current + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (current - 1 + tabs.length) % tabs.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1
    if (next < 0) return
    event.preventDefault()
    tabs[next].click()
    tabs[next].focus()
  }

  // Keep the website field in sync for FormData and the widget's normal events.
  const sync = (locale: string) => {
    const source = sources.get(locale)!
    const editor = editors.get(locale)
    source.value = editor?.getData() ?? source.value
    source.dispatchEvent(new Event('input', { bubbles: true }))
    source.dispatchEvent(new Event('change', { bubbles: true }))
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    for (const locale of previewLocales) sync(locale)
  })
  form.addEventListener('change', () => {
    applied.textContent = 'Nội dung đã được điền vào form website. Bài AI gốc được lưu trong CRM; các chỉnh sửa trong form này chỉ nằm trên trình duyệt.'
  })

  await Promise.all(previewLocales.map(async locale => {
    const source = sources.get(locale)!
    const status = document.querySelector<HTMLElement>(`#editor-status-${locale}`)!
    try {
      const editor = await ClassicEditor.create({
        attachTo: source,
        // This editor is self-hosted for the local demo under CKEditor's GPL option.
        licenseKey: 'GPL',
        language: { ui: 'vi', content: locale },
        translations: [vi],
        plugins: [
          Essentials, Paragraph, Heading, Bold, Italic, Underline, Link, List, Code,
          BlockQuote, CodeBlock, HorizontalLine, Table, TableToolbar,
          GeneralHtmlSupport, SourceEditing,
        ],
        toolbar: {
          items: [
            'undo', 'redo', '|', 'heading', '|', 'bold', 'italic', 'underline', 'link',
            '|', 'bulletedList', 'numberedList', 'blockQuote', 'insertTable',
            '|', 'sourceEditing',
          ],
          shouldNotGroupWhenFull: true,
        },
        heading: { options: [
          { model: 'paragraph', title: 'Đoạn văn', class: 'ck-heading_paragraph' },
          { model: 'heading2', view: 'h2', title: 'Tiêu đề 2', class: 'ck-heading_heading2' },
          { model: 'heading3', view: 'h3', title: 'Tiêu đề 3', class: 'ck-heading_heading3' },
          { model: 'heading4', view: 'h4', title: 'Tiêu đề 4', class: 'ck-heading_heading4' },
        ] },
        table: { contentToolbar: ['tableColumn', 'tableRow', 'mergeTableCells'] },
        htmlSupport: { allow: [{
          name: /^(p|h2|h3|h4|span|a|ul|ol|li|blockquote|pre|code|table|thead|tbody|tr|td|th)$/,
          attributes: ['title', 'scope', 'colspan', 'rowspan'],
          styles: Object.entries(articleStyleRules).flatMap(([key, rules]) => rules.map(value => ({ key, value }))),
        }] },
        root: { placeholder: 'Soạn nội dung hoặc bấm Viết bài AI, sau đó chọn Áp dụng…' },
      })
      editors.set(locale, editor)
      editor.model.document.on('change:data', () => sync(locale))
      editor.ui.getEditableElement()?.setAttribute('aria-labelledby', `content-label-${locale}`)
      status.textContent = 'CKEditor 5 · Soạn thảo trực quan hoặc dùng nút Nguồn để chỉnh HTML.'
      status.dataset.state = 'ready'
    } catch (error) {
      console.error('Không khởi tạo được CKEditor trong demo.', error)
      source.parentElement?.querySelector('.ck-editor')?.remove()
      source.style.display = ''
      status.textContent = 'Không tải được CKEditor. Bạn vẫn có thể nhập và áp dụng HTML trong ô bên trên; tải lại trang để thử lại.'
      status.dataset.state = 'fallback'
    }
  }))

  const defaults: AIConfig['defaults'] = JSON.parse(document.querySelector('#widget-defaults')!.textContent!)
  window.AIWriter.mount({
    mount: '#tools', form: '#article', endpoint: '/admin/ai/previews',
    modelsEndpoint: '/admin/ai/models', keyMode: 'service', defaults,
    languages: previewLanguages,
    fields: {
      Title: '[name="title[$lang]"]',
      Content: {
        selector: '[name="body[$lang]"]',
        getValue: element => editors.get((element as HTMLElement).dataset.editorLocale!)?.getData() ?? (element as HTMLTextAreaElement).value,
        setValue: (element, value) => {
          const locale = (element as HTMLElement).dataset.editorLocale!
          const source = sources.get(locale)!
          const editor = editors.get(locale)
          if (editor) {
            // Finish source editing first so its buffer cannot overwrite the AI article.
            editor.plugins.get(SourceEditing).isSourceEditingMode = false
            editor.setData(value)
          } else {
            source.value = value
          }
          sync(locale)
        },
      },
      Slug: '[name="slug[$lang]"]', Desc: '[name="summary[$lang]"]', Description: '[name="seo_description[$lang]"]',
      Keywords: '[name="keywords[$lang]"]', FocusKeyword: '[name="focus_keyword[$lang]"]',
    },
  })
}

void start()
