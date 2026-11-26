# PHP CRM AI

Package `nodeservice/php-crm-ai` phiên bản 1.2.3 dùng cho PHP thuần và các hệ thống PHP có bootstrap riêng. Yêu cầu PHP 8.2+, cURL, OpenSSL và JSON. Runtime dùng các extension PHP sẵn có.

## Cài bằng Composer

Đặt `nodeservice-php-crm-ai-1.2.3.zip` vào thư mục `packages` của website, rồi chạy tại thư mục dự án.

```bash
composer config repositories.crm-ai artifact ./packages
composer require nodeservice/php-crm-ai:^1.0
```

Hoặc giải nén ZIP vào một thư mục riêng và nạp file `autoload.php` trong gói. Cách giải nén dùng trực tiếp được với các website có quy trình quản lý thư viện riêng.

## Cấu hình website và khóa ký

Chép `config.example.json` thành `private/crm-ai.json` của website và điền URL CRM, Website ID, token, origin trang biên tập. Thư mục `private` phải nằm ngoài document root và Git. Đặt quyền đọc file theo tài khoản chạy PHP.

```json
{
  "url": "https://crm.example.com",
  "site_id": "SITE_UUID_FROM_CRM",
  "token": "SITE_TOKEN_FROM_CRM",
  "editor_origin": "https://website.example.com",
  "allow_localhost": false
}
```

Chạy lệnh cài bằng Composer.

```bash
php vendor/bin/crm-ai install --config=private/crm-ai.json
```

Với bản giải nén, gọi `php path/to/package/bin/crm-ai install --config=private/crm-ai.json`.
Installer tạo khóa ký P-256, khóa mã hóa cấu hình AI và in khóa công khai. Đăng ký khóa này tại **CRM → Website → Kết nối API → Đăng ký khóa ký**. Lệnh có thể chạy lại và giữ khóa hiện có. Lấy lại khóa công khai bằng lệnh `public-key` cùng tham số `--config`.

Nếu file cấu hình chưa tồn tại, installer có thể đọc các biến môi trường server `CRM_API_URL`, `CRM_SITE_ID`, `CRM_SITE_TOKEN`, `CRM_EDITOR_ORIGIN` và `CRM_ALLOW_LOCALHOST=true`. Token được đọc từ cấu hình riêng hoặc môi trường. Lệnh cài in khóa công khai để đăng ký.

`signing_key_path` là tùy chọn. Khi bỏ qua, client dùng `crm-signing.pem` cạnh file cấu hình. Đường dẫn tương đối được tính từ thư mục chứa file cấu hình. HTTPS dùng cho website và CRM. Khi thử local, đặt `allow_localhost: true` để dùng HTTP với `localhost`, `127.0.0.1` hoặc `::1`.

## Nhúng widget

Nạp autoloader và bootstrap đăng nhập của website trước khi dựng widget. Origin lấy từ cấu hình backend cố định. Callback phải kiểm tra cả đăng nhập và quyền biên tập của người dùng hiện tại.

```php
use NodeService\CrmAiPhp\Client;
use NodeService\CrmAiPhp\Widget;

$client = Client::fromFile(__DIR__.'/private/crm-ai.json');
$widget = new Widget($client, 'https://website.example.com', function (): bool {
    return isset($_SESSION['user_id']) && ($_SESSION['can_edit_articles'] ?? false) === true;
});
$csrf = Widget::csrfToken($_SESSION);
```

Website cần mở session trước đoạn trên. Đặt header `Cache-Control: no-store, private` trước khi xuất trang biên tập. Gắn widget vào form có ID và các trường đã map.

```php
echo $widget->render([
    'authorize_url' => '/admin/crm-authorize.php',
    'form' => '#article-form',
    'fields' => [
        'Title' => '[name=title]',
        'Content' => '[name=body]',
        'Slug' => '[name=slug]',
        'Desc' => '[name=summary]',
        'Description' => '[name=seo_description]',
        'Keywords' => '[name=keywords]',
    ],
], $csrf);
```

