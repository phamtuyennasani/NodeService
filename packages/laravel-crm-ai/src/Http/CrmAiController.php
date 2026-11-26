<?php

namespace NodeService\CrmAi\Http;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Validator;
use NodeService\CrmAi\Contracts\CredentialsStore;
use NodeService\CrmAi\CrmAi;

class CrmAiController
{
    public function authorizeWriting(Request $request, CrmAi $crm): JsonResponse
    {
        abort_unless($crm->enabled() && $crm->canWrite(), 403);
        $validator = Validator::make($request->all(), [
            'body' => ['required', 'string', 'max:524288', 'json'],
            'id' => ['required', 'string', 'max:160', 'regex:/\A[\x21-\x7e]+\z/'],
        ]);
        if ($validator->fails()) {
            return response()->json(['message' => 'Yêu cầu cấp chữ ký không hợp lệ.', 'errors' => $validator->errors()], 422);
        }
        $input = $validator->validated();
        abort_if(strlen($input['body']) > 524288, 413);
        $payload = json_decode($input['body'], true, 512, JSON_THROW_ON_ERROR);
        abort_unless(is_array($payload) && isset($payload['keyword'], $payload['model']) && ! array_is_list($payload), 422);
        abort_unless($crm->scriptUrl() !== null, 503, 'Kết nối CRM chưa được cấu hình đầy đủ.');
        try {
            $proof = $crm->requestProof('POST', '/v1/widget/'.$crm->connection('site_id').'/previews',
                $input['body'], strtolower($request->getSchemeAndHttpHost()), $input['id']);
        } catch (\RuntimeException) {
            abort(503, 'Khóa ký CRM chưa sẵn sàng. Chạy php artisan crm-ai:install và đăng ký khóa công khai trong CRM.');
        }
        return response()->json(['proof' => $proof])->header('Cache-Control', 'no-store, private');
    }

    public function update(Request $request, CrmAi $crm, CredentialsStore $store): RedirectResponse|JsonResponse
    {
        abort_unless($crm->canManage(), 403);
        abort_unless($store->ready(), 503, 'Hãy chạy php artisan crm-ai:install trước khi lưu cấu hình AI.');
        $existing = $crm->credentials();
        $rules = $request->boolean('remove_credentials') ? ['remove_credentials' => ['required', 'boolean']] : [
            'provider' => ['prohibited'],
            'base_url' => ['required', 'string', 'max:500', function ($attribute, $value, $fail): void {
                if (! CrmAi::validBaseUrl($value)) {
                    $fail('Base URL phải là địa chỉ HTTPS công khai, không chứa tài khoản, query hoặc fragment.');
                }
            }],
            'api_key' => [empty($existing['api_key']) ? 'required' : 'nullable', 'string', 'max:2048', 'regex:/\A[^\r\n\x00]+\z/'],
            'model' => ['required', 'string', 'max:160', 'regex:/\A[^\x00-\x20\x7f]+\z/u'],
            'remove_credentials' => ['sometimes', 'boolean'],
        ];
        $validator = Validator::make($request->all(), $rules, [], [
            'base_url' => 'Base URL', 'api_key' => 'API key', 'model' => 'model AI',
        ]);
        if ($validator->fails()) {
            if ($request->expectsJson()) {
                return response()->json(['message' => 'Cấu hình AI không hợp lệ.', 'errors' => $validator->errors()], 422);
            }
            return back()->withErrors($validator, 'crmAi')->withInput($request->only(['base_url', 'model', 'remove_credentials']));
        }
        $input = $validator->validated();
        $store->update(function (?array $current) use ($request, $input, $existing): array {
            if ($request->boolean('remove_credentials')) {
                return [];
            }
            $key = trim($input['api_key'] ?? '') ?: ($current['api_key'] ?? ($current === null ? ($existing['api_key'] ?? '') : ''));
            abort_unless($key !== '', 409, 'Cấu hình AI đã thay đổi. Nhập lại API key để lưu.');
            return [
                'provider' => 'openai-compatible', 'base_url' => rtrim(trim($input['base_url']), '/'),
                'api_key' => $key, 'model' => trim($input['model']),
            ];
        });
        $target = config('crm-ai.settings_redirect') ?: $request->headers->get('referer') ?: '/';
        // Only redirect to the current application after saving settings.
        abort_unless((str_starts_with($target, '/') && ! str_starts_with($target, '//') && ! str_contains($target, '\\'))
            || str_starts_with($target, $request->getSchemeAndHttpHost().'/'), 400);
        return redirect()->to($target)->with('success', $request->boolean('remove_credentials')
            ? 'Đã xóa cấu hình key AI riêng.' : 'Đã lưu cấu hình AI. Tải lại trang biên tập để áp dụng.');
    }
}
