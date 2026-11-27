# Danh mục liên kết nội bộ từ Laravel

Laravel cung cấp một URL JSON chứa metadata các trang được phép liên kết. Lưu URL này trong cấu hình website; CRM chủ động đọc và cập nhật danh mục trước khi viết bài. CRM không đọc sitemap và không tải HTML của từng trang đích.

## 1. Cấu hình trong CRM

Mở **Website → Chỉnh sửa**, điền **URL danh mục liên kết**, rồi **Lưu website**. Sau đó dùng **Kiểm tra danh mục** trong thông tin website để lấy dữ liệu ngay. Nút này kiểm tra kết nối, định dạng và cập nhật danh mục; không gọi AI và không trừ lượt viết.

URL danh mục phải là HTTPS công khai, thuộc tên miền và port website đã cấu hình; `www` và không `www` được chấp nhận theo quy tắc hiện tại. Không có tài khoản, mật khẩu hoặc fragment `#` trong URL. CRM từ chối địa chỉ mạng nội bộ, DNS trỏ tới địa chỉ riêng và mọi redirect, kể cả cùng tên miền. Hãy cấu hình URL cuối cùng trả JSON trực tiếp.

CRM gửi `GET` với `Accept: application/json` và `Accept-Encoding: identity`. Endpoint Laravel cần truy cập công khai, không yêu cầu đăng nhập; CRM không gửi site token, Authorization, cookie hoặc khóa webhook tới đây. Tránh đặt bí mật trong query vì URL được lưu và hiển thị trong cấu hình website.

Đổi URL danh mục, tên miền hoặc chủ sở hữu website sẽ xóa danh mục và trạng thái kiểm tra trước đó. Sau khi lưu, kiểm tra lại URL mới. Để trống URL thì CRM không chủ động tải danh mục từ Laravel.

## 2. JSON Laravel cần trả

Endpoint trả HTTP 200 với `Content-Type: application/json`, body không nén:

```json
{
  "items": [
    {
      "id": "post:123",
      "url": "https://website.vn/chi-phi-thiet-ke-website",
      "title": "Chi phí thiết kế website",
      "summary": "Các khoản chi phí xây dựng và duy trì website.",
      "categories": ["Thiết kế website"]
    }
  ]
}
```

CRM cũng nhận mảng trực tiếp `[{...}]`. `categories` tùy chọn; bỏ qua tương đương `[]`. `summary` bắt buộc là chuỗi nhưng có thể rỗng; mô tả ngắn giúp chọn trang liên quan hơn.

| Trường | Giới hạn |
| --- | --- |
| Toàn bộ phản hồi | Tối đa 2.000 mục, 5 MiB; thời gian kết nối/đọc tổng cộng tối đa 15 giây |
| `id` | Chuỗi 1–160 ký tự, bắt đầu bằng chữ/số ASCII; tiếp theo cho phép chữ/số, `.`, `_`, `:`, `-` |
| `url` | Tối đa 2.048 ký tự, URL HTTP(S) tuyệt đối thuộc tên miền và port website; không tài khoản hoặc fragment `#` |
| `title` | Văn bản thuần, 1–300 ký tự |
| `summary` | Văn bản thuần, tối đa 1.200 ký tự |
| `categories` | Tối đa 10 chuỗi văn bản thuần, mỗi chuỗi 1–120 ký tự |

Mỗi phản hồi là **toàn bộ danh mục hiện tại**, không phải một lô hoặc một trang dữ liệu. Toàn bộ phản hồi hợp lệ mới thay thế danh mục cũ trong một transaction. Mục vắng trong phản hồi bị gỡ. `{"items":[]}` hoặc `[]` là danh mục rỗng hợp lệ và xóa hết mục của website. Không trả `[]` để che lỗi truy vấn; khi lỗi hãy trả HTTP 5xx để giữ bản trước đó.

Không phân trang. Object chỉ nhận `items`, `next_cursor` tùy chọn nhưng phải `null`, và `total` tùy chọn nhưng phải bằng số phần tử `items`. Trường lạ, `next_cursor` khác null hoặc `total` không khớp khiến cả phản hồi bị từ chối. Nếu kho lớn, Laravel cần chọn tập trang được phép liên kết trong giới hạn trên, thay vì trả trang đầu còn thiếu dữ liệu.

Dùng ID ổn định như `post:123`, `service:456`, tránh va chạm giữa loại nội dung. `id` là ID Laravel, không phải job ID CRM. ID và URL không được trùng trong cùng danh mục. Gửi đúng URL canonical thực; đường dẫn, dấu `/` cuối và query được giữ nguyên. CRM không tự ghép domain với Slug để đoán permalink.

