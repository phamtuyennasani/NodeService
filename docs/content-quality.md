# Quy trình nội dung và kiểm tra SEO

Cập nhật ngày 27/11/2026 sau khi đối chiếu Google Search Central. Các quy tắc biên tập dưới đây là lựa chọn triển khai của CRM, không phải công thức xếp hạng của Google.

## Trước và trong khi viết

Worker nghiên cứu chủ đề nếu được bật, lập dàn ý rồi viết bài. Prompt yêu cầu xác định nhu cầu chính, độc giả và kết quả họ cần đạt. Hướng dẫn cần có điều kiện, bước làm và cách kiểm tra. So sánh cần dùng cùng tiêu chí và nêu đánh đổi. Trang dịch vụ chỉ mô tả thông tin được cung cấp. Tin tức cần căn cứ về sự kiện và thời điểm.

Mở bài trả lời sớm câu hỏi chính. Mỗi phần bổ sung giải thích, tiêu chí lựa chọn, ví dụ hoặc cách xử lý tình huống. FAQ, bảng và lời kêu gọi hành động chỉ xuất hiện khi có ích. Prompt yêu cầu không bịa số liệu, trải nghiệm, tác giả, chuyên môn, thương hiệu hoặc lời chứng thực. Các ràng buộc prompt không thay thế việc kiểm tra sự thật.

## Đối chiếu nguồn trong CRM

Vào **Yêu cầu viết → Chi tiết → Nguồn nghiên cứu** để xem truy vấn, ngôn ngữ, thời điểm ghi nhận, URL và trích đoạn đã dùng. Số nguồn trong dàn ý tương ứng danh sách này. Các bản dịch giữ dữ kiện của bản gốc và không nghiên cứu thêm.

CRM lưu tối đa 10 nguồn có URL hợp lệ, bỏ nguồn trùng và giới hạn độ dài trích đoạn. DuckDuckGo chọn vùng theo ngôn ngữ bài viết khi có vùng hỗ trợ. Đây là kết quả tìm kiếm, chưa phải toàn văn hoặc sự thật đã được xác minh. Người biên tập cần mở nguồn, kiểm tra ngày, ngữ cảnh, phạm vi và mức độ khẳng định. Khi không lấy được nguồn, CRM ghi rõ trạng thái và prompt yêu cầu bỏ các tuyên bố thời sự hoặc số liệu thiếu căn cứ.

Nguồn nằm trong hồ sơ CRM, không được tự chèn thành danh sách tham khảo trong bài, webhook hoặc JSON kết quả. Bài cũ chưa lưu nguồn hiển thị trạng thái chưa có dữ liệu.

## Bộ kiểm tra hình thức phiên bản 2

`seo_report.version = 2` giữ các khóa và số đo trước đây để tương thích tích hợp. Các số đo nguyên cụm từ khóa, vị trí từ khóa, mật độ, mốc ký tự metadata và sự hiện diện liên kết nội bộ có `advisory: true`, `applicable: false`, `repairable: false`. Chúng không cộng/trừ điểm hoặc kích hoạt lượt AI chỉnh sửa. `passed` ở các mục này chỉ ghi nhận phép đo, không phải kết luận chất lượng.

Các kiểm tra được chấm gồm có tiêu đề, có mô tả, định dạng slug, ngân sách từ được yêu cầu, đoạn ngắn, cấp đề mục khi có đề mục và đoạn dài bị lặp nguyên nội dung. Chúng phát hiện lỗi hình thức, không xác định đúng intent, tính mới, chuyên môn hay độ chính xác. Số từ là ngân sách do người đặt bài chọn, không phải số từ Google ưu tiên. Worker vẫn giữ giới hạn tối đa hai lượt chỉnh sửa, chỉ nhận bản có tiến bộ mà không làm mất tiêu chí hình thức đã đạt.

Báo cáo cũ giữ cách chấm tại thời điểm viết. CRM và widget hỗ trợ cả báo cáo cũ và mới. Với bộ chấm trên form Laravel, xem [cách đồng bộ](laravel-seo.md).

## Khi xuất bản trên website

Tên tác giả và thông tin chuyên môn phải có thật. Website cần triển khai title/meta từ kết quả, URL phù hợp, liên kết có thể thu thập, canonical, sitemap và các URL/ngôn ngữ `hreflang` thực tế. Những thông tin này thuộc website xuất bản. CRM không biết URL bài cuối cùng nên không tự tạo canonical, schema tác giả hoặc hreflang trong nội dung.

Theo dõi truy vấn, lượt hiển thị, lượt nhấp và hiệu quả bài trong Search Console để quyết định cập nhật. Không suy ra khả năng lên top từ điểm CRM. Kiểm thử phần mềm xác nhận hợp đồng prompt, kiểm tra hình thức, lưu nguồn và giao diện, không xác nhận thứ hạng của một bài thực tế.

## Tài liệu đối chiếu

- [Nội dung hữu ích và đáng tin cậy](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- [Nội dung tạo bằng AI](https://developers.google.com/search/docs/fundamentals/using-gen-ai-content)
- [Tiêu đề trong kết quả tìm kiếm](https://developers.google.com/search/docs/appearance/title-link)
- [Mô tả và đoạn trích](https://developers.google.com/search/docs/appearance/snippet)
- [Liên kết có thể thu thập và anchor text](https://developers.google.com/search/docs/crawling-indexing/links-crawlable)
- [Vùng tìm kiếm DuckDuckGo](https://duckduckgo.com/duckduckgo-help-pages/settings/params)
