# NodeService

Dịch vụ Node.js nhận yêu cầu viết ngay, lên lịch và viết lại từ các website Laravel. CRM tiếng Việt dùng React, Ant Design và Recharts, mở tại trang gốc. Fastify phục vụ API. MongoDB lưu khách hàng, website, hạn mức, bài viết, lần gọi AI và lượt giao webhook.

## Chạy dịch vụ

Cần Node.js 24 LTS và MongoDB Atlas ho?c MongoDB 7 trở lên.

```sh
npm ci
cp .env.example .env
openssl rand -base64 32
```

Điền chuỗi vừa tạo vào `ENCRYPTION_KEY`, địa chỉ MongoDB vào `MONGODB_URI` và URL CRM vào `APP_ORIGIN`. Tài khoản MongoDB cần quyền tạo bảng trong cơ sở dữ liệu của ứng dụng. Giữ cùng một khóa mã hóa cho các tiến trình dùng chung cơ sở dữ liệu. Đặt `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` hoặc `XAI_API_KEY` cho các gói dùng key dịch vụ. Provider **OpenAI Compatible** được cấu hình trong CRM bằng `Base URL` và API key, nên không ghi key vào `.env`.

```sh
npm run migrate
npm run admin -- quantri
npm run build
npm start
```

Khi phát triển, dùng `npm run dev:watch` để theo dõi mã nguồn, tự chạy lại build và khởi động lại dịch vụ sau mỗi thay đổi.

