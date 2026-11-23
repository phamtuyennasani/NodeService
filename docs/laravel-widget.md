# Widget Laravel dùng cùng luồng viết với CRM

Widget chỉ là giao diện nhúng trong trang biên tập của website khách hàng. Backend Laravel nhận dữ liệu từ widget, xác định website đang được phép thao tác và dùng site token của website đó để tạo job trong CRM. API công khai và chức năng **Viết ngay** của CRM dùng chung `createJob` và worker: nghiên cứu nếu bật, lập dàn ý, viết bản nháp, kiểm tra SEO và chỉnh khi cần. Không triển khai một prompt viết ngắn riêng ở Laravel hoặc trình duyệt.

Luồng dữ liệu:

1. Widget tải model từ route Laravel cùng origin; Laravel gọi `GET /v1/models` bằng site token.
2. Widget gửi các trường viết và `Idempotency-Key` tới Laravel.
3. Laravel lưu quyền sở hữu yêu cầu theo người dùng/website, rồi gọi `POST /v1/article-jobs` với `mode: "preview"`.
4. Worker CRM xử lý job thật. Laravel trả ngay `job_id` và trạng thái; không chờ toàn bộ lượt AI trong một request HTTP.
5. Widget thăm dò route Laravel. Khi job `ready`, Laravel lấy `GET /v1/article-jobs/{job_id}/result` và gắn **nguyên mảng kết quả** vào `result`.
6. Widget hiển thị bài; nút **Chấp nhận** điền các trường vào form. Thao tác lưu hiện có của website lưu bản nháp để biên tập viên duyệt.

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
            ->acceptJson()->asJson()->connectTimeout(5)->timeout(20);
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

Gắn widget theo [mẫu trong README](../README.md#gắn-widget-vào-trang-biên-tập), gồm meta `csrf-token`, `endpoint: '/admin/ai/previews'` và `modelsEndpoint: '/admin/ai/models'`. Các endpoint phải cùng origin với trang biên tập để dùng session/CSRF. Script có thể được phục vụ từ CRM nhưng trình duyệt không gọi API CRM bằng site token.

Chuyển nguyên danh sách model CRM trả về. Giá trị chọn là mã `model` nội bộ, kể cả mã của kết nối OpenAI Compatible riêng; tên hiển thị/provider chỉ là nhãn. Không lấy danh sách model toàn cục hoặc thay mã bằng tên hiển thị/mã upstream, vì khách hàng chỉ được dùng model được cấp và đã cấu hình.

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

Chạy CRM/API và worker từ `.env` hiện tại bằng `npm start`, rồi chạy `npm run dev:widget` trong terminal khác. Mở `http://127.0.0.1:3220`; đặt `WIDGET_SITE_ID=<website_id>` trước lệnh để chọn website CRM cụ thể. Preview dùng cùng hàm tạo job, danh sách model theo khách hàng và worker đang chạy; nó tạo dữ liệu thật, gọi AI thật và dùng hạn mức thực. Không khởi chạy thêm worker riêng cho preview. Server chỉ lắng nghe loopback và dành cho phát triển; khi triển khai, dùng các route Laravel đã xác thực như trên.