Laravel chịu trách nhiệm chỉ trả trang công khai, đã xuất bản, canonical và phù hợp làm liên kết. Khi unpublish/xóa, loại mục khỏi phản hồi tiếp theo; khi URL hoặc metadata đổi, trả dữ liệu mới cùng ID. CRM chỉ tải endpoint danh mục. Kiểm tra thành công không chứng minh từng URL đích trả HTTP 200, có thể index hoặc có nội dung phù hợp.

## 3. Ví dụ endpoint Laravel

Đoạn dưới chỉ minh họa: thay model, scope, cột và cách lấy URL canonical theo ứng dụng thực. Endpoint trả toàn bộ tập hợp lệ; không dùng `paginate()` hoặc cắt 2.000 mục đầu rồi coi là đầy đủ.

```php
use App\Models\Post;
use Illuminate\Support\Facades\Route;

Route::get('/ai/link-catalog', function () {
    $items = Post::query()
        ->published() // Scope minh họa: chỉ trang đã xuất bản, được phép liên kết.
        ->with('categories')
        ->get()
        ->map(fn (Post $post) => [
            'id' => 'post:' . $post->getKey(),
            'url' => $post->canonical_url, // URL canonical thực của ứng dụng.
            'title' => $post->title,
            'summary' => $post->plain_summary ?? '', // Văn bản thuần, <= 1.200 ký tự.
            'categories' => $post->categories->pluck('name')->values()->all(),
        ])->values();

    return response()->json(['items' => $items]);
});
```

Cấu hình URL HTTPS đầy đủ tương ứng, ví dụ `https://website.vn/api/ai/link-catalog` nếu route API có tiền tố `/api`. Không áp middleware đăng nhập hoặc redirect tới trang đăng nhập. Khi xuất dữ liệu lỗi, trả mã lỗi thay vì danh mục rỗng giả.

CRM kiểm tra danh mục trước bước viết bản nháp. Thành công được dùng lại tối đa năm phút. Lỗi gần nhất cũng được giữ năm phút để tránh gọi lặp liên tục; **Kiểm tra danh mục** bỏ qua thời gian chờ để thử ngay. Mỗi website chỉ có một lượt lấy danh mục đồng thời.

Nếu URL đã cấu hình nhưng lấy/đọc dữ liệu lỗi hoặc có lượt kiểm tra khác đang chạy, CRM tiếp tục viết và không thêm liên kết từ danh mục cho lượt đó; không dùng URL AI tự đoán. Danh mục cũ được giữ khi cập nhật lỗi nhưng không được coi là lần kiểm tra mới thành công. Liên kết an toàn có sẵn trong bài nguồn được xử lý riêng. Danh mục rỗng hợp lệ không thêm liên kết mới.

## 4. Gửi yêu cầu viết và đối chiếu danh mục

Sau khi có danh mục, widget, viết ngay, lịch viết và viết lại tự dùng danh mục của website; không cần gửi cả danh mục trong mỗi request viết.

Nếu đang viết lại/cập nhật một trang đã có URL xuất bản trên Laravel, gửi ID trang đó qua `exclude_content_ids` để tránh tự liên kết:

```http
POST /v1/articles/<crm_article_id>/rewrites
Idempotency-Key: <unique_request_id>
```

```json
{
  "exclude_content_ids": ["post:123"]
}
```

Trường này cũng dùng được khi tạo yêu cầu viết và PATCH lịch. Tối đa 20 ID; bỏ qua khi PATCH giữ nguyên, `[]` xóa danh sách loại trừ. Viết lại kế thừa danh sách bài nguồn nếu không gửi trường này. Với key cá nhân, vẫn gửi provider/api_key theo hợp đồng hiện có. CRM không biết ánh xạ job ID sang permalink Laravel nên không thể thay thế việc Laravel cung cấp ID cần loại trừ bằng cách ghép domain với Slug.

CRM xếp hạng từ khóa, tiêu đề, mô tả và chuyên mục sau bước lập dàn ý, chọn tối đa tám ứng viên. Tìm kiếm hiện là từ vựng có chuẩn hóa dấu tiếng Việt, giới hạn 120 mục vừa cập nhật khớp từ để xếp hạng; chưa phải tìm kiếm ngữ nghĩa toàn kho. AI được phép chèn tối đa ba trang đích khác nhau, mỗi URL một lần, trong lượt viết hiện có; không ép đủ số lượng. Không có trang đủ liên quan thì không chèn mới. Metadata danh mục làm tăng token đầu vào có giới hạn, không phát sinh lượt AI riêng; khi vượt ngân sách thì bỏ danh sách tùy chọn. Key cá nhân vẫn không ghi nhận chi phí.

