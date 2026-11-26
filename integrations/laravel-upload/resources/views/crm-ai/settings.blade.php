<!doctype html>
<html lang="vi">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cấu hình CRM AI</title>
<main>
    <h1>Cấu hình CRM AI</h1>
    <h2>Khóa máy chủ</h2>
    @if (!$connected)
        <p role="alert">Chưa có kết nối hợp lệ. Kiểm tra cấu hình trong bộ CrmAi.</p>
    @elseif ($publicKey)
        <p>Dán khóa công khai này vào CRM → Website → Kết nối API → Đăng ký khóa ký.</p>
        <p><textarea readonly rows="5" cols="65" aria-label="Khóa công khai">{{ $publicKey }}</textarea></p>
    @else
        <form method="post" action="{{ route('crm-ai.signing-key') }}">
            @csrf
            <button type="submit">Tạo khóa máy chủ</button>
        </form>
    @endif

    <h2>Key AI riêng</h2>
    @if (session('crmAiSaved'))
        <p role="status">{{ session('crmAiSaved') }}</p>
    @endif
    @if ($failed)
        <p role="alert">Không đọc được key đã lưu. Nhập lại cấu hình để thay thế.</p>
    @endif
    <form method="post" action="{{ route('crm-ai.save-settings') }}" autocomplete="off">
        @csrf
        @method('PUT')
        <p><label>Base URL <input required type="url" name="base_url" maxlength="500" size="45" placeholder="https://api.example.com/v1" value="{{ old('base_url', $baseUrl) }}"></label>
            @error('base_url') <span role="alert">{{ $message }}</span> @enderror
        </p>
        <p><label>API key <input @if (!$hasKey) required @endif type="password" name="api_key" maxlength="2048" autocomplete="new-password"></label>
            @if ($hasKey) <small>Để trống nếu giữ key đang dùng.</small> @endif
            @error('api_key') <span role="alert">{{ $message }}</span> @enderror
        </p>
        <p><label>Model <input required name="model" maxlength="160" value="{{ old('model', $model) }}"></label>
            @error('model') <span role="alert">{{ $message }}</span> @enderror
        </p>
        <button type="submit">Lưu cấu hình AI</button>
        @if ($hasKey || $failed)
            <button type="submit" name="remove_credentials" value="1" formnovalidate>Xóa cấu hình key riêng</button>
        @endif
    </form>
</main>
</html>
