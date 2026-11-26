@php($crm = app(\NodeService\CrmAi\CrmAi::class))
@if ($crm->canManage())
@php($settings = $crm->form())
<section class="crm-ai-settings">
    <h2>Cấu hình AI</h2>
    @if (!$settings['schema_ready'])
        <p role="alert">Chạy <code>php artisan crm-ai:install</code> để hoàn tất cài đặt.</p>
    @else
        @if (session('success'))<p role="status">{{ session('success') }}</p>@endif
        @if ($settings['decryption_failed'])<p role="alert">Không đọc được key đã lưu. Nhập lại đủ Base URL, API key và model.</p>@endif
        <form action="{{ route('crm-ai.settings.update') }}" method="POST" autocomplete="off">
            @csrf
            @method('PUT')
            <p>
                <label>Base URL <input type="url" name="base_url" maxlength="500" value="{{ old('base_url', $settings['base_url']) }}" placeholder="https://api.example.com/v1"></label>
                @error('base_url', 'crmAi')<span role="alert">{{ $message }}</span>@enderror
            </p>
            <p>
                <label>API key <input type="password" name="api_key" maxlength="2048" autocomplete="new-password" spellcheck="false"></label>
                <small>{{ $settings['has_api_key'] ? 'Để trống để giữ key hiện tại.' : 'Nhập key riêng khi cần dùng.' }}</small>
                @error('api_key', 'crmAi')<span role="alert">{{ $message }}</span>@enderror
            </p>
            <p>
                <label>Model <input name="model" maxlength="160" value="{{ old('model', $settings['model']) }}"></label>
                @error('model', 'crmAi')<span role="alert">{{ $message }}</span>@enderror
            </p>
            <button type="submit">Lưu cấu hình AI</button>
            @if ($settings['has_api_key'] || $settings['decryption_failed'])
                <button type="submit" name="remove_credentials" value="1" formnovalidate>Xóa cấu hình key riêng</button>
            @endif
        </form>
    @endif
</section>
@endif
