import { Parser } from 'htmlparser2'
import type { InternalLinkCandidate } from '../site-content.js'
import { visibleText } from './seo.js'

export interface InternalLinkOptions {
  candidates: readonly InternalLinkCandidate[]
  siteDomain?: string | null
  maxLinks?: number
  /** Only hrefs read from the already-sanitized source article may be supplied here. */
  preserveUrls?: readonly string[]
}

export interface InternalLinkResult {
  content: string
  used: { url: string; anchor: string }[]
  removed: number
}

const protectedTags = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'script', 'style', 'template', 'textarea'])
const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const cleanText = (value: string, maximum: number) => value.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim().slice(0, maximum)
const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function webUrl(value: string, base?: URL): URL | null {
  const href = value.trim()
  // Do not let WHATWG URL normalization turn control characters or backslashes into a different address.
  if (!href || /[\u0000-\u0020\u007F\\]/.test(href) || href.length > 2_048) return null
  try {
    const url = new URL(href, base)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null
  } catch { return null }
}

function preservedUrlKey(value: string, base?: URL): string | null {
  const web = webUrl(value, base)
  if (web) return web.href
  // Existing editorial contact links may remain; new mailto links are never catalog candidates.
  if (/^mailto:/i.test(value) && !/[\u0000-\u0020\u007F\\]/.test(value) && value.length <= 2_048) return value
  return null
}

function siteUrl(value?: string | null): URL | null {
  if (!value?.trim()) return null
  const site = value.trim()
  const url = webUrl(site.includes('://') ? site : 'https://' + site)
  if (!url) return null
  // Relative article URLs are resolved from the website root, never a configuration path.
  return new URL(url.origin + '/')
}

function sameSite(url: URL, site: URL): boolean {
  const host = (value: URL) => value.hostname.replace(/^www\./, '').replace(/\.$/, '')
  return host(url) === host(site) && url.port === site.port
}

function targetKey(url: URL): string {
  // Ignore only the www alias and protocol for same-site comparison. Query strings and fragments
  // remain exact: neither tracking parameters nor meaningful filters are silently discarded.
  return url.hostname.replace(/^www\./, '').replace(/\.$/, '') + ':' + url.port + url.pathname + url.search + url.hash
}

/** Bound the shortlist identically for the provider prompt and output enforcement. No I/O or AI calls. */
export function prepareInternalLinkCandidates(candidates: readonly InternalLinkCandidate[], siteDomain?: string | null): InternalLinkCandidate[] {
  const site = siteUrl(siteDomain)
  if (!site) return []
  const seen = new Set<string>()
  const selected: InternalLinkCandidate[] = []
  for (const candidate of candidates) {
    const url = webUrl(candidate.url, site)
    if (!url || !sameSite(url, site) || !candidate.title?.trim()) continue
    const key = targetKey(url)
    if (seen.has(key)) continue
    seen.add(key)
    selected.push({
      id: cleanText(candidate.id, 128), url: url.href,
      title: cleanText(candidate.title, 200), summary: cleanText(candidate.summary ?? '', 400),
      ...(candidate.categories?.length ? { categories: candidate.categories.slice(0, 4).map(value => cleanText(value, 80)).filter(Boolean) } : {}),
    })
    if (selected.length === 8) break
  }
  return selected
}

interface LinkNode {
  start: number
  openEnd: number
  closeStart: number | null
  closeEnd: number | null
  end: number
  href: string
  prohibited: boolean
  nested: boolean
  hidden: boolean
}

/** Read href values with the HTML parser, including entity decoding; callers own source sanitization. */
export function extractArticleLinks(html: string): string[] {
  const links: string[] = []
  new Parser({ onopentag(tag, attributes) { if (tag === 'a' && attributes.href) links.push(attributes.href) } }, { decodeEntities: true }).end(html)
  return links
}

