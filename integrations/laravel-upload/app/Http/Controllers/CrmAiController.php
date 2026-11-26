<?php

namespace App\Http\Controllers;

use App\CrmAi\Bridge;
use App\CrmAi\PrivateFiles;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use RuntimeException;

class CrmAiController
{
    public function authorizeWriting(Request $request, Bridge $bridge, PrivateFiles $files)
    {
        abort_unless($request->user() !== null, 403);
        $connection = $bridge->connection();
        abort_if($connection === null, 503, 'Cấu hình kết nối CRM chưa hợp lệ.');

        $body = $request->input('body');
        $id = $request->input('id');
        if (! is_string($body) || strlen($body) > 524288 || ! is_string($id)
            || ! preg_match('/\A[\x21-\x7e]{1,160}\z/', $id)) {
            return response()->json(['message' => 'Yêu cầu cấp chữ ký không hợp lệ.'], 422);
        }
        $payload = json_decode($body);
        if (! is_object($payload) || ! is_string($payload->keyword ?? null) || ! is_string($payload->model ?? null)) {
            return response()->json(['message' => 'Thiếu từ khóa hoặc model trong yêu cầu viết.'], 422);
        }

        try {
            $proof = $bridge->proof($connection, $request, $body, $id, $files);
        } catch (RuntimeException $error) {
            return response()->json(['message' => 'Tạo khóa máy chủ trong trang cấu hình AI rồi đăng ký khóa công khai trên CRM.'], 503);
        }
        return response()->json(['proof' => $proof]);
    }

    public function credentials(Request $request, Bridge $bridge, PrivateFiles $files)
    {
        abort_unless($request->user() !== null && $bridge->connection() !== null, 403);
        try {
            $saved = $files->credentials();
        } catch (DecryptException $error) {
            $saved = [];
        }
        $url = trim((string) ($saved['base_url'] ?? ''));
        $key = trim((string) ($saved['api_key'] ?? ''));
        $model = trim((string) ($saved['model'] ?? ''));
        $valid = strlen($url) <= 500 && Bridge::validProviderUrl($url)
            && $key !== '' && strlen($key) <= 2048 && ! preg_match('/[\r\n\x00]/', $key)
            && strlen($model) <= 160 && preg_match('/\A[^\x00-\x20\x7f]+\z/u', $model);

        return response()->json([
            'base_url' => $valid ? rtrim($url, '/') : null,
            'api_key' => $valid ? $key : null,
            'model' => $valid ? $model : null,
        ]);
    }

    public function settings(Request $request, Bridge $bridge, PrivateFiles $files)
    {
        abort_unless($request->user() !== null, 403);
        $failed = false;
        try {
            $saved = $files->credentials();
        } catch (DecryptException $error) {
            $saved = [];
            $failed = true;
        }
        return view('crm-ai.settings', [
            'connected' => $bridge->connection() !== null,
            'publicKey' => $files->publicKey(),
            'baseUrl' => $saved['base_url'] ?? '',
            'model' => $saved['model'] ?? '',
            'hasKey' => ! empty($saved['api_key']),
            'failed' => $failed,
        ]);
    }

    public function createSigningKey(Request $request, Bridge $bridge, PrivateFiles $files)
    {
        abort_unless($request->user() !== null, 403);
        abort_if($bridge->connection() === null, 422, 'Điền mã kết nối CRM trước khi tạo khóa.');
        $files->ensureSigningKey();
        return redirect()->route('crm-ai.settings');
    }

    public function saveSettings(Request $request, PrivateFiles $files)
    {
        abort_unless($request->user() !== null, 403);
        $redirect = redirect()->route('crm-ai.settings');
        if ($request->boolean('remove_credentials')) {
            $files->clearCredentials();
            return $redirect->with('crmAiSaved', 'Đã xóa cấu hình key AI riêng.');
        }
        $validator = Validator::make($request->only(['base_url', 'api_key', 'model', 'provider']), [
            'provider' => ['prohibited'],
            'base_url' => ['required', 'string', 'max:500', function ($attribute, $value, $fail) {
                if (! is_string($value) || ! Bridge::validProviderUrl($value)) {
                    $fail('Nhập Base URL HTTPS của nhà cung cấp AI.');
                }
            }],
            'api_key' => ['nullable', 'string', 'max:2048', 'regex:/\A[^\r\n\x00]+\z/'],
            'model' => ['required', 'string', 'max:160', 'regex:/\A[^\x00-\x20\x7f]+\z/u'],
        ]);
        if ($validator->fails()) {
            if ($request->expectsJson()) {
                return response()->json(['message' => 'Cấu hình AI không hợp lệ.', 'errors' => $validator->errors()], 422);
            }
            return $redirect->withErrors($validator)->withInput($request->only(['base_url', 'model']));
        }
        $data = $validator->validated();
        if (! $files->saveCredentials(rtrim($data['base_url'], '/'), $data['api_key'] ?? '', $data['model'])) {
            $message = 'Nhập API key để lưu lần đầu hoặc thay thế key cũ.';
            if ($request->expectsJson()) {
                return response()->json(['message' => $message, 'errors' => ['api_key' => [$message]]], 422);
            }
            return $redirect->withErrors(['api_key' => $message])
                ->withInput($request->only(['base_url', 'model']));
        }
        return $redirect->with('crmAiSaved', 'Đã lưu cấu hình AI.');
    }
}
