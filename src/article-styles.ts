// Shared by the writer and Laravel widget so article formatting survives both filters.
// Only presentational values are accepted: no URLs, CSS variables or page positioning.
const length = '(?:0|(?:\\d{1,4}(?:\\.\\d{1,3})?|\\.\\d{1,3})(?:px|pt|em|rem|%))'
const color = '(?:#[a-f0-9]{3,4}|#[a-f0-9]{6}|#[a-f0-9]{8}|[a-z]+|rgba?\\([\\d.,%\\s]+\\)|hsla?\\([\\d.,%\\s]+\\))'
const rule = (value: string) => new RegExp(`^(?:${value})$`, 'i')
const lengths = rule(`${length}(?:\\s+${length}){0,3}`)
const borderToken = `(?:${length}|thin|medium|thick|none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset|${color})`
const border = rule(`${borderToken}(?:\\s+${borderToken}){0,2}`)

export const articleStyleRules: Record<string, RegExp[]> = {
  color: [rule(color)],
  background: [rule(color)],
  'background-color': [rule(color)],
  'font-family': [/^[a-z0-9 ,"'-]{1,160}$/i],
  'font-size': [rule(`${length}|small|medium|large|smaller|larger`)],
  'font-weight': [/^(?:normal|bold|bolder|lighter|[1-9]00)$/i],
  'font-style': [/^(?:normal|italic|oblique)$/i],
  'line-height': [rule(`${length}|\\d{1,2}(?:\\.\\d{1,3})?|normal`)],
  'letter-spacing': [rule(`${length}|normal`)],
  'text-align': [/^(?:left|right|center|justify|start|end)$/i],
  'text-decoration': [/^(?:none|underline|overline|line-through)(?:\s+(?:underline|overline|line-through))*$/i],
  'text-transform': [/^(?:none|capitalize|uppercase|lowercase)$/i],
  'vertical-align': [rule(`${length}|baseline|sub|super|top|text-top|middle|bottom|text-bottom`)],
  'white-space': [/^(?:normal|nowrap|pre-wrap|pre-line|break-spaces)$/i],
  'word-break': [/^(?:normal|break-all|keep-all|break-word)$/i],
  'overflow-wrap': [/^(?:normal|break-word|anywhere)$/i],
  width: [rule(`${length}|auto`)],
  'max-width': [rule(`${length}|none`)],
  'min-width': [rule(length)],
  height: [rule(`${length}|auto`)],
  'border-collapse': [/^(?:collapse|separate)$/i],
  'border-spacing': [rule(`${length}(?:\\s+${length})?`)],
  'table-layout': [/^(?:auto|fixed)$/i],
  'caption-side': [/^(?:top|bottom)$/i],
  'border-radius': [lengths],
  padding: [lengths],
  margin: [rule(`(?:${length}|auto)(?:\\s+(?:${length}|auto)){0,3}`)],
}

for (const side of ['', '-top', '-right', '-bottom', '-left']) {
  articleStyleRules[`border${side}`] = [border]
  articleStyleRules[`border${side}-width`] = [lengths, /^(?:thin|medium|thick)$/i]
  articleStyleRules[`border${side}-style`] = [/^(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)(?:\s+(?:none|hidden|dotted|dashed|solid|double|groove|ridge|inset|outset)){0,3}$/i]
  articleStyleRules[`border${side}-color`] = [rule(`${color}(?:\\s+${color}){0,3}`)]
  if (side) {
    articleStyleRules[`padding${side}`] = [rule(length)]
    articleStyleRules[`margin${side}`] = [rule(`${length}|auto`)]
  }
}

export function sanitizeArticleStyle(style: string): string {
  if (style.length > 8_000) return ''
  return style.split(';').flatMap(declaration => {
    const separator = declaration.indexOf(':')
    if (separator < 1) return []
    const property = declaration.slice(0, separator).trim().toLowerCase()
    const rules = Object.hasOwn(articleStyleRules, property) ? articleStyleRules[property] : undefined
    if (!rules) return []
    const raw = declaration.slice(separator + 1).trim()
    // Escapes, comments and control characters must not change how CSS is parsed.
    if (/[\\{}<>@\u0000-\u001f\u007f]|\/\*|\*\//.test(raw)) return []
    const important = /\s*!important\s*$/i.test(raw)
    const value = raw.replace(/\s*!important\s*$/i, '').trim()
    return rules.some(pattern => pattern.test(value))
      ? [`${property}:${value}${important ? ' !important' : ''}`]
      : []
  }).join(';')
}