function meaningfulAnchor(value: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(value)) return false
  if (/^(?:https?:\/\/|www\.|\/)/i.test(value)) return false
  const normalized = value.normalize('NFD').replace(/\p{Mark}/gu, '').toLowerCase().replace(/đ/g, 'd').replace(/[\p{P}\p{S}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return !/^(?:xem them|xem chi tiet|chi tiet|tai day|bam vao day|nhan vao day|click here|read more|learn more|here|link)$/.test(normalized)
}

/**
 * Apply a closed URL shortlist to sanitized article HTML. Only anchor tags are patched; existing
 * content, entity spelling, table markup and inline CSS elsewhere remain byte-for-byte intact.
 */
export function enforceInternalLinks(html: string, options: InternalLinkOptions): InternalLinkResult {
  const site = siteUrl(options.siteDomain)
  const candidates = prepareInternalLinkCandidates(options.candidates, options.siteDomain)
  const allowed = new Map(candidates.flatMap(candidate => {
    const url = webUrl(candidate.url, site ?? undefined)
    return url ? [[targetKey(url), candidate] as const] : []
  }))
  const preserved = new Map<string, number>()
  const preservedTargets = new Set<string>()
  for (const href of options.preserveUrls ?? []) {
    const key = preservedUrlKey(href, site ?? undefined)
    if (!key) continue
    const url = webUrl(href, site ?? undefined)
    preserved.set(key, (preserved.get(key) ?? 0) + 1)
    if (url) preservedTargets.add(targetKey(url))
  }
  const requestedLimit = options.maxLinks ?? 3
  const maximum = Number.isFinite(requestedLimit) ? Math.max(0, Math.min(3, Math.floor(requestedLimit))) : 3
  const nodes: LinkNode[] = []
  const stack: { tag: string; link?: LinkNode; protected: boolean; hidden: boolean }[] = []
  let parser: Parser
  parser = new Parser({
    onopentag(tag, attributes) {
      const isProtected = protectedTags.has(tag) || stack.some(node => node.protected)
      if (protectedTags.has(tag)) for (const frame of stack) if (frame.link) frame.link.prohibited = true
      const hidden = Object.hasOwn(attributes, 'hidden') || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important)?\s*(?:;|$)/i.test(attributes.style ?? '') || stack.some(node => node.hidden)
      let link: LinkNode | undefined
      if (tag === 'a') {
        const ancestors = stack.flatMap(node => node.link ? [node.link] : [])
        for (const ancestor of ancestors) ancestor.nested = true
        link = {
          start: parser.startIndex, openEnd: parser.endIndex + 1, closeStart: null, closeEnd: null,
          end: html.length, href: attributes.href ?? '', prohibited: isProtected,
          nested: ancestors.length > 0, hidden,
        }
        nodes.push(link)
      }
      if (!voidTags.has(tag)) stack.push({ tag, link, protected: isProtected, hidden })
    },
    onclosetag(tag, implied) {
      if (voidTags.has(tag)) return
      let index = stack.length - 1
      while (index >= 0 && stack[index].tag !== tag) index -= 1
      if (index < 0) return
      const frame = stack[index]
      stack.splice(index)
      if (frame.link) {
        frame.link.end = implied ? html.length : parser.endIndex + 1
        if (!implied && html.slice(parser.startIndex, parser.endIndex + 1).toLowerCase().startsWith('</a')) {
          frame.link.closeStart = parser.startIndex
          frame.link.closeEnd = parser.endIndex + 1
        }
      }
    },
  }, { xmlMode: true, decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true })
  // XML mode reports lexical nested anchors instead of silently auto-closing them. Article HTML
  // has already passed cleanArticle; void elements are handled explicitly above.
  parser.end(html)

  const edits: { start: number; end: number; value: string }[] = []
  const used: InternalLinkResult['used'] = []
  const seen = new Set<string>()
  let removed = 0
  for (const node of nodes) {
    const anchor = cleanText(visibleText(html.slice(node.openEnd, node.closeStart ?? node.end)), 500)
    const url = webUrl(node.href, site ?? undefined)
    const sourceKey = preservedUrlKey(node.href, site ?? undefined)
    const sourceCopies = sourceKey ? preserved.get(sourceKey) ?? 0 : 0
    const candidate = url && site && sameSite(url, site) ? allowed.get(targetKey(url)) : undefined
    const key = url ? targetKey(url) : ''
    const safe = Boolean(node.closeStart !== null && !node.prohibited && !node.hidden && !node.nested && anchor && (url || sourceCopies > 0))
    const keepCatalog = Boolean(safe && candidate && meaningfulAnchor(anchor) && !preservedTargets.has(key) && !seen.has(key) && used.length < maximum)
    if (safe && sourceCopies > 0 && sourceKey) {
      preserved.set(sourceKey, sourceCopies - 1)
      continue
    }
    if (keepCatalog && candidate) {
      // Write the trusted catalog URL, not a relative/alternate representation invented by AI.
      const opening = html.slice(node.start, node.openEnd)
      let replacement: { start: number; end: number; value: string } | undefined
      let attributesParser: Parser
      attributesParser = new Parser({ onattribute(name) {
        if (name !== 'href' || replacement) return
        const raw = opening.slice(attributesParser.startIndex, attributesParser.endIndex + 1)
        const trailing = raw.match(/[\s>]*$/)?.[0] ?? ''
        replacement = { start: node.start + attributesParser.startIndex, end: node.start + attributesParser.endIndex + 1, value: `href="${escapeAttribute(candidate.url)}"` + trailing }
      } }, { decodeEntities: true, lowerCaseAttributeNames: true })
      attributesParser.end(opening)
      if (replacement) edits.push(replacement)
      used.push({ url: candidate.url, anchor })
      seen.add(key)
      continue
    }
    removed += 1
    // Unwrap only the anchor. Preserve inline CSS as a span when the removed link carried it.
    const opening = html.slice(node.start, node.openEnd)
    let style = ''
    new Parser({ onopentag(_tag, attributes) { style = attributes.style ?? '' } }).end(opening)
    const preserveStyle = Boolean(style && node.closeStart !== null)
    edits.push({ start: node.start, end: node.openEnd, value: preserveStyle ? `<span style="${escapeAttribute(style)}">` : '' })
    if (node.closeStart !== null && node.closeEnd !== null) edits.push({ start: node.closeStart, end: node.closeEnd, value: preserveStyle ? '</span>' : '' })
  }
  let content = html
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.value + content.slice(edit.end)
  return { content, used, removed }
}
