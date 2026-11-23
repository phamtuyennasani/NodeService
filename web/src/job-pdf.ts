import { signedFetch } from './api';
import { sanitizeArticleHtml } from './article-html';

export function hasJobPdfContent(content?: string | null): boolean {
  if (!content?.trim()) return false;
  const document = new DOMParser().parseFromString(sanitizeArticleHtml(content), 'text/html');
  return Boolean(document.body.textContent?.replace(/[\s\u00ad\u200b-\u200d\ufeff]/g, ''));
}

export function jobPdfFilename(id: string, slug?: string): string {
  const name = (slug || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/g, '');
  const suffix = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'crm';
  return `${name || 'bai-viet'}-${suffix}.pdf`;
}

export async function downloadJobPdf(id: string, slug: string | undefined, signal: AbortSignal): Promise<void> {
  const response = await signedFetch(`/jobs/${encodeURIComponent(id)}/pdf`, { signal });
  if (!/^application\/pdf(?:;|$)/i.test(response.headers.get('Content-Type') || '')) {
    throw new Error('CRM chưa trả về file PDF hợp lệ. Vui lòng thử lại.');
  }
  const pdf = await response.blob();
  signal.throwIfAborted();
  if (!pdf.size) throw new Error('File PDF chưa có nội dung. Vui lòng thử lại.');
  const url = URL.createObjectURL(pdf);
  const link = document.createElement('a');
  link.href = url;
  link.download = jobPdfFilename(id, slug);
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Let the browser finish reading the Blob before releasing its URL.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