Widget tải script từ CRM, gửi yêu cầu cấp chữ ký tới `authorize_url` cùng origin, rồi gửi yêu cầu viết trực tiếp đến CRM. CSRF token nằm trong thuộc tính script. Sau khi có bản gốc, chọn **Áp dụng** hoặc **Dịch sang các ngôn ngữ khác**. Dịch lấy bản gốc trong popup để tạo toàn bộ ngôn ngữ đích; sau đó chỉ còn nút **Áp dụng** để điền các phiên bản vào form. Khi đã áp dụng, lần mở widget tiếp theo bắt đầu một lượt viết mới. Với CSP, truyền `nonce` trong options theo chính sách ứng dụng và cho phép origin CRM trong `script-src`, `connect-src`.

Để tự CSS nút Viết bài AI, thêm `'customStyle' => true` vào options của `$widget->render()`. Nút xuất hiện trong HTML website với class `.crm-ai-launch`, có thể CSS trực tiếp từ stylesheet website. Popup vẫn giữ CSS của widget. Khi bỏ tùy chọn này hoặc dùng `false`, nút giữ giao diện mặc định.

Thêm `'customClass' => 'btn btn-primary'` vào cùng options để gắn thêm class vào nút. Có thể dùng nhiều class cách nhau bằng khoảng trắng; class `.crm-ai-launch` được giữ lại. Với `customStyle: true`, CSS của website áp dụng trực tiếp lên các class đó. Mặc định là chuỗi rỗng.

## Endpoint cấp chữ ký

Nạp cùng bootstrap đăng nhập và tạo `$widget`, `$csrf` như trang biên tập. Endpoint chỉ nhận POST, đọc tối đa 1.048.577 byte từ `php://input`, rồi gọi phương thức sau.

```php
$result = $widget->authorize(
    $rawBody,
    $csrf,
    $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''
);
echo json_encode($result, JSON_THROW_ON_ERROR);
```

Phương thức kiểm tra callback phân quyền, CSRF, cấu trúc `{body, id}`, rồi ký đúng body, mã yêu cầu và endpoint preview của website. `AuthorizationException` chứa `status` cùng thông báo công khai để trả JSON. Lỗi cấu hình/khóa cần trả JSON 503 với thông báo chung.

Các file hoàn chỉnh nằm trong [examples/bootstrap.php](examples/bootstrap.php), [examples/editor.php](examples/editor.php), [examples/authorize.php](examples/authorize.php). Điều chỉnh autoloader, đường dẫn cấu hình, URL endpoint và callback theo website. Mẫu mặc định kiểm tra `user_id` và `can_edit_articles` trong session. Có thể đặt `CRM_AUTOLOAD_PATH`, `CRM_CONFIG_PATH` khi chạy mẫu từ vị trí khác.

CRM kiểm tra chữ ký từng yêu cầu có hạn 60 giây, nonce dùng một lần và giữ hạn mức trong cùng transaction tạo job. Giữ cùng mã yêu cầu khi thử lại sau lỗi mạng. Một yêu cầu đã được nhận trả lại cùng job. Site token và khóa ký được giữ ở backend.

## Dùng API từ PHP

```php
$models = $client->request('GET', '/v1/models');

$response = $client->request('POST', '/v1/article-jobs', [
    'mode' => 'preview',
    'model' => $model,
    'keyword' => $keyword,
    'tone' => 'Chuyên nghiệp',
    'style' => 'Hướng dẫn',
    'length' => 1000,
], ['Idempotency-Key' => $requestId]);

if ($response->successful()) {
    $job = $response->json();
}
```

Client tự gửi token và ký đúng byte JSON, method, nguyên path/query và các header liên quan. Các header được truyền vào gồm `Idempotency-Key`, `If-Match`, `Origin`. Với dời lịch, gửi `If-Match` theo version hiện tại. Các thao tác tạo lịch, liệt kê bài, viết lại, lấy trạng thái/kết quả dùng cùng phương thức `request` và các endpoint `/v1` của CRM.

