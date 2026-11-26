@php($crm = app(\NodeService\CrmAi\CrmAi::class))
@if ($crm->canWrite() && ($src = $crm->scriptUrl()))
@once
<script src="{{ $src }}" data-authorize-url="{{ route('crm-ai.authorize') }}"></script>
@endonce
@endif
