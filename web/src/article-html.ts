import createDOMPurify from 'dompurify';
import { sanitizeArticleStyle } from '../../src/article-styles';

// Treat saved and generated articles as untrusted even after server filtering.
// This also protects administrators opening older/imported article records.
const purifier = createDOMPurify(window);
purifier.addHook('uponSanitizeAttribute', (_node, attribute) => {
  if (attribute.attrName === 'style') {
    attribute.attrValue = sanitizeArticleStyle(attribute.attrValue);
    attribute.keepAttr = Boolean(attribute.attrValue);
  }
  if (attribute.attrName === 'href') {
    const href = attribute.attrValue.trim();
    try {
      const url = new URL(href, window.location.href);
      attribute.keepAttr = !/[\u0000-\u0020\u007f]/.test(href) &&
        !href.replace(/\\/g, '/').startsWith('//') &&
        ['https:', 'http:', 'mailto:'].includes(url.protocol);
    } catch { attribute.keepAttr = false; }
  }
});

export function sanitizeArticleHtml(html: string): string {
  return purifier.sanitize(html, {
    ALLOWED_TAGS: ['p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'a', 'span', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'br', 'hr', 'code', 'pre'],
    ALLOWED_ATTR: ['style', 'href', 'title', 'scope', 'colspan', 'rowspan'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
}
