import sanitizeHtml from 'sanitize-html'
import { articleStyleRules, sanitizeArticleStyle } from './article-styles.js'

/** Keep saved articles and exports on the same HTML and inline-style allowlist. */
export function sanitizeArticleContent(content: string, styleFilter = sanitizeArticleStyle, print = false): string {
  return sanitizeHtml(content, {
    allowedTags: ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'span', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr', 'code', 'pre'],
    allowedAttributes: { '*': ['style'], a: ['href'], th: ['scope', 'colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
    allowedStyles: { '*': articleStyleRules },
    transformTags: { '*': (tagName, attribs) => {
      if (attribs.style) {
        const style = styleFilter(attribs.style)
        if (style) attribs.style = style
        else delete attribs.style
      }
      // Avoid pathological table spans in imported HTML while keeping ordinary merges.
      for (const key of print ? ['colspan', 'rowspan'] : []) {
        if (attribs[key] && !/^(?:[1-9]|[1-9]\d)$/.test(attribs[key])) delete attribs[key]
      }
      return { tagName, attribs }
    } },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
  })
}
