# Phân tích từ khóa trong CRM

Mở menu **Vận hành → Phân tích từ khóa**. Bản đầu tích hợp tại CRM cho root/provider; không yêu cầu website có bài, được index, có traffic hoặc Search Console.

## Dùng miễn phí

1. Chọn website; có thể lọc theo khách hàng.
2. Nhập một chủ đề/sản phẩm/dịch vụ, tối đa 80 ký tự. Đây có thể là “máy lọc nước” hoặc “thiết kế website”, không đòi khách hàng biết từ khóa SEO.
3. Chọn thị trường, ngôn ngữ và dạng gợi ý: từ khóa, câu hỏi hoặc cụm mở rộng.
4. Bổ sung mô tả hoạt động kinh doanh/đối tượng khi muốn AI đánh giá mức phù hợp.
5. Giữ **Nhờ AI chọn và nhóm chủ đề** tắt để xem dữ liệu nguồn mà không gọi AI.
6. Bấm **Phân tích từ khóa**. Có thể rời trang và mở lại từ lịch sử; không cần tạo lại tác vụ.

Kết nối mặc định là Keyword Tool Guest MCP. Mỗi phân tích gọi một lần công cụ gợi ý, lấy tối đa 100 kết quả đầu; tổng số gợi ý trên nguồn có thể lớn hơn. Không tự phân trang để tránh tiêu hao hạn mức ngoài dự tính. Dữ liệu nguồn được giữ đúng thứ tự, không gọi đó là thứ tự nên viết.

Nguồn công bố hạn mức Guest 60 request/giờ, 120/ngày. CRM có bộ đếm dùng chung qua database root cho mọi workspace; các lượt gọi từ phần mềm khác ngoài CRM vẫn có thể làm hạn mức phía nguồn hết sớm hơn. Chỉ tạo lượt mới trong phạm vi còn hạn mức; xem lại kết quả lưu không gọi nguồn.

## Hiểu số liệu

- Guest chỉ có metric cache cho tối đa 5 dòng đầu khi sẵn có; không đảm bảo đủ 5. Một truy vấn có thể chỉ có 1 dòng hoặc không có dòng nào có số liệu. CRM hiển thị số từ có lượng tìm kiếm trên tổng từ đã lấy. Không có dữ liệu hiển thị **Chưa có** hoặc dấu gạch, không biến thành số 0.
- Guest không nhận riêng vị trí/ngôn ngữ thống kê và không trả đủ kỳ/phạm vi của metric cache. CRM hiển thị ghi chú: không coi số đó là lượng tìm kiếm đã xác minh cho thị trường gợi ý đã chọn.
- `volume`: lượng tìm kiếm/tháng do nguồn trả. `trend`: phần trăm thay đổi do nguồn trả, không dự báo nhu cầu tương lai. Thời điểm lấy kết quả không phải thời điểm cập nhật cache.
- Cạnh tranh Ads là cạnh tranh quảng cáo. Giá thầu đầu trang thấp/cao là khoảng giá thầu quảng cáo USD, khác CPC và khác độ khó SEO.
- Từ khóa có gợi ý chưa đủ chứng minh nhu cầu cao, ít cạnh tranh hoặc dễ lên top.

## AI chọn chủ đề và viết bài

Bật **Nhờ AI chọn và nhóm chủ đề**, chọn model có khóa dịch vụ của workspace. Phần này có tính token AI hiện hữu của CRM, dù nguồn Guest miễn phí. Không lấy khóa của root làm dự phòng cho provider.

AI nhận tối đa 50 ứng viên và chỉ chọn ID được cấp, trả tối đa 20 đề xuất kèm intent dự kiến, tiêu đề, góc viết, lý do và các từ liên quan. AI không sửa hoặc tạo metric/URL. Model/usage/phiên bản giá/chi phí được lưu riêng. Nếu chưa có giá đầy đủ hoặc dự tính vượt trần, không gọi AI; kết quả nguồn vẫn xem và dùng được. Không tự gọi thêm lượt AI sửa JSON khi kết quả sai trong bản thử này.

Bấm **Viết bài** ở một từ khóa hoặc **Dùng để viết bài** ở đề xuất AI. Form hiện tại được điền khách hàng, website, từ khóa và ngôn ngữ. Chỉ khi bấm xác nhận viết mới tạo job/trừ lượt bài viết. Backend xác minh phân tích và ứng viên theo site/customer/locale, lưu brief riêng để dàn ý/bản nháp nhận đúng tiêu chí. Nếu người dùng đổi từ khóa/website, liên kết đề xuất được bỏ.