Mở CRM và đăng nhập. Trong **Nhà cung cấp AI**, chọn OpenAI, Anthropic, xAI hoặc **OpenAI Compatible** để thêm mã model, đặt tên hiển thị và bật các model muốn cung cấp. Với OpenAI Compatible, mở **Cấu hình kết nối**, nhập Base URL của API tương thích OpenAI, ví dụ `https://api.example.com/v1`, và API key. Ở bản cài mới, GPT-4.1 được bật sẵn. Sau đó cấu hình **Khách hàng**, **Website** và **Bảng giá model**. Trong hồ sơ website, dùng **Cấp token** và **Cấp khóa ký** để lấy hai giá trị cho Laravel. Thêm model vào danh sách cho phép khi cấu hình gói dịch vụ. [CRM tại localhost:3210](http://localhost:3210/)

`npm start` chạy CRM, API, worker viết và worker giao bài trong cùng tiến trình. Khi triển khai thành các tiến trình độc lập, khởi chạy các lệnh sau và dùng chung `.env`. Chạy từ thư mục dự án để dịch vụ tìm được bản build và các migration.

```sh
npm start -- api
npm start -- writer
npm start -- webhook
```

Khi vận hành qua HTTPS, đặt `NODE_ENV=production` và `APP_ORIGIN` bằng URL HTTPS thực tế của CRM. `GET /health` kiểm tra kết nối MongoDB. Dùng `WORKER_CONCURRENCY` và `WEBHOOK_CONCURRENCY` để điều chỉnh số tác vụ đồng thời mỗi tiến trình. Các biến `*_CONCURRENCY`, `*_REQUESTS_PER_MINUTE` và `*_TOKENS_PER_MINUTE` trong `.env.example` giới hạn lệnh gọi AI.

Khi thử với Laravel trên máy cục bộ, đặt `ALLOW_LOCAL_WEBHOOKS=true` để gửi webhook đến địa chỉ nội bộ.

## API dành cho Laravel

Laravel gửi header `Authorization: Bearer <site_token>` và `Accept: application/json`. Khi tạo một yêu cầu, sinh một mã duy nhất, lưu cùng yêu cầu và gửi mã đó qua `Idempotency-Key`. Dùng lại mã khi thử gửi cùng yêu cầu sau lỗi mạng.

| Thao tác | Endpoint | Payload hoặc kết quả |
| --- | --- | --- |
| Tạo lịch | `POST /v1/article-jobs` | Gửi trường viết và `scheduled_at` theo ISO 8601 có múi giờ. HTTP 202 trả `job_id` và `version`. |
| Viết ngay | `POST /v1/article-jobs` | Gửi trường viết cùng `mode: "preview"`. HTTP 202 trả `job_id`. |
| Tra cứu yêu cầu | `GET /v1/article-jobs/{job_id}` | Trả trạng thái, thời điểm và lỗi nếu có. Trạng thái `ready` cho biết có thể lấy bài. |
| Lấy bài | `GET /v1/article-jobs/{job_id}/result` | HTTP 200 trả trực tiếp mảng có một đối tượng bài viết. HTTP 202 báo còn chờ. |
| Danh sách bài | `GET /v1/articles` | Lọc bằng `from`, `to` dạng `YYYY-MM-DD`, `q`, `limit` và `cursor`. |
| Danh sách lịch | `GET /v1/schedules` | Lọc bằng `from`, `to`, `status`, `limit` và `cursor`. Mặc định lấy lịch đang chờ. |
| Sửa hoặc dời lịch | `PATCH /v1/schedules/{job_id}` | Gửi các trường cần đổi và header `If-Match: "<version>"`. HTTP 412 yêu cầu tải lại phiên bản mới. |
| Hủy lịch | `DELETE /v1/schedules/{job_id}` | HTTP 204 xác nhận hủy hoặc đã hủy từ trước. |
| Viết lại | `POST /v1/articles/{article_id}/rewrites` | Mã yêu cầu mới, có thể gửi `instructions`, kèm `keyAI` nếu dùng key riêng. |
| Lấy model khả dụng | `GET /v1/models` | Trả `{ "data": [{ "provider": "openai", "model": "gpt-4.1", "display_name": "GPT-4.1" }] }`. Với key riêng, website thấy các model đang bật của nhà cung cấp đang bật. Với key dịch vụ, danh sách còn lọc theo gói khách và key dịch vụ đã cấu hình. |
| Xem hạn mức | `GET /v1/usage` | Trả gói, số lượt dùng, lượt giữ và còn lại theo kỳ. Có thể chọn `date=YYYY-MM-DD`. |

Các danh sách trả `{ data, next_cursor }`. Giữ nguyên bộ lọc và gửi `next_cursor` làm `cursor` để lấy trang kế tiếp. Lịch đang viết hoặc đã kết thúc trả HTTP 409 khi yêu cầu sửa hoặc hủy. Dời lịch giữ nguyên mã công việc và chuyển lượt giữ sang kỳ mới. Nếu kỳ mới hết lượt, HTTP 429 và giờ hẹn cũ vẫn còn hiệu lực.

Khi ngừng cung cấp model hoặc tắt nhà cung cấp, yêu cầu viết mới, viết lại và đổi lịch sang model đó sẽ bị từ chối. Lịch đã nhận vẫn chạy bằng nhà cung cấp đã lưu. Nếu gói còn cho phép, bạn có thể dời lịch đó với cùng model.

Mẫu dữ liệu tạo lịch cho khách dùng gói dịch vụ

```json
{
  "model": "gpt-4.1",
  "keyword": "cách chọn máy lọc nước",
  "tone": "thân thiện",
  "style": "hướng dẫn từng bước",
  "length": 800,
  "scheduled_at": "2027-03-22T09:00:00+07:00"
}
```

Với key riêng, Laravel thêm `keyAI` lấy từ cài đặt đã mã hóa của đúng nhà cung cấp. Các model bắt đầu bằng `claude-` và `grok-` đi qua Anthropic và xAI. Đặt đơn giá theo **USD trên một triệu token** và chọn mốc hiệu lực trong CRM. Khi xAI trả chi phí theo request, dịch vụ ghi nhận chi phí đó. Kiểm tra các dòng chờ đối soát nếu thiếu usage hoặc biểu giá.

```json
[
  {
    "Title": "Cách chọn máy lọc nước",
    "Content": "<p>Xác định nguồn nước và nhu cầu sử dụng.</p>",
    "Slug": "cach-chon-may-loc-nuoc",
    "Desc": "Các bước để chọn máy lọc nước.",
    "Desction": "Hướng dẫn chọn máy lọc nước theo nhu cầu.",
    "Từ khóa": ["máy lọc nước", "chọn máy lọc nước"]
  }
]
```

## Nhận webhook trong Laravel

Khai báo route POST nhận webhook từ Node.js. Đọc nội dung nguyên gốc qua `$request->getContent()` trước khi giải mã JSON. Xác nhận chữ ký bằng khóa của đúng website.

```php
$raw = $request->getContent();
$timestamp = (string) $request->header('X-Timestamp');
abort_unless(ctype_digit($timestamp) && abs(time() - (int) $timestamp) <= 300, 401);

$event = (string) $request->header('X-Article-Event');
$eventId = (string) $request->header('X-Event-Id');
$jobId = (string) $request->header('X-Job-Id');
$requestId = (string) $request->header('X-Client-Request-Id');
$signingMessage = implode("\n", [$timestamp, $event, $eventId, $jobId, $requestId, $raw]);
$expected = 'sha256=' . hash_hmac('sha256', $signingMessage, $webhookSecret);
abort_unless(hash_equals($expected, (string) $request->header('X-Signature')), 401);

$body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
```

Với `article.ready`, body là mảng bài viết. Dùng `X-Client-Request-Id` để tìm yêu cầu Laravel đã ghi khi lên lịch. Trong một giao dịch, khóa bản ghi yêu cầu, kiểm tra `X-Job-Id`, lưu bản nháp và mã bài. Nếu yêu cầu đã có mã bài, xác nhận ngay để webhook trùng giữ nguyên nội dung biên tập viên. Với `article.failed`, body chứa `{ "error": { "code": "...", "message": "..." } }`. Lưu trạng thái lỗi trên lịch. Chỉ trả HTTP 2xx sau khi thay đổi đã được lưu.

## Gắn widget vào trang biên tập

Chèn HTML sau các trường của form. Thay tên miền, selector và model cho phù hợp với website.

```html
<meta name="csrf-token" content="{{ csrf_token() }}">
<div id="ai-tools"></div>
<script src="https://content.example.com/widget/v1/ai-writer.js"></script>
<script>
  const config = {
    mount: '#ai-tools',
    form: '#article-form',
    endpoint: '/admin/ai/previews',
    modelsEndpoint: '/admin/ai/models',
    fields: {
      Title: '[name="title"]',
      Content: '[name="body"]',
      Slug: '[name="slug"]',
      Desc: '[name="summary"]',
      Desction: '[name="seo_description"]',
      'Từ khóa': '[name="keywords"]'
    }
  };
  AIWriter.mount(config);
</script>
```

Với trình soạn thảo có API riêng, cấu hình mục `Content` dưới dạng `{ selector: '[name="body"]', setValue: (element, value) => editor.setData(value) }`. Nút **Chấp nhận** điền dữ liệu vào form. Biên tập viên bấm nút lưu hiện có để ghi bài vào Laravel.

Cài các route sau trên cùng origin với form Laravel và kiểm tra quyền biên tập ở mỗi route.

- `GET /admin/ai/models` dùng site token ở backend Laravel để gọi `GET /v1/models`. Chuyển nguyên phản hồi JSON cho widget. Widget tải danh sách mỗi khi mở form viết mới. Cấu hình cũ dùng mảng `models` vẫn được hỗ trợ.

- `POST /admin/ai/previews` nhận dữ liệu viết, cùng header `Idempotency-Key` và CSRF. Backend gắn mã yêu cầu với người dùng, thêm `mode: "preview"`, gắn key riêng khi cần, rồi dùng site token gọi Node.js. Lưu quyền tra cứu `job_id` theo người dùng và trả lại JSON có `job_id` và `status`.
- `GET /admin/ai/previews/{job_id}` kiểm tra người dùng có quyền tra cứu công việc, rồi chuyển tiếp trạng thái. Khi `status` là `ready`, gọi endpoint `/result` và đính mảng đó vào thuộc tính `result` của JSON trả cho widget. Với job lỗi, chuyển tiếp trường `error_message`.

Cả site token, API key và khóa webhook được dùng từ backend Laravel.

## Kiểm thử

```sh
npm run typecheck
npm run build
npx playwright install chromium --only-shell
npm test
```

Kiểm thử dùng MongoDB tạm, phản hồi AI giả lập và trình duyệt Chromium.