URL được kiểm tra lại với danh mục trước khi lưu bản nháp và sau sửa SEO; link ngoài danh sách hoặc bị lặp sẽ bỏ thẻ liên kết, giữ chữ. Các liên kết an toàn có sẵn trong bài nguồn được xử lý riêng. Việc kiểm tra là thời điểm gần lúc lưu, không phải khóa URL vĩnh viễn; Laravel vẫn cần duyệt nội dung trước xuất bản. CRM không tải URL để chứng minh HTTP 200, canonical, indexability hay ngữ cảnh phù hợp. Nguồn danh mục phải chỉ gồm các trang công khai, đã xuất bản, canonical và phù hợp làm liên kết.

Website không cấu hình URL và chưa từng đồng bộ giữ hành vi cũ. Với URL danh mục đã cấu hình, hoặc sau lần ghi danh mục đầu tiên kể cả đã xóa hết các mục, URL mới không nằm trong danh mục sẽ bị loại; lỗi đọc danh mục không khiến CRM dùng URL AI đoán. Danh mục không bị xóa theo thiết lập lưu lịch sử job. Kết quả giao bài gồm `Title`, `SeoTitle`, `Content`, `Slug`, `Desc`, `Description`, `Keywords`; `SeoTitle` là tiêu đề SEO riêng của bài mới, link HTML nằm trong `Content`. CRM có tab **Liên kết nội bộ** để xem kết quả kiểm tra; không đưa dữ liệu nghiên cứu/dàn ý vào webhook.

## 5. API cấu hình và kiểm tra dành cho giao diện CRM

Các route này dùng phiên đăng nhập quản trị CRM, không dùng site token:

- `POST /api/crm/websites` và `PATCH /api/crm/websites/:id` nhận `content_catalog_url` tùy chọn; `null` hoặc chuỗi rỗng bỏ URL, PATCH không gửi giữ giá trị cũ.
- `GET /api/crm/websites` trả thêm `content_catalog_url`, `content_catalog_checked_at`, `content_catalog_synced_at`, `content_catalog_error`, `content_catalog_count`.
- `POST /api/crm/websites/:id/content-catalog/check` buộc lấy URL đã lưu. Phản hồi có `status` (`synced` hoặc `busy`), `count`, `synced_at`; `busy` nghĩa là lượt khác đang chạy, không phải lấy mới thành công. Chưa có URL trả HTTP 400; lỗi kết nối/JSON/dữ liệu trả HTTP 422 kèm thông báo an toàn.

`checked_at` là lần kiểm tra thành công hoặc thất bại gần nhất, `synced_at` là lần thay danh mục thành công gần nhất. Xem kèm `content_catalog_error`; thời gian đồng bộ cũ không chứng minh lần kiểm tra mới đã thành công.

## Phụ lục: API đẩy danh mục cũ

API theo site token vẫn dùng được khi website **không có `content_catalog_url`**. Khi đã cấu hình URL, `POST` và `DELETE` dưới đây trả HTTP 409 để tránh hai nguồn cùng sửa. `GET` vẫn cho đọc danh mục hiện có.

Laravel gọi CRM với `Authorization: Bearer <site_token>` và `Accept: application/json`; request ghi JSON thêm `Content-Type: application/json`. Token xác định website/khách hàng, không gửi `site_id` hoặc `customer_id`, không đưa token vào JavaScript trình duyệt.

- `POST /v1/site-content`: body `{"items":[...]}` theo metadata ở trên, 1–100 mục, tối đa 800.000 byte. **Upsert từng lô**, không thay toàn bộ: mục vắng vẫn giữ. Cả lô hợp lệ mới ghi. Trả `{"upserted":1,"synced_at":"..."}`. Không gửi lô rỗng để xóa.
- `GET /v1/site-content?limit=100`: trả `data`, `next_cursor`, `total`, `synced_at`. `limit` mặc định 25, tối đa 100; URL-encode `next_cursor` làm `cursor` tiếp theo. Sắp theo ID; phân trang lúc dữ liệu đổi không phải snapshot.
- `DELETE /v1/site-content/post%3A123`: URL-encode ID, trả HTTP 204 kể cả đã gỡ. Gọi khi unpublish/xóa; không sửa bài đã giao trước đó.

Không gọi AI/trừ lượt viết. Lỗi chính: 400 dữ liệu/URL không hợp lệ, 401 token thiếu/đã bị thu hồi hoặc đổi, 409 đang dùng URL kéo danh mục hoặc URL trùng ID khác, 413 lô quá lớn.
