# Bộ tích hợp tải từ CRM

Vào **Website → chọn website → Hướng dẫn tích hợp**, chọn **Laravel** hoặc **PHP thuần**. Mỗi tab hiển thị phiên bản, môi trường hỗ trợ, nút tải ZIP, cách cài và cách cập nhật. Nút tải sử dụng phiên đăng nhập và chữ ký trình duyệt CRM hiện có.

Laravel là bộ chép file cho Laravel 10–13, dùng cùng AIConfig với BaseCodeAW. PHP thuần là thư viện PHP 8.2+ hiện có, có autoloader và các file ví dụ, hỗ trợ giải nén không cần Composer. Nội dung hướng dẫn lấy từ các file nguồn của đúng bộ tích hợp khi build.

## Phát hành bản cập nhật

1. Sửa bộ nguồn trong `integrations/laravel-upload` hoặc `packages/php-crm-ai` và README tương ứng. Chỉ sửa cấu hình mẫu; không sao chép token, khóa hoặc dữ liệu của website vào gói.
2. Tăng `version` và đổi `filename` trong `integrations/releases.json` cho nền tảng được cập nhật. Với PHP, tăng cả version trong `packages/php-crm-ai/composer.json`.
3. Chạy `npm run build` (cần Python 3 bên cạnh Node). Build tự tạo hai ZIP, catalog có kích thước/SHA-256 và các đoạn hướng dẫn. Có thể chỉ đóng gói bằng `npm run build:integrations`.
4. Deploy toàn bộ `dist`, gồm `dist/packages`, cùng server và frontend mới. Không ghi đè các ZIP bằng mã riêng của khách hàng. CRM đọc catalog mới trên mỗi lần mở hướng dẫn, khách có thể tải lại bản mới nhất.

API nằm dưới `/api/crm/integrations`. ZIP được tải qua `/api/crm/integrations/{platform}/{version}/download`, chỉ chấp nhận gói trong catalog và kiểm tra checksum trước khi trả file. Thư mục `dist/packages` không được mở thành thư mục tĩnh công khai.

Khi cập nhật website đã tích hợp, giữ cấu hình kết nối và các khóa riêng. Hướng dẫn từng tab liệt kê các đường dẫn cần giữ; ghép thay đổi vào AIConfig/bootstrap đã tùy chỉnh thay vì chép đè toàn bộ layout của website.
