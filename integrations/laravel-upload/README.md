# CRM AI cho Laravel 10–13

Bộ ZIP chứa các file để chép vào dự án Laravel hiện có. Dịch vụ ký yêu cầu và lưu key nằm trong `app/CrmAi`. Controller, middleware, route, config và view đặt theo cấu trúc Laravel. Script nút viết được tải từ CRM.

## Chép file

Giải nén ZIP rồi chép các file theo bảng sau. Các đường dẫn tính từ thư mục gốc chứa `artisan` của website.

| File trong ZIP | Chép vào website |
| --- | --- |
| `app/CrmAi/Bridge.php` và `PrivateFiles.php` | `app/CrmAi/` |
| `app/Http/Controllers/CrmAiController.php` | `app/Http/Controllers/` |
| `app/Http/Middleware/CrmAiPrivateResponse.php` | `app/Http/Middleware/` |
| `app/Providers/CrmAiServiceProvider.php` | `app/Providers/` |
| `routes/crm-ai.php` | `routes/` |
| `config/crm-ai.php` | `config/` |
| `resources/views/crm-ai/*.blade.php` | `resources/views/crm-ai/` |
| `resources/views/admin/layouts/js.blade.php` | `resources/views/admin/layouts/` |

Laravel tự nạp class qua PSR-4 `App\\`. Website cần có đăng nhập admin, Laravel `APP_KEY`, PHP OpenSSL và quyền ghi `storage/`. Bộ này dùng các thư viện Laravel đang có trên website.

## Đăng ký vào Laravel

Trong phương thức `register()` hiện có của `app/Providers/AppServiceProvider.php`, thêm dòng sau. Cách này dùng chung cho Laravel 10, 11, 12 và 13.

```php
$this->app->register(\App\Providers\CrmAiServiceProvider::class);
```

Provider nạp `routes/crm-ai.php` qua `loadRoutesFrom()`, tương thích với route cache. Nếu ứng dụng dùng `classmap-authoritative`, chạy `composer dump-autoload -a` sau khi chép file. Khi website có cache cấu hình, route hoặc view, làm mới cache theo quy trình deploy hiện tại.

## Cấu hình website

Mở `config/crm-ai.php`.

1. Trong **CRM → Website → Kết nối API**, cấp token rồi bấm **Sao chép connection**. Thay dòng `connection` trong config bằng dòng CRM cung cấp.

   ```php
   'connection' => 'https://crm.example.com|<website-id>|<site-token>',
   ```

   Phần thứ hai là ID website do CRM tạo, phần thứ ba là token được cấp. Sao chép cả dòng để lấy đủ ba giá trị.

2. Đặt `middleware` theo guard của admin, ví dụ `['auth:admin']`. Tài khoản đã đăng nhập qua guard này được dùng widget và trang cấu hình AI.

3. Có thể đổi `prefix` thành `admin/crm-ai` nếu muốn đặt các endpoint trong khu vực admin. Giá trị mặc định là `crm-ai`.

4. Đăng nhập admin, mở `/crm-ai/settings` (hoặc đường dẫn prefix đã chọn). Bấm **Tạo khóa máy chủ** rồi dán khóa công khai vào **CRM → Website → Kết nối API → Đăng ký khóa ký**.

Token và khóa riêng được dùng ở máy chủ. Mã kết nối lấy trực tiếp từ `connection` trong `config/crm-ai.php`. Để trống sẽ tắt kết nối. Khi phát hành ZIP cho web khác, giữ mẫu config trống.

## Hiện nút viết

Form bài viết dùng `id="news-main-form"` và `@csrf`. Chép dòng sau cạnh nút lưu.

```blade
@include('crm-ai.writer')
```

Trong layout admin, sau script của trang và trước thẻ đóng body, thêm dòng sau.

```blade
@include('admin.layouts.js')
```

File `resources/views/admin/layouts/js.blade.php` được dùng nguyên bản trong BaseCodeAW, bộ ZIP và hướng dẫn CRM. AIConfig dùng nút `#news-ai-writer`, form `#news-main-form`, tiêu đề `name[$lang]` và nội dung `content[$lang]`. Các dòng `add(...)` map thêm mô tả, slug, SEO và có callback CKEditor. Khi ứng dụng dùng tên trường khác, chỉnh mapping theo form.

