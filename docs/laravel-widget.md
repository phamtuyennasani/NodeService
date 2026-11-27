# Tích hợp widget viết bài vào Laravel

## Chép file vào website

Bộ [Laravel CRM AI dạng chép file](../integrations/laravel-upload/README.md) có sẵn
service, controller, middleware, config, route, Blade và mẫu AIConfig theo cây thư
mục Laravel 10–13. Tạo ZIP bằng `python scripts/build-laravel-upload.py` tại dự án CRM.

Khai báo rõ `AIConfig.languages` và `AIConfig.fields` theo form. Với nhiều ngôn ngữ, dùng selector như `[name="ten[$lang]"]`, `[name="noidung[$lang]"]`, `[name="mota[$lang]"]`, `[name="slug[$lang]"]`; form cần có các trường tương ứng với `source` và từng ngôn ngữ trong `targets`. Form một ngôn ngữ dùng `targets: []` và có thể dùng selector cố định như `[name="ten"]`. Slug dùng chung đặt `[name="slug"]` để chỉ bản gốc điền vào trường này. Xem [ví dụ fields và ngôn ngữ](../integrations/laravel-upload/README.md#fields-và-ngôn-ngữ).

## Package Composer

Package dùng chung nằm tại [packages/laravel-crm-ai](../packages/laravel-crm-ai/README.md).
Từ bản 1.1.0, xem [cấu hình đa ngôn ngữ](multilingual.md) để khai báo ngôn ngữ gốc, ngôn ngữ đích và mapping theo locale.
Đặt ZIP phát hành trong thư mục `packages` của website, rồi chạy trong thư mục chứa `artisan`.

```bash
composer config repositories.crm-ai artifact ./packages
composer require nodeservice/laravel-crm-ai:^1.3
```

Trong **CRM → Website → Kết nối API**, cấp token rồi bấm **Sao chép .env**. Dán dòng
`CRM_SITE_TOKEN="https://crm.example.com|<website-id>|<site-token>"` vào `.env` của website.
Chạy `php artisan crm-ai:public-key` và đăng ký khóa công khai trong CRM trước lần viết đầu tiên.

Gắn các Gate `crm-ai.write` và `crm-ai.manage` với quyền hiện có của website.
Thêm `<x-crm-ai::settings />` vào trang cấu hình admin, ngoài các form khác. Component
hiển thị ba ô `base_url`, `api_key`, `model` và dùng route của package để lưu key đã mã hóa.
Thêm `<x-crm-ai::writer>` với `form` và `fields` vào form bài viết có `@csrf`.
Xem [hướng dẫn cài đặt và mẫu phân quyền](../packages/laravel-crm-ai/README.md#cài-vào-website-mới).

Package mặc định lưu cấu hình AI mã hóa vào file riêng và có HTTP client tự ký
yêu cầu cho API viết ngay, lên lịch, viết lại và lấy kết quả. Chữ ký từng yêu cầu
có hạn 60 giây. CRM ghi nonce dùng một lần cùng giao dịch tạo job và giữ hạn mức.
Gửi lại cùng `Idempotency-Key` và nội dung trả cùng job.

Với bộ chép file ở phần đầu tài liệu, kết nối đặt trong
`config/crm-ai.php`; mở trang cấu hình bằng `route('crm-ai.settings')`, mặc định
`/crm-ai/settings` hoặc theo prefix đã cấu hình. Dịch vụ nằm trong
`app/CrmAi`, khóa và key mã hóa nằm trong `storage/app/private/crm-ai/`.
AIConfig và ngôn ngữ đặt trong `resources/views/admin/layouts/js.blade.php`;
không cần input ẩn hoặc lưu mã bài, mã job CRM vào dữ liệu bài viết.

Site token và khóa ký ở backend. Theo cấu hình mount trực tiếp, key AI riêng
được đưa vào JavaScript của trang biên tập có xác thực. Widget tải script từ CRM,
gọi backend PHP để cấp chữ ký rồi gửi yêu cầu viết trực tiếp tới CRM. Nút
**Áp dụng** điền bản gốc và các bản dịch vào form để biên tập viên lưu theo quy trình của website. Khi đã áp dụng, lượt viết tiếp theo bắt đầu một bài mới.

## Adapter Laravel hiện hữu

Phần dưới là tài liệu cho website đã tích hợp widget qua các route Laravel cùng origin.

Widget chỉ là giao diện nhúng trong trang biên tập của website khách hàng. Backend Laravel nhận dữ liệu từ widget, xác định website đang được phép thao tác và dùng site token của website đó để tạo job trong CRM. API công khai và chức năng **Viết ngay** của CRM dùng chung `createJob` và worker: nghiên cứu nếu bật, lập dàn ý, viết bản nháp, kiểm tra SEO và chỉnh khi cần. Không triển khai một prompt viết ngắn riêng ở Laravel hoặc trình duyệt.

Luồng dữ liệu:

1. Widget tải model từ route Laravel cùng origin; Laravel gọi `GET /v1/models` bằng site token.
2. Widget gửi các trường viết và `Idempotency-Key` tới Laravel.
3. Laravel lưu quyền sở hữu yêu cầu theo người dùng/website, rồi gọi `POST /v1/article-jobs` với `mode: "preview"`.
4. Worker CRM xử lý job thật. Laravel trả ngay `job_id` và trạng thái; không chờ toàn bộ lượt AI trong một request HTTP.
5. Widget thăm dò route Laravel. Khi job `ready`, Laravel lấy `GET /v1/article-jobs/{job_id}/result` và gắn **nguyên mảng kết quả** vào `result`.
6. Widget hiển thị bản gốc để chọn **Áp dụng** hoặc dịch các ngôn ngữ đích. Sau khi dịch xong chỉ còn nút **Áp dụng** để điền các phiên bản vào form. Thao tác lưu hiện có của website lưu bản nháp để biên tập viên duyệt.

## Cấu hình backend và quyền truy cập

Ví dụ dưới dành cho khách dùng **key dịch vụ**. Site token nằm trong dữ liệu cấu hình backend của website, không xuất vào Blade, JavaScript, query string hoặc log. CRM xác định khách hàng/website từ token; không nhận `customer_id` hoặc `site_id` do trình duyệt chọn. URL CRM lấy từ cấu hình tin cậy, ví dụ `config('services.crm.url')`.

Đặt các route trong `routes/web.php` để dùng session và middleware CSRF mặc định của Laravel. Tất cả route cần đăng nhập và quyền biên tập website hiện tại, kể cả route lấy model và tra cứu job. Middleware `resolve.website`, model `Website`, policy `editContent` và thuộc tính `crm_token` trong ví dụ là điểm nối với ứng dụng Laravel của bạn; thay bằng cơ chế tenant/quyền và kho bí mật đang dùng. Không lấy website hiện tại trực tiếp từ ID không được kiểm tra của request.

```php
use App\Http\Controllers\AiPreviewController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth', 'resolve.website'])->prefix('admin/ai')->group(function () {
    Route::get('/models', [AiPreviewController::class, 'models']);
    Route::post('/previews', [AiPreviewController::class, 'store']);
    Route::get('/previews/{jobId}', [AiPreviewController::class, 'show'])
        ->whereUuid('jobId');
});
```

Lưu ánh xạ yêu cầu bền vững trong database Laravel trước khi gọi CRM. Ví dụ migration sau dùng ID dạng chuỗi để minh họa; đổi kiểu cột/khóa ngoại theo ứng dụng thực:

```php
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

Schema::create('ai_preview_requests', function (Blueprint $table) {
    $table->id();
    $table->string('website_id', 64);
    $table->string('user_id', 64);
    $table->string('idempotency_key', 160);
    $table->char('payload_hash', 64);
    $table->uuid('job_id')->nullable();
    $table->timestamps();
    $table->unique(['website_id', 'idempotency_key']);
    $table->index(['website_id', 'user_id', 'job_id']);
});
```

`website_id` trong bảng này là ID website của Laravel. Một khóa chỉ thuộc một người dùng trên website đó; người dùng khác không được nhận lại `job_id` dù gửi trùng khóa. Nếu CRM đã nhận yêu cầu nhưng kết nối bị ngắt, lần thử lại dùng đúng khóa và payload để nhận lại cùng job. Không tự đổi khóa sau lỗi mạng.

## Controller proxy

Nạp hàm `crmRequestProof` theo [hợp đồng ký PHP](security.md#khóa-ký-máy-chủ-website).
Ví dụ dùng `crm_site_id` và `crm_signing_key_path` từ cấu hình backend tin cậy của website,
cùng `crm_token`. Đăng ký khóa công khai trong CRM trước khi gọi API. Callback ký đúng
byte JSON do Laravel HTTP client tạo cho từng lượt gửi, kể cả GET hoặc retry.

Ví dụ sử dụng Laravel HTTP client và query builder. Cấu hình HTTP timeout chỉ bao phủ thao tác tạo/đọc job; worker AI chạy độc lập. Khi CRM trả lỗi, giữ mã HTTP và thông báo JSON để widget hiển thị, không đổi thành kết quả thành công có bài mẫu.

```php
namespace App\Http\Controllers;

use App\Models\Website;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Http;

class AiPreviewController extends Controller
{
    private function website(Request $request): Website
    {
        $website = $request->attributes->get('current_website');
        abort_unless($website instanceof Website, 404);
        Gate::authorize('editContent', $website);
        return $website;
    }

    private function crm(Website $website)
    {
        return Http::baseUrl(rtrim(config('services.crm.url'), '/'))
            ->withToken($website->crm_token)
            ->acceptJson()->asJson()->connectTimeout(5)->timeout(20)
            ->beforeSending(function (\Illuminate\Http\Client\Request $request) use ($website) {
                $uri = $request->toPsrRequest()->getUri();
                $target = $uri->getPath().($uri->getQuery() !== '' ? '?'.$uri->getQuery() : '');
                $proof = crmRequestProof(
                    $website->crm_site_id, $website->crm_token,
                    file_get_contents($website->crm_signing_key_path),
                    $request->method(), $target, $request->body(), '',
                    $request->header('Idempotency-Key')[0] ?? '',
                    $request->header('If-Match')[0] ?? '',
                );
                return $request->toPsrRequest()->withHeader('X-Site-Proof', $proof);
            });
    }

    private function proxy($response)
    {
        $data = $response->json();
        abort_unless(is_array($data), 502, 'CRM trả dữ liệu không hợp lệ.');
        return response()->json($data, $response->status());
    }

    public function models(Request $request)
    {
        return $this->proxy($this->crm($this->website($request))->get('/v1/models'));
    }

    public function store(Request $request)
    {
        $website = $this->website($request);
        $key = (string) $request->header('Idempotency-Key', '');
        abort_unless(preg_match('/^[\x21-\x7E]{1,160}$/D', $key) === 1, 422,
            'Idempotency-Key không hợp lệ.');
        $input = $request->validate([
            'model' => ['required', 'string', 'max:160'],
            'keyword' => ['required', 'string', 'max:500'],
            'tone' => ['required', 'string', 'max:240'],
            'style' => ['required', 'string', 'max:500'],
            'length' => ['required', 'integer', 'min:600', 'max:2500'],
            'use_research' => ['sometimes', 'boolean'],
            'instructions' => ['sometimes', 'string', 'max:4000'],
        ]);
        // Thứ tự và giá trị chuẩn hóa ổn định khi thử lại cùng yêu cầu.
        $payload = [
            'model' => trim($input['model']),
            'keyword' => trim($input['keyword']),
            'tone' => trim($input['tone']),
            'style' => trim($input['style']),
            'length' => (int) $input['length'],
            'use_research' => (bool) ($input['use_research'] ?? true),
            'mode' => 'preview',
        ];
        if (array_key_exists('instructions', $input)) {
            $payload['instructions'] = trim($input['instructions']);
        }
        $hash = hash('sha256', json_encode($payload, JSON_THROW_ON_ERROR));
        $scope = ['website_id' => (string) $website->getKey(), 'idempotency_key' => $key];
        $userId = (string) $request->user()->getAuthIdentifier();

        // Ghi quyền sở hữu trước: an toàn cả khi CRM nhận job nhưng HTTP bị ngắt.
        $row = DB::transaction(function () use ($scope, $userId, $hash) {
            DB::table('ai_preview_requests')->insertOrIgnore([
                ...$scope, 'user_id' => $userId, 'payload_hash' => $hash,
                'created_at' => now(), 'updated_at' => now(),
            ]);
            $row = DB::table('ai_preview_requests')->where($scope)->lockForUpdate()->first();
            abort_unless($row && $row->user_id === $userId, 404);
            abort_unless(hash_equals($row->payload_hash, $hash), 409,
                'Mã yêu cầu đã được dùng với nội dung khác.');
            return $row;
        });

        $response = $this->crm($website)
            ->withHeaders(['Idempotency-Key' => $key])
            ->post('/v1/article-jobs', $payload);
        if (!$response->successful()) return $this->proxy($response);
        $data = $response->json();
        abort_unless(is_array($data) && is_string($data['job_id'] ?? null)
            && is_string($data['status'] ?? null), 502, 'CRM chưa trả job hợp lệ.');
        DB::table('ai_preview_requests')->where('id', $row->id)->update([
            'job_id' => $data['job_id'], 'updated_at' => now(),
        ]);
        return response()->json($data, $response->status());
    }

    public function show(Request $request, string $jobId)
    {
        $website = $this->website($request);
        $owned = DB::table('ai_preview_requests')->where([
            'website_id' => (string) $website->getKey(),
            'user_id' => (string) $request->user()->getAuthIdentifier(),
            'job_id' => $jobId,
        ])->exists();
        abort_unless($owned, 404);
        $crm = $this->crm($website);
        $status = $crm->get('/v1/article-jobs/' . rawurlencode($jobId));
        if (!$status->successful()) return $this->proxy($status);
        $data = $status->json();
        abort_unless(is_array($data) && is_string($data['status'] ?? null), 502);
        if ($data['status'] === 'ready') {
            $result = $crm->get('/v1/article-jobs/' . rawurlencode($jobId) . '/result');
            if ($result->status() === 202) {
                $data['status'] = $result->json('status') ?? 'writing';
            } elseif ($result->successful()) {
                $articles = $result->json();
                abort_unless(is_array($articles) && array_is_list($articles), 502);
                $data['result'] = $articles; // Giữ nguyên Content và mọi trường bài viết.
            } else {
                return $this->proxy($result);
            }
        }
        return response()->json($data);
    }
}
```

Thêm giới hạn tần suất theo người dùng/website phù hợp với ứng dụng. Xử lý `ConnectionException`/timeout thành JSON HTTP 502 hoặc 504 trong exception handler; giữ ánh xạ để thử lại, không tạo khóa mới. Nếu cho phép `exclude_content_ids`, xác thực và chuyển tiếp danh sách theo [hợp đồng danh mục nội bộ](laravel-internal-links.md). Ví dụ trên không nhận provider hoặc API key từ trình duyệt vì đang dùng key dịch vụ.

## Cấu hình widget và kết quả

Adapter dùng meta `csrf-token` và thêm `endpoint: '/admin/ai/previews'`, `modelsEndpoint: '/admin/ai/models'` trong `AIWriter.mount`. Hai URL dùng cùng origin với trang biên tập để xác thực bằng session và CSRF. Tải JavaScript từ `/widget/v1/ai-writer.js` của CRM.

Giao diện widget nằm trong Shadow DOM và có lớp reset riêng cho font, căn chữ, hướng viết, màu giao diện và biến CSS. Cỡ chữ của modal không phụ thuộc `font-size` trên `html` của website; quy tắc toàn cục như `button`, `input`, `dialog` hay `.primary`, kể cả `!important`, không ghi đè các phần tử bên trong. Bản xem trước quy đổi đơn vị `rem` trong CSS bài viết theo mốc 16px; HTML gốc đã lọc vẫn được giữ khi chấp nhận điền vào form. Không chèn stylesheet hay sửa `html`/`body` của trang khách hàng. Đây là cô lập CSS, không ngăn JavaScript trên trang chủ động truy cập widget hoặc việc website ẩn vùng gắn widget.

Chuyển nguyên danh sách model CRM trả về. Giá trị chọn là mã `model` nội bộ, kể cả mã của kết nối OpenAI Compatible riêng; tên hiển thị/provider chỉ là nhãn. Không lấy danh sách model toàn cục hoặc thay mã bằng tên hiển thị/mã upstream, vì khách hàng chỉ được dùng model được cấp và đã cấu hình.

API `/v1/models` trả thêm `key_mode: "own" | "service"` lấy từ khách hàng sở hữu site token. Laravel cần giữ trường này; không gán cứng loại key trong Blade. Widget kiểm tra lại mỗi lần mở: `service` hiện select model; `own` ẩn toàn bộ nhãn và ô Model. Trong lúc tải hoặc khi tải lỗi, nút viết bị khóa để không dùng cấu hình cũ.

Ví dụ controller ở trên dành cho key dịch vụ. Với key riêng, tạo mục **Cấu hình AI** trong quản trị Laravel gồm **Base URL, API key, Model** và lưu mã hóa trong database. Người dùng không chọn provider: backend luôn gắn `provider: "openai-compatible"` và gửi `base_url`, `api_key`, `model` sang CRM. Base URL tối đa 500 ký tự, dùng HTTPS công khai, không chứa tài khoản, query hoặc fragment, ví dụ `https://api.example.com/v1` (không thêm `/chat/completions`). CRM dùng đúng endpoint và mã model website cung cấp, không yêu cầu tạo provider/model trong danh mục CRM. API key tối đa 2.048 ký tự; model tối đa 160 ký tự, không chứa khoảng trắng hoặc ký tự điều khiển, hỗ trợ mã như `team/model:free@latest`.

Route models bổ sung `own_key_configured` (boolean) và `model` (mã cố định hoặc null), tuyệt đối không trả API key hoặc Base URL. Khi POST, kiểm tra lại `key_mode` từ CRM; nếu `own`, gắn bộ thông tin đã lưu và ghi đè model do client gửi. Không cho browser ghi đè `base_url`, provider hoặc key. Nếu thiếu cấu hình thì trả lỗi trước khi tạo job; nếu `service`, không gửi key hoặc Base URL riêng. Widget sẽ hiện thông báo cấu hình thiếu và khóa nút viết. Khi sửa lịch qua API, bỏ qua connection để giữ nguyên; nếu đổi Base URL phải gửi lại API key. CRM mã hóa endpoint và key cùng nhau trong job, xóa khi job kết thúc hoặc bị hủy; kết nối HTTPS kiểm tra DNS công khai, ghim IP đã kiểm tra và không theo redirect.

Widget có ô **Hướng dẫn thêm** như CRM, tối đa 4.000 ký tự sau khi bỏ khoảng trắng đầu/cuối. Đặt `defaults.instructions` nếu website có hướng dẫn mặc định; người biên tập có thể sửa trước khi gửi. Ví dụ: `defaults: { length: 1500, instructions: 'Phân tích chi phí và thêm bảng so sánh trước phần câu hỏi thường gặp.' }`. Giá trị không trống được chuyển tiếp nguyên nội dung qua `instructions` của CRM; ô để trống không gửi trường này.

Giữ các trường `writing_stage`, `keyword`, `length`, `seo_report` và `seo_repair_status` từ status API khi ghép `result`. Khi `status` là `writing`, widget dùng `writing_stage` để hiển thị đúng bước CRM đang chạy: `research` (nghiên cứu), `outline` (lập dàn ý), `draft` (viết nội dung), `seo_check` (kiểm tra SEO), `seo_repair` (chỉnh sửa SEO). Không tự suy đoán bước theo thời gian chờ. Adapter cũ thiếu trường này chỉ hiển thị thông báo CRM đang xử lý bài viết. Widget hiển thị chính báo cáo cuối đã lưu trong CRM, gồm điểm và từng tiêu chí còn cần xem lại; không tự nâng điểm hoặc coi `ready` là đã đạt mọi tiêu chí. Adapter cũ chưa trả báo cáo sẽ chỉ hiển thị bài. Với form có trường từ khóa chính riêng, thêm `FocusKeyword: '[name="focus_keyword"]'` vào `fields`; giá trị lấy từ keyword gốc của yêu cầu. `Keywords` tiếp tục là danh sách từ khóa liên quan trong bài.

Khi lưu bản nháp ở Laravel, lưu cả `keyword` và `length` gốc của yêu cầu hoặc các giá trị tương ứng từ status API. Khi người dùng biên tập và cần chấm lại trên form, truyền `keyword` gốc cùng `targetWords: length` vào `window.SeoScore.evaluate(...)` để dùng cùng ngân sách độ dài với báo cáo CRM. Không lấy số từ hiện tại của bài làm `targetWords`; nếu bỏ trường này, bộ chấm cũ dùng khoảng chung 600–2.500 từ. Xem [hợp đồng chấm SEO](laravel-seo.md).

Kết quả route thăm dò khi hoàn tất có dạng:

```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "ready",
  "result": [
    {
      "Title": "Tiêu đề bài viết",
      "Content": "<h2>Một mục trong bài</h2><p>Toàn bộ nội dung HTML do CRM trả về.</p>",
      "Slug": "tieu-de-bai-viet",
      "Desc": "Mô tả ngắn.",
      "Description": "Mô tả SEO.",
      "Keywords": ["từ khóa chính", "từ khóa liên quan"]
    }
  ]
}
```

JSON trên chỉ minh họa **cấu trúc phản hồi**, không phải nội dung để dùng làm kết quả thật. Luôn lấy bài đã lưu của job từ `/result`; không dựng lại từ `keyword`, `Desc` hoặc metadata danh sách bài. Không dùng `substr`, tóm tắt, giới hạn số đoạn hoặc giới hạn chữ cho `Content` trong proxy hay editor. Chiều cao vùng xem trước và thanh cuộn chỉ ảnh hưởng hiển thị; toàn bộ bài vẫn phải được điền vào form. Widget làm sạch HTML được phép trước khi hiển thị và áp dụng.

Để so sánh với CRM, dùng cùng website/khách hàng, mã model, từ khóa, giọng văn, phong cách, độ dài, hướng dẫn và `use_research`. Mỗi lượt AI có thể viết khác câu chữ; điều cần giữ giống nhau là cấu hình và quy trình xử lý đầy đủ. Kiểm tra job tương ứng trong **Yêu cầu viết** của CRM và đối chiếu nội dung `/result` với dữ liệu điền vào editor. Nếu job lỗi, hiển thị `error_message`; nếu còn `queued`, `writing` hoặc `retrying`, tiếp tục thăm dò thay vì trả bài mẫu.

## Chạy thử cục bộ

Chạy CRM/API và worker từ `.env` hiện tại bằng `npm start`, rồi chạy `npm run dev:widget` trong terminal khác. Mở `http://127.0.0.1:3220` và đặt `WIDGET_SITE_ID` theo ID của một website dùng hạn mức dịch vụ. Trang này dùng adapter cục bộ để tạo job thật, gọi AI và sử dụng hạn mức của website. CRM xử lý job bằng worker đang chạy. Để kiểm tra chữ ký của trang biên tập hoặc website chỉ dùng key riêng, làm theo [các bước kiểm tra trên website](#kiểm-tra-tích-hợp-trên-website).

## Kiểm tra tích hợp trên website

1. Chạy CRM/API và worker. Đăng nhập trang quản trị của website đã tích hợp, kiểm tra kết nối trong `config/crm-ai.php` và mapping `languages`, `fields` theo form thực tế.
2. Mở `route('crm-ai.settings')` theo prefix của website, tạo khóa máy chủ và đăng ký khóa công khai trong **CRM → Website → Kết nối API → Đăng ký khóa ký**. Nếu dùng key AI riêng, cấu hình Base URL, API key và Model tại trang này.
3. Mở form biên tập có nút **Viết bài AI**, chọn model và gửi yêu cầu. Kiểm tra job tương ứng trong **Yêu cầu viết** của CRM; đây là luồng tạo bài thật qua worker.
4. Khi có bản xem trước, chọn **Áp dụng** hoặc dịch sang các ngôn ngữ đích đã cấu hình. Kiểm tra tiêu đề, nội dung, slug và các trường SEO được điền đúng selector của từng ngôn ngữ; lưu bài bằng chức năng hiện có của website.
