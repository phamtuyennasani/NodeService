# Quản lý bài gốc và các phiên bản ngôn ngữ

Trong CRM, mở **Yêu cầu viết → Nhóm theo bài gốc**. Mỗi hàng là một lượt viết của một website, gồm bản gốc và các bản dịch. Mở rộng hàng để xem các phiên bản; chọn một ngôn ngữ để mở lần viết. **Xem toàn bộ lịch sử** mở danh sách yêu cầu đã lọc theo nhóm.

CRM gom nhóm trước khi phân trang. Yêu cầu của nhiều website có thể xen kẽ mà không tách bản gốc và các bản dịch sang nhóm khác. Backend xác định nhóm theo website và khách hàng đã xác thực.

## Luồng widget

1. Nhập tiêu chí và viết bản gốc trong ngôn ngữ `AIConfig.languages.source`.
2. CRM trả bản gốc vào popup. Người dùng chọn **Áp dụng** hoặc **Dịch sang các ngôn ngữ khác**.
3. Khi chọn dịch, widget tạo lần lượt tất cả ngôn ngữ trong `targets`, dùng nội dung bản gốc đang xem trước. Form website chưa thay đổi.
4. Dịch xong chỉ còn nút **Áp dụng** để điền toàn bộ phiên bản vào form.
5. Sau khi áp dụng, lần bấm Viết bài AI tiếp theo bắt đầu một bài mới và một nhóm CRM mới.

Widget tự tạo mã `draft:<UUID>` cho mỗi lượt viết và tự liên kết các bản dịch với job gốc trong lượt đó. Website không cần truyền `articleRef`, `sourceJobId`, thêm input ẩn hoặc lưu mã CRM vào bài. BaseCodeAW không lưu các mã này trong `news.options`.

Nếu dịch lỗi, các bản đã hoàn tất được giữ trong popup; thử lại tiếp tục phần còn thiếu. Yêu cầu chưa có phản hồi giữ cùng body và Idempotency-Key; job đã được nhận sẽ được đọc lại bằng mã đọc kết quả. Mỗi bản gốc/bản dịch vẫn là một job và một lượt riêng nếu dùng gói dịch vụ. Gom nhóm không phát sinh lượt viết bổ sung.

## Các trường trên API

| Trường | Ý nghĩa |
| --- | --- |
| `article_ref` | Mã lượt viết; widget tự tạo mới cho mỗi bài. Các bản dịch của lượt đó dùng chung mã. |
| `article_group_id` | Mã nhóm do CRM xác định trong transaction, theo đúng website và khách hàng. |
| `original_locale` | Ngôn ngữ gốc của nhóm. |
| `original_job_id` | Job bản gốc của nhóm. |
| `translation_of_job_id` | Job bản gốc được dùng để tạo bản dịch. |
| `translation_source` | Snapshot bản gốc trong popup, giữ nguyên khi dịch các ngôn ngữ của cùng lượt. |
| `source_article_id` | Quan hệ viết lại qua API, tách riêng với quan hệ chuyển ngữ. |

CRM kiểm tra job nguồn thuộc đúng website, khách hàng, đã hoàn tất và đúng ngôn ngữ gốc. Gắn chéo website hoặc dùng mã bài khác với nhóm nguồn bị từ chối trước khi giữ lượt mới. Không gửi `article_group_id` để tự chọn nhóm. Khi bài gốc còn được bản dịch tham chiếu, CRM chặn xóa bản gốc để giữ liên kết.

Ứng dụng gọi API trực tiếp từ backend có thể quản lý `article_ref` theo dữ liệu riêng và gửi `translation_source` theo hợp đồng API. Widget nhúng sử dụng luồng xem trước và áp dụng nêu trên, không tiếp tục dịch nội dung đã điền trên form.

## Dữ liệu cũ

Các nhóm cũ được giữ để quản lý lịch sử. Yêu cầu không có mã nhóm được hiển thị riêng. CRM không tự ghép bài theo từ khóa, tiêu đề hoặc nội dung giống nhau, tránh nối nhầm bài và website.
