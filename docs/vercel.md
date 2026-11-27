# Triển khai CRM và demo widget trên Vercel

Hai project dùng cùng MongoDB và cùng `ENCRYPTION_KEY` hiện có:

- CRM: `vercel.crm.json`, giao diện quản lý và API Fastify chạy bằng Vercel Function.
- Widget: `vercel.widget.json`, trang biên tập có CKEditor và adapter tạo/xem bài qua quy trình CRM.

CRM có một Daemon 1 GiB tại Singapore, chạy vai trò `workers`: viết bài, webhook, từ khóa và bảo trì cho root/provider. Endpoint `/health` ở cổng 8080 phục vụ probe nội bộ, kiểm tra kết nối database; worker khởi tạo xong mới mở endpoint. Widget không tạo thêm worker. API tái sử dụng MongoDB pool trong mỗi instance; SSE đóng sau bốn phút để trình duyệt kết nối lại trước giới hạn Function.

## Build và kiểm tra

```sh
npm ci
npm run typecheck
node --import tsx --test test/serverless.test.ts test/widget-preview-security.test.ts test/widget-preview.test.ts test/job-pdf.test.ts test/partner-runtime.test.ts
node scripts/build-vercel.mjs crm --standalone
node scripts/build-vercel.mjs widget --standalone
```

Build tạo bundle ESM tại `dist/vercel/index.mjs`; Vercel Node builder đóng gói Function từ `api/index.mjs` cùng Daemon khai báo trong cấu hình. Bundle xử lý các dependency CommonJS gọi module ESM để tương thích bộ nạp của Vercel. CRM đóng gói Chromium dành cho môi trường serverless để xuất PDF, cùng font tiếng Việt. Demo chỉ đóng gói editor ở project widget.

Thêm `--standalone` để dùng `@vercel/nft` tạo gói kiểm tra biệt lập tại `.vercel/standalone-crm` hoặc `.vercel/standalone-widget`. Tệp môi trường và `.git` bị loại khỏi gói. Gói standalone phục vụ kiểm tra Function; triển khai dùng script bên dưới để build cả worker.

## Cấu hình production

Thiết lập riêng trong Environment Variables của từng project:

- `NODE_ENV=production`.
- `APP_ORIGIN`: origin HTTPS chính xác của project đó.
- `MONGODB_URI`, `MONGODB_DATABASE`, `ENCRYPTION_KEY`: dùng cùng giá trị giữa CRM, widget và worker. MongoDB cần replica set/sharded cluster, transaction và change stream; cho phép kết nối từ môi trường triển khai.
- `DB_POOL_SIZE=5` là cấu hình khởi tạo; Function giới hạn pool tối đa 5 kết nối mỗi instance.
- Các biến nghiên cứu/timeout/tỷ giá theo `.env.example` khi cần. Cấu hình vận hành và khóa nhà cung cấp đã lưu trong CRM tiếp tục dùng dữ liệu MongoDB hiện có.

Vercel dùng IP kết nối ra ngoài thay đổi. Với Atlas và Vercel Hobby, cần kiểm tra **Security → Network Access** trước khi vận hành. [Hướng dẫn Atlas cho Vercel](https://www.mongodb.com/docs/atlas/reference/partner-integrations/vercel/) dùng entry `0.0.0.0/0`; cấu hình này cho phép kết nối mạng từ mọi IP, còn database vẫn yêu cầu TLS và thông tin xác thực. Chủ database cần chủ động chấp nhận phạm vi này. Nếu phải giới hạn IP nguồn, chọn hạ tầng có IP ra ngoài cố định. Dấu hiệu cấu hình mạng chưa phù hợp là Function báo `MongoServerSelectionError`, worker báo lỗi bắt tay TLS, dù kết nối từ máy phát triển vẫn hoạt động.

Riêng project widget cần:

- `WIDGET_SITE_ID`: website khách hàng dùng quota dịch vụ, thuộc database đang chọn.
- `WIDGET_DEMO_CSRF_TOKEN`: chuỗi ngẫu nhiên tối thiểu 32 ký tự, dùng chung giữa các instance.
- `WIDGET_DEMO_PASSWORD_HASH`: SHA-256 dạng hex của chuỗi `username:password` dùng HTTP Basic Authentication. Dùng mật khẩu demo ngẫu nhiên riêng, không dùng mật khẩu tài khoản CRM. Bảo vệ áp dụng cho trang, tài nguyên, danh sách model và API tạo/xem bài. `/health` chỉ trả trạng thái kết nối database.

Lưu các giá trị bí mật bằng Secret trong Vercel, không đưa vào Git, build arguments, URL hoặc bundle frontend. Không tạo lại `ENCRYPTION_KEY` khi triển khai database có dữ liệu. Với database mới, khởi tạo bằng quy trình migration/API trước khi khởi chạy worker và Function.

## Deploy

Đăng nhập bằng tài khoản có quyền với workspace đích. Dùng CLI 67 trở lên:

```sh
npm exec --yes --package=vercel -- vercel login
npm run deploy:vercel:crm
npm run deploy:vercel:widget
```

Script chọn tệp cấu hình tương ứng, lấy danh sách source từ CLI dry-run, từ chối file môi trường/thư mục bí mật, rồi tạo snapshot tạm có `vercel.json` đúng project để remote builder đọc cả khai báo Daemon. Workspace mặc định là `tuyens-projects-42731ba6`; có thể đổi bằng `NODE_SERVICE_VERCEL_SCOPE`. Source đang sửa trong workspace cũng được đưa lên, không cần commit trước. Snapshot được xóa sau khi triển khai. Nếu bật deploy tự động qua Git về sau, cần cấu hình tương đương cho từng project, bao gồm Daemon của CRM.

Sau deploy, kiểm tra `/health`, trang đăng nhập CRM, bảo vệ API chưa đăng nhập, CKEditor sau đăng nhập demo và trạng thái Daemon/heartbeat. Các bài demo tạo yêu cầu thật, dùng quota và khóa AI hiện có. Không đưa một link frontend hoạt động thành bằng chứng worker đã chạy; cần kiểm tra worker riêng.

## Hạn mức Hobby

Daemons hiện ở public beta và chỉ chạy ở production. Hobby có 5 giờ Active CPU và 420 GB-giờ bộ nhớ mỗi tháng, dùng chung trong team; hết một trong hai hạn mức thì Daemon dừng. Một instance 1 GiB chạy liên tục dùng hết hạn mức bộ nhớ sau khoảng 17,5 ngày, có thể dừng sớm hơn do CPU hoặc workload khác. Không nâng cấp gói tự động trong cấu hình dự án. Xem [giới hạn Daemons](https://vercel.com/docs/daemons/limits).
