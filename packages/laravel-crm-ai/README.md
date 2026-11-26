# Laravel CRM AI

Package `nodeservice/laravel-crm-ai` cung cấp widget viết bài, cấu hình key AI riêng và HTTP client có chữ ký máy chủ cho NodeService CRM. Hỗ trợ PHP 8.2+ với Laravel 10–13. Laravel 13 dùng PHP 8.3+.

## Cài vào website mới

Đặt file `nodeservice-laravel-crm-ai-1.3.0.zip` vào thư mục `packages` của website, rồi chạy tại thư mục chứa `artisan`.

```bash
composer config repositories.crm-ai artifact ./packages
composer require nodeservice/laravel-crm-ai:^1.3
```

### Kết nối bằng một dòng `.env`

Trong **CRM → Website → Kết nối API**, cấp token và bấm **Sao chép .env**. Dán vào file `.env` trên máy chủ Laravel. Dòng này mang URL CRM, ID website và token theo thứ tự sau.

```dotenv
CRM_SITE_TOKEN="https://crm.example.com|<website-id>|<site-token>"
```

Package tự đọc dòng này và đăng ký provider, route và kho cấu hình mặc định. Nếu ứng dụng dùng cache cấu hình, chạy `php artisan config:cache` sau khi đổi token.

Trước lần viết đầu tiên, chạy `php artisan crm-ai:public-key` và dán khóa được in ra tại **CRM → Website → Kết nối API → Đăng ký khóa ký**. Lệnh tạo khóa máy chủ nếu chưa có. Khi đổi token cho cùng website, dùng lại khóa đã đăng ký.

## Phân quyền

Package mặc định kiểm tra hai Gate `crm-ai.write` và `crm-ai.manage`. Định nghĩa chúng trong `AppServiceProvider::boot()` theo quyền biên tập và quản trị hiện có. Ví dụ với ứng dụng đã có hai quyền tương ứng:

```php
\Illuminate\Support\Facades\Gate::define('crm-ai.write', fn ($user) => $user->can('articles.update'));
\Illuminate\Support\Facades\Gate::define('crm-ai.manage', fn ($user) => $user->can('settings.update'));
```

Nếu muốn trỏ trực tiếp tới tên quyền hiện có, chạy `php artisan vendor:publish --tag=crm-ai-config` rồi sửa `abilities` trong `config/crm-ai.php`.

```php
'abilities' => [
    'write' => ['articles.create', 'articles.update'],
    'manage' => ['settings.update'],
],
```

Route mặc định dùng middleware `web`, `auth` và CSRF. Có thể thêm guard hoặc middleware riêng trong `routes.middleware`.

## Gắn vào form bài viết

Form hiện có cần ID và `@csrf`. Thêm component bên trong form hoặc cạnh nút lưu.

```blade
<x-crm-ai::writer
    form="#article-form"
    :fields="[
        'Title' => '[name=title]',
        'Content' => '[name=body]',
        'Slug' => '[name=slug]',
        'Desc' => '[name=summary]',
        'Description' => '[name=seo_description]',
        'Keywords' => '[name=keywords]',
    ]"
/>
```

Widget điền bài vào các trường đã map. Biên tập viên bấm lưu bằng chức năng hiện có của website. Script tải trực tiếp từ CRM, nên trình duyệt cần truy cập được URL CRM. CSP của website nếu có cần cho phép origin CRM trong `script-src` và `connect-src`, cùng nonce cho script khởi tạo theo chính sách ứng dụng.

Với CKEditor, TinyMCE hoặc form có quy tắc riêng, nạp `<x-crm-ai::script />` rồi gọi `AIWriter.mount()` bằng mapping JavaScript của website. Lấy cấu hình key riêng qua `app(\NodeService\CrmAi\CrmAi::class)->mountCredentials()`. `Content` có thể nhận `{ selector: '[name=body]', setValue: (element, value) => editor.setData(value) }`. BaseCodeAW giữ mapping CKEditor và các trường đa ngôn ngữ trong view adapter của ứng dụng.

## Cấu hình AI riêng

Thêm component sau ngoài các form khác trên trang cấu hình đã đăng nhập.

```blade
<x-crm-ai::settings />
```

Component có ba ô. `base_url` là địa chỉ HTTPS của nhà cung cấp OpenAI Compatible, thường kết thúc bằng `/v1`. `api_key` là key của nhà cung cấp và `model` là mã model. Để trống API key khi sửa để giữ key đang lưu. Tài khoản có quyền `crm-ai.manage` (hoặc quyền đã cấu hình trong `abilities.manage`) được thấy và lưu form.

Package mã hóa cấu hình bằng Laravel `APP_KEY` vào `storage/app/private/crm-ai-credentials.enc`. Form dùng kho file ngay sau khi cài Composer. Nếu tự dựng giao diện admin, dùng ba ô cùng tên, gửi `PUT` đến `route('crm-ai.settings.update')` với `@csrf` và `@method('PUT')`. Dùng `app(\NodeService\CrmAi\CrmAi::class)->form()` để lấy URL, model và trạng thái có key. Trường `api_key` luôn để trống khi render.