`Response` cung cấp `status`, `body`, `successful()` và `json()`. HTTP 4xx/5xx được trả trong Response để ứng dụng xử lý. Lỗi kết nối, chuyển hướng hoặc phản hồi vượt 8 MiB ném `RuntimeException`. Client xác minh TLS, sử dụng timeout kết nối 5 giây và timeout toàn request 20 giây. Việc thử lại do ứng dụng kiểm soát để giữ đúng `Idempotency-Key`.

## Lưu key AI riêng

```php
use NodeService\CrmAiPhp\CredentialsStore;

$store = new CredentialsStore(
    __DIR__.'/private/crm-ai-credentials.enc',
    __DIR__.'/private/crm-ai-credentials.key'
);
$store->save(['base_url' => $baseUrl, 'api_key' => $apiKey, 'model' => $model]);
```

Installer tạo khóa mã hóa ở cạnh file cấu hình theo các tên trên. Khi dùng đường dẫn riêng, gọi `install()` của store trong bước cài đặt. Lưu từ trang quản trị cần quyền quản lý cấu hình và CSRF của website. Key để trống khi lưu sẽ giữ key hiện tại. Gọi `save([])` để xóa cấu hình riêng. Truyền `$store->read()` làm tham số thứ ba cho `Widget::render()` để sử dụng trong widget.

Kho dữ liệu dùng AES-256-GCM, khóa 32 byte riêng và ghi file nguyên tử dưới khóa `flock`. Mất khóa mã hóa cần khôi phục khóa cũ hoặc nhập lại cấu hình bằng khóa mới theo quy trình của website. Dữ liệu lỗi xác thực mã hóa sẽ báo lỗi khi đọc.

Theo luồng widget trực tiếp, key AI riêng được đưa vào JavaScript của trang biên tập đã xác thực. Sao lưu token, khóa ký và khóa mã hóa trong kho bí mật của website khi chuyển máy. API key riêng dùng chuẩn OpenAI Compatible. CRM kiểm tra địa chỉ và DNS của endpoint trước khi tạo/xử lý job.

## Phát triển

```bash
composer install
composer test
composer archive --format=zip --dir=../../dist/packages
```

ZIP phát hành chứa mã nguồn, autoloader, CLI và trang mẫu. Thư mục `vendor`, dữ liệu riêng và kiểm thử được loại khỏi bản phát hành. Tăng version khi phát hành bản nâng cấp để Composer nhận đúng phiên bản và checksum.

## Đa ngôn ngữ

Khai báo `languages: {source, targets}` trong AIConfig và mapping theo locale. Viết bản gốc, xem trước rồi chọn áp dụng ngay hoặc dịch toàn bộ ngôn ngữ đích trước khi áp dụng. Mỗi bản dùng một job/lượt riêng; thử lại phần dịch lỗi giữ các bản đã hoàn tất. [Hướng dẫn và ví dụ Laravel/PHP đầy đủ](docs/multilingual.md).

### Selector ngôn ngữ gọn

Từ 1.1.1, khai báo một lần `fields: { Title: '[name="name[$lang]"]', Content: '[name="content[$lang]"]' }`. Widget tự thay `$lang` theo ngôn ngữ đang xử lý. Selector cố định không chứa `$lang` chỉ dùng cho bản gốc trong mapping tự động, phù hợp slug/SEO dùng chung. `fieldsByLocale` vẫn có thể thay mapping của một locale có tên trường khác quy luật. Trong PHP dùng chuỗi nháy đơn để giữ `$lang` nguyên dạng. Xem [ví dụ đầy đủ](docs/multilingual.md).

## Liên kết bài gốc và bản dịch

Widget tự tạo mã cho mỗi lượt viết để CRM gom bản gốc và các bản dịch của lượt đó. Website không cần lưu hoặc truyền mã bài, mã job CRM. Sau khi áp dụng, lượt viết mới dùng nhóm mới.

CRM có **Yêu cầu viết → Nhóm theo bài gốc**, hiển thị bản gốc và các phiên bản ngôn ngữ cùng nhau dù yêu cầu từ nhiều website đến xen kẽ. [Hướng dẫn quản lý nhóm](docs/article-groups.md).
