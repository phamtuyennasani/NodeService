<script
    src="{{ $src }}"
    data-authorize-url="{{ route('crm-ai.authorize') }}"
    data-credentials-url="{{ route('crm-ai.credentials') }}"
    data-csrf-token="{{ csrf_token() }}"
></script>