Với website đã có cột cấu hình mã hóa, có thể cấu hình `credentials.model`, `credentials.id` và `credentials.attribute`. Lệnh `crm-ai:install` chỉ thêm cột khi chưa tồn tại. `credentials.id` mặc định `1`, giá trị `null` dùng bản ghi đầu tiên để tương thích module BaseCodeAW cũ. Provider tự bổ sung cast mã hóa và ẩn thuộc tính này khi serialize model. Có thể bind interface `NodeService\CrmAi\Contracts\CredentialsStore` để dùng kho cấu hình của ứng dụng.

Theo luồng widget gọi trực tiếp CRM, key AI riêng được đưa vào JavaScript trên trang biên tập có xác thực. Site token và khóa ký máy chủ nằm ở backend. Các trang render component được đặt `no-store`, debug collector được tắt trước khi lấy thông tin nhạy cảm.

## Dùng API từ Laravel

```php
use NodeService\CrmAi\CrmAi;

$response = app(CrmAi::class)->http()
    ->withHeaders(['Idempotency-Key' => $requestId])
    ->post('/v1/article-jobs', [
        'mode' => 'preview',
        'model' => $model,
        'keyword' => $keyword,
        'tone' => 'Chuyên nghiệp',
        'style' => 'Hướng dẫn',
        'length' => 1000,
    ]);
```

HTTP client tự gửi Bearer token và ký đúng method, path/query, body, `Idempotency-Key`, `If-Match` cho mỗi lượt gửi. Giữ nguyên mã yêu cầu và nội dung khi thử lại sau lỗi mạng. CRM trả cùng job cho yêu cầu đã nhận, giữ một lượt. Với việc dời lịch, truyền header `If-Match` theo version hiện tại.

## Cấu hình server và cache

Các website dùng token gốc vẫn có thể đặt `CRM_WIDGET_ENABLED`, `CRM_API_URL`, `CRM_SITE_ID`, `CRM_SITE_TOKEN` hoặc dùng file riêng do `crm-ai:install --configure` tạo. Với dòng kết nối 1.3, URL và ID lấy từ chính dòng đó. `CRM_WIDGET_ENABLED=false` vẫn có thể dùng để tắt widget. Khóa ký mặc định nằm tại `storage/app/private/crm-signing.pem`.

Sau khi sửa cấu hình hoặc nâng cấp package, làm mới config, route và view cache theo quy trình triển khai Laravel. Khi thay khóa ký, đăng ký lại khóa công khai trong CRM. Việc đăng ký hoặc đổi khóa yêu cầu phiên quản trị CRM và xác nhận mật khẩu.

## Phát triển package

```bash
composer install
composer test
composer archive --format=zip --dir=../../dist/packages
```

Thư mục `vendor` và các file kiểm thử được loại khỏi ZIP. Đổi version trước khi phân phối bản nâng cấp để Composer kiểm tra đúng phiên bản và checksum.

## Đa ngôn ngữ

Khai báo `languages: {source, targets}` trong AIConfig và mapping theo locale. Sau khi có bản gốc trong popup, chọn **Áp dụng** hoặc dịch toàn bộ ngôn ngữ đích rồi áp dụng một lần. Sau khi áp dụng, mở widget sẽ bắt đầu một lượt viết mới. Mỗi bản dùng một job/lượt riêng. [Hướng dẫn và ví dụ Laravel/PHP đầy đủ](docs/multilingual.md).

### Selector ngôn ngữ gọn

Từ 1.1.1, khai báo một lần `fields: { Title: '[name="name[$lang]"]', Content: '[name="content[$lang]"]' }`. Widget tự thay `$lang` theo ngôn ngữ đang xử lý. Selector cố định không chứa `$lang` chỉ dùng cho bản gốc trong mapping tự động, phù hợp slug/SEO dùng chung. `fieldsByLocale` vẫn có thể thay mapping của một locale có tên trường khác quy luật. Trong PHP dùng chuỗi nháy đơn để giữ `$lang` nguyên dạng. Xem [ví dụ đầy đủ](docs/multilingual.md).

## Liên kết bài gốc và bản dịch

Widget tự tạo mã cho mỗi lượt viết để CRM gom bản gốc và các bản dịch. Website không cần lưu hoặc truyền mã bài, mã job CRM. Sau khi áp dụng, lượt viết mới dùng nhóm mới.

CRM có **Yêu cầu viết → Nhóm theo bài gốc**, hiển thị bản gốc và các phiên bản ngôn ngữ cùng nhau dù yêu cầu từ nhiều website đến xen kẽ. [Hướng dẫn quản lý nhóm](docs/article-groups.md).
