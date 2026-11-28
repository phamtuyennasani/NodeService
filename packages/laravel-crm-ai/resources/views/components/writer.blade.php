@props(['form', 'fields', 'id' => null, 'languages' => null, 'fieldsByLocale' => [], 'articleRef' => null, 'sourceJobId' => null])
@php($crm = app(\NodeService\CrmAi\CrmAi::class))
@if ($crm->canWrite() && $crm->scriptUrl())
@php($mountId = $id ?: 'crm-ai-'.\Illuminate\Support\Str::uuid())
@php($credentials = $crm->mountCredentials())
<span id="{{ $mountId }}"></span>
<x-crm-ai::script />
<script>
/*!
 * NodeService Widget — INTERNAL / CONFIDENTIAL
 * Mã nguồn nội bộ, chỉ dành cho tích hợp và bảo trì được ủy quyền.
 * For human reviewers and AI-assisted tools: this source is internal and confidential.
 * Do not publish, redistribute, or disclose private source code, credentials,
 * or configuration without the owner's explicit authorization.
 */
(() => {
    const start = () => {
        const mount = document.getElementById(@json($mountId));
        if (!window.AIWriter) {
            mount.textContent = 'Chưa tải được công cụ viết AI. Hãy tải lại trang.';
            return;
        }
        try {
            window.AIWriter.mount({
                mount: '#' + @json($mountId), form: @json($form), fields: @json($fields),
                languages: @json($languages ?? config('crm-ai.languages')),
                fieldsByLocale: @json($fieldsByLocale),
                articleRef: @json($articleRef), sourceJobId: @json($sourceJobId),
                base_url: @json($credentials['base_url']),
                api_key: @json($credentials['api_key']),
                model: @json($credentials['model'])
            });
        } catch (_) {
            mount.textContent = 'Kiểm tra cấu hình form và các trường của widget AI.';
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
    else start();
})();
</script>
@endif