Đặt `AIConfig.languages` trong chính file JS này, ví dụ `{ source: 'en', targets: ['vi'] }`. Mặc định là `{ source: 'vi', targets: [] }`. Các ngôn ngữ đích cần có trường tương ứng trên form.

### Tự CSS nút viết bài

Đặt `customStyle: true` trong AIConfig để nút Viết bài AI nằm trong HTML của website và dùng CSS của website. Popup tiếp tục dùng CSS riêng của widget. Mặc định `false` dùng nút có sẵn của widget.

```javascript
const AIConfig = {
    mount: '#news-ai-writer',
    form: '#news-main-form',
    customStyle: true,
    customClass: 'btn btn-primary',
    languages: { source: 'vi', targets: [] },
};
```

`customClass` thêm một hoặc nhiều class vào nút, giữ class mặc định `.crm-ai-launch`. Ví dụ trên tạo `class="crm-ai-launch btn btn-primary"`. Dùng cùng `customStyle: true` để CSS admin hoặc Bootstrap tác động trực tiếp lên nút. Mặc định `customClass: ''`.

Thêm CSS vào stylesheet của trang admin; selector cho nút là `.crm-ai-launch`, hoặc giới hạn theo vị trí nút như sau.

```css
#news-ai-writer > .crm-ai-launch {
    background: #2455d6;
    color: #fff;
    border: 0;
    border-radius: 6px;
    padding: 8px 14px;
    font: inherit;
    cursor: pointer;
}
```

Widget lấy cấu hình key riêng qua endpoint có đăng nhập admin và tải script từ CRM. Người dùng nhập tiêu chí, nhận bản gốc trong cửa sổ xem trước rồi chọn **Áp dụng** hoặc **Dịch sang các ngôn ngữ khác**. Dịch xử lý tất cả ngôn ngữ đích theo cấu hình từ chính bản gốc đang xem trước; sau khi hoàn tất chỉ còn nút **Áp dụng** để điền cả bản gốc và các bản dịch vào form. Chưa bấm Áp dụng thì nội dung trên form chưa thay đổi. Website không cần thêm input ẩn hoặc lưu mã bài, mã job CRM.

Sau khi áp dụng, nút **Viết bài AI** bắt đầu lại từ bước nhập tiêu chí để viết bài mới. Widget không dùng bài đã điền trên form để tiếp tục dịch. Nếu một bản dịch lỗi, **Thử lại bản dịch** giữ các bản đã hoàn tất và tiếp tục phần còn thiếu.

Nếu slug hoặc SEO chỉ có ở ngôn ngữ gốc, truyền tùy chọn khi include nút.

```blade
@include('crm-ai.writer', ['slugMultilang' => false, 'seoMultilang' => false])
```

Website có CSP cần cho phép origin CRM trong `script-src` và `connect-src`, cùng script inline theo chính sách website.

## Key AI riêng

Thêm link `route('crm-ai.settings')` vào menu admin để mở trang có ba ô **Base URL**, **API key**, **Model**. Nhập địa chỉ HTTPS của nhà cung cấp OpenAI Compatible và mã model. Để trống API key khi sửa nếu muốn giữ key hiện tại.

Key được mã hóa bằng Laravel `APP_KEY` và lưu tại `storage/app/private/crm-ai/credentials.enc`. Khóa ký là `signing.pem` trong cùng thư mục. Khi chuyển server hoặc chạy nhiều máy chủ cho cùng website, dùng chung các file này và `APP_KEY`. API key riêng được cung cấp cho trình duyệt của tài khoản đã đăng nhập admin, các endpoint này đặt `Cache-Control: private, no-store`.

## Kiểm tra tích hợp

- Nút chưa hiện. Kiểm tra đăng nhập admin, guard, mã kết nối và ID form.
- CRM từ chối yêu cầu. Kiểm tra domain của website, khóa công khai đã đăng ký và giờ máy chủ. Với reverse proxy, Laravel cần nhận đúng scheme và host của trang biên tập.
- Web đa ngôn ngữ khai báo `languages` và selector `$lang` trong AIConfig. Các bản dịch được tạo trước khi áp dụng; mỗi lần mở lượt viết mới luôn bắt đầu bằng một bản gốc mới.
