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

async function start() {
  const form = document.querySelector<HTMLFormElement>('#article')!
  const source = form.querySelector<HTMLTextAreaElement>('#article-content')!
  const status = document.querySelector<HTMLElement>('#editor-status')!
  const applied = document.querySelector<HTMLElement>('#applied')!
  let editor: ClassicEditor | undefined

  // Keep the website field in sync for FormData and the widget's normal events.
  const sync = () => {
    source.value = editor?.getData() ?? source.value
    source.dispatchEvent(new Event('input', { bubbles: true }))
    source.dispatchEvent(new Event('change', { bubbles: true }))
  }

  form.addEventListener('submit', event => {
    event.preventDefault()
    sync()
  })
  form.addEventListener('change', () => {
    applied.textContent = 'Nội dung đã được điền vào form website. Bài AI gốc được lưu trong CRM; các chỉnh sửa trong form này chỉ nằm trên trình duyệt.'
  })

  try {
    editor = await ClassicEditor.create({
      attachTo: source,
      // This editor is self-hosted for the local demo under CKEditor's GPL option.
      licenseKey: 'GPL',
      language: 'vi',
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
    editor.model.document.on('change:data', sync)
    editor.ui.getEditableElement()?.setAttribute('aria-labelledby', 'content-label')
    status.textContent = 'CKEditor 5 · Soạn thảo trực quan hoặc dùng nút Nguồn để chỉnh HTML.'
    status.dataset.state = 'ready'
  } catch (error) {
    console.error('Không khởi tạo được CKEditor trong demo.', error)
    source.parentElement?.querySelector('.ck-editor')?.remove()
    source.style.display = ''
    status.textContent = 'Không tải được CKEditor. Bạn vẫn có thể nhập và áp dụng HTML trong ô bên trên; tải lại trang để thử lại.'
    status.dataset.state = 'fallback'
  }

  const defaults: AIConfig['defaults'] = JSON.parse(document.querySelector('#widget-defaults')!.textContent!)
  window.AIWriter.mount({
    mount: '#tools', form: '#article', endpoint: '/admin/ai/previews',
    modelsEndpoint: '/admin/ai/models', keyMode: 'service', defaults,
    fields: {
      Title: '[name="title"]',
      Content: {
        selector: '[name="body"]',
        getValue: () => editor?.getData() ?? source.value,
        setValue: (_element, value) => {
          if (editor) {
            // Finish source editing first so its buffer cannot overwrite the AI article.
            editor.plugins.get(SourceEditing).isSourceEditingMode = false
            editor.setData(value)
          } else {
            source.value = value
          }
          sync()
        },
      },
      Slug: '[name="slug"]', Desc: '[name="summary"]', Description: '[name="seo_description"]',
      Keywords: '[name="keywords"]', FocusKeyword: '[name="focus_keyword"]',
    },
  })
}

void start()