AI nhận định mức phù hợp theo mô tả kinh doanh, chưa xác minh tính cạnh tranh hoặc thứ hạng. Các từ khóa thô có thể gồm thương hiệu khác, chủ đề ngoài phạm vi hoặc cáo buộc; cần chọn đúng hoạt động thực tế trước khi viết.

## Hạn mức, lưu kết quả và sự cố

Mặc định mỗi KH có 10 lượt mới/ngày, 100 lượt/tháng (giờ Việt Nam); dùng lại cùng tiêu chí trong 24 giờ; trần dự tính AI 0,10 USD/lượt. Chỉnh tại **Cài đặt → Từ khóa**. Tiêu chí gồm website, seed, mô tả, đối tượng, ngôn ngữ, thị trường, dạng gợi ý, model và chế độ nguồn.

Một kết quả dùng được tính một lượt phân tích, độc lập lượt viết bài. Không có kết quả thì trả lại lượt; cuộc gọi AI đã phát sinh vẫn ghi chi phí dù lỗi. Hủy chỉ ngừng các phần chưa bắt đầu; đóng cửa sổ không hủy tác vụ. Tác vụ gián đoạn không tự gọi lại phần có thể đã tính phí. Kết quả nguồn đã lưu được giữ, AI lỗi hiển thị trạng thái một phần. Thiếu giá/usage là chưa đủ dữ liệu chi phí, không coi là miễn phí.

Cấu hình được lưu có revision và khóa mã hóa bằng ENCRYPTION_KEY. API không trả lại khóa. Chỉ lưu cài đặt yêu cầu nhập lại mật khẩu; tra cứu/xem/chọn từ khóa dùng phiên CRM hiện có.

## Khi chuyển sang Pro

1. Đăng ký gói có quyền REST API trực tiếp với Keyword Tool khi thực sự cần.
2. Vào **Cài đặt → Từ khóa**, chọn **Pro REST API**, nhập API key và hạn mức request/ngày đúng gói.
3. Lưu cài đặt; tạo phân tích mới để kiểm tra dữ liệu. Kết quả Guest cũ giữ nguyên nguồn/ghi chú, không đổi thành Pro.

CRM có adapter REST riêng và gửi vị trí/ngôn ngữ thống kê theo thị trường được chọn. API key chỉ gửi từ backend tới host Keyword Tool cố định. Phí Pro là phí thuê bao, chưa phân bổ theo lượt nên không ghi thành 0 USD. Không có cơ chế tự mua, tự nâng cấp hoặc tự chuyển từ Guest sang Pro. Adapter Pro đã có kiểm thử phản hồi giả lập; cần kiểm thử live khi có tài khoản thật.

## Vận hành và kiểm thử

`npm start` (role all) tự chạy worker từ khóa riêng, concurrency 1/workspace; vẫn tuân thủ giới hạn tài khoản AI chung. Nếu tách tiến trình, thêm `npm start -- keyword` cùng database/cấu hình. Supervisor provider khởi động và dừng pool tương ứng, dữ liệu riêng theo workspace.

Các collection: keyword_settings, keyword_analyses, keyword_attempts, keyword_quota_reservations; keyword_source_limits tại root giữ bộ đếm nguồn dùng chung. Migration trong src/migrate.ts là idempotent. Lịch sử này chưa áp dụng chính sách tự xóa của bài viết.

Kiểm tra nhanh: npm run typecheck; npm test; npm run build. Test nguồn/JSON/SSE/metric trong test/keywords-source.test.ts; UI desktop/mobile và chuyển sang viết trong test/crm-keywords-ui.test.ts. Test MongoDB riêng tại test/keywords-mongo.test.ts, bật CRM_TEST_MONGODB_URI tới replica set thử nghiệm; test tạo database riêng và dọn sau khi chạy. Không dùng dữ liệu mô phỏng làm kết quả thống kê thật.

## Kết quả pilot ngày 27/11/2026

Thử luồng đã tích hợp với chủ đề **thiết kế website**, thị trường Việt Nam, tiếng Việt: nguồn báo **436 gợi ý**, CRM lấy **100**, **5 dòng** có metric cache. Một số từ trả về: “dịch vụ thiết kế website”, “thiết kế website giá bao nhiêu”, “báo giá thiết kế website”, “chi phí thiết kế website”. Không bật AI trong lượt pilot nên phí nguồn **0 USD**, không phát sinh token AI. Kết quả được lưu trong lịch sử CRM. Đây là kiểm chứng kết nối/dữ liệu, chưa phải đánh giá đầy đủ chất lượng SEO hoặc thống kê theo thị trường.

Nguồn chính thức: [Guest MCP](https://keywordtool.io/mcp/guest), [tham số MCP](https://keywordtool.io/api.md?scope=mcp), [REST API](https://keywordtool.io/api).
