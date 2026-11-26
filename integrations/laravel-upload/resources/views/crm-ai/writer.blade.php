@if (request()->user() !== null && app(\App\CrmAi\Bridge::class)->connection() !== null)
<span id="news-ai-writer"
    data-slug-multilang="{{ ($slugMultilang ?? true) ? '1' : '0' }}"
    data-seo-multilang="{{ ($seoMultilang ?? true) ? '1' : '0' }}"
></span>
@section('crm-ai-writer-enabled', '1')
@endif
