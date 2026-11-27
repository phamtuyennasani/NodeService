# Kế hoạch tích hợp phân tích từ khóa — cập nhật sau duyệt

Cập nhật 27/11/2026 theo yêu cầu: **tích hợp Keyword Tool Guest miễn phí vào CRM để xem chất lượng trước; chỉ chuyển Pro khi chủ động cấu hình sau này**. Kế hoạch AI thuần trước đó được thay bằng phương án này. Hướng dẫn hiện tại: [keyword-discovery.md](keyword-discovery.md).

## Phạm vi đợt đầu

CRM root/provider có màn hình phân tích và lịch sử, dữ liệu Keyword Tool Guest, AI phân loại tùy chọn, chuyển từ khóa/brief sang form viết hiện có. Website mới không có bài/traffic/Search Console vẫn dùng được. Đợt này chưa thêm màn hình nghiên cứu từ khóa vào widget Laravel/PHP; tính năng trên CRM không yêu cầu đổi cấu hình field của các website.

## Các bước và tiêu chí nghiệm thu

| Bước | Code/công việc | Kiểm thử và nghiệm thu |
| --- | --- | --- |
| 1. Kiểm tra nguồn | Initialize MCP không tài khoản; tra cứu Google theo chủ đề, country, language | Gọi Guest thật tiếng Việt/VN; xác minh số lượng, metric cache và giới hạn |
| 2. Adapter | Guest Streamable HTTP, JSON/SSE có giới hạn; chuẩn bị Pro REST riêng | JSON/text/structuredContent, SSE chia chunk, timeout/429/quota, key chỉ ở backend |
| 3. Chuẩn hóa | ID ổn định, Unicode, loại trùng, null/0, provenance và phạm vi metric | Không mất dấu, không gộp sai, không có metric giả; Guest ghi phạm vi cache chưa xác minh |
| 4. Lưu trữ | Mongo collection/index idempotent, history, request ID, chống phân tích trùng | Migration hai lần; request đồng thời không tạo/gọi nguồn hai lần |
| 5. Hạn mức | Lượt KH riêng ngày/tháng, giữ chỗ giao dịch, guard nguồn dùng chung root | Một lượt còn lại không bị cấp nhiều lần; nhiều provider vẫn chia guard Guest |
| 6. Worker | Pool keyword riêng, lease, trạng thái, hủy, khôi phục không replay mù | Kill/hết lease không gọi lại AI có thể đã tính phí; dữ liệu nguồn vẫn giữ |
| 7. AI tùy chọn | Model/key dịch vụ workspace, chọn tối đa 20 nhóm từ 50 ID nguồn | Schema chặt, không bịa ID/metric/URL; budget giá/token, usage và phí lỗi vẫn ghi |
| 8. API | CRM create/list/detail/cancel; settings riêng và revision | Phiên/proof/CSRF, root/provider isolation, source key không lộ; chỉ settings cần mật khẩu |
| 9. Giao diện | Form chủ đề, market/locale, dữ liệu thô, lọc, history, AI cards | Desktop/mobile, zero/thiếu, mạng lỗi và retry cùng ID, không tràn trang |
| 10. Chọn để viết | Backend xác minh analysis/candidate/site/customer/locale, brief snapshot | Form điền đúng; giả ID/khác site/đổi từ khóa không mang brief cũ; dàn ý nhận brief |
| 11. Nghiệm thu | Typecheck, test, build; MongoDB thật, UI, live Guest pilot | Báo pass/fail/skip riêng; không gọi dữ liệu mẫu là kết quả thật |
| 12. Chạy thử | Rebuild/start bản mới, giữ Guest mặc định, lưu pilot trong CRM | Trang mới mở được, health tốt, worker keyword hoạt động; không mua/chuyển Pro |

## Kết quả đã xác minh

- Bộ kiểm thử nền trước tính năng: 735 pass, 1 test Mongo opt-in skip.
- Test nguồn/chuẩn hóa/MCP/AI schema và test desktop/mobile được bổ sung.
- Đã chạy test MongoDB thật trên database riêng: chống trùng, giới hạn KH, guard root, phân quyền, chi AI thành công/thất bại, khôi phục và settings reauthentication.
- Kiểm tra cuối: typecheck/build đạt; bộ đầy đủ 746 pass, 2 test Mongo opt-in skip. Đã bật và chạy riêng cả hai nhóm MongoDB thật: 18 pass, không skip, gồm tạo job với brief và các luồng root/provider.
- Pilot Guest thật: chủ đề “thiết kế website”, 436 gợi ý nguồn, lấy 100 dòng, 5 dòng có cache; không gọi AI, không phát sinh phí nguồn/token.
- Pro chỉ kiểm thử bằng phản hồi giả lập; không có tài khoản Pro thật để xác minh live, không đăng ký/mua thuê bao trong đợt này.
- Bản mới đã chạy tại localhost:3210, health trả 200, bundle giao diện trả 200 và có heartbeat worker keyword đang nhận việc.

## Mở rộng sau khi xem kết quả

1. Đánh giá thêm 10–20 mô tả kinh doanh và các ngôn ngữ/thị trường cần dùng; so mức phù hợp giữa dữ liệu thô và AI lọc. Đây chưa phải xác minh nhu cầu SEO.
2. Nếu Guest hữu ích nhưng thiếu thống kê, cấu hình Pro và chạy kiểm thử live có trần/hạn mức rõ ràng.
3. Cân nhắc thêm UI widget, nhiều seed, phân trang, đối chiếu catalog, cập nhật bài cũ và Search Console sau khi duyệt phạm vi tiếp theo.

Kết quả có metric cache chưa rõ thị trường/kỳ phải luôn giữ nhãn tham khảo. AI nhận định mức phù hợp, không dự báo thứ hạng hoặc tạo số liệu thay cho dữ liệu còn thiếu.
