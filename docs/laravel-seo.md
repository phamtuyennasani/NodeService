# Đồng bộ bộ chấm SEO của Laravel với CRM

Chạy `npm run build:seo` hoặc `npm run build` trong CRM. Chép tệp `dist/widget/v1/seo-score.js` vào `public/assets/admin/js/seo-score.js` của Laravel. Đổi phiên bản trong URL của thẻ script ở `seo-box.blade.php` để trình duyệt tải bản mới.

Blade tiếp tục dùng `window.SeoScore.evaluate(...)` với các trường hiện có. Khi nhận `article.ready`, tìm yêu cầu đã lưu ở Laravel theo `X-Client-Request-Id` và dùng từ khóa chính của yêu cầu đó cho `focus_keyword`. Với bản xem trước, dùng từ khóa đã gửi khi tạo yêu cầu. Trường `keywords` lấy danh sách `Keywords` trong bài; giao diện có thể hiển thị nhãn **Từ khóa**. `stats.permalinkLength` là số ký tự của slug do bộ chấm chỉ nhận được phần slug của URL bài.

Điểm SEO là checklist biên tập nội bộ, không phải chứng nhận đáp ứng chính sách Google hay dự báo thứ hạng. Các khóa tiêu chí, ngưỡng số và cách tính điểm được giữ để tương thích CRM/Laravel; các mốc 41–70 ký tự cho tiêu đề, 155–160 ký tự cho mô tả, 600–2.500 từ, vị trí từ khóa và mật độ từ khóa chỉ là gợi ý tham khảo. Google không quy định các mốc này là điều kiện để nội dung được xếp hạng. Khi hiển thị, dùng `finding.message` để người biên tập thấy rõ giới hạn kiểm tra; với mục chưa đạt nên dùng nhãn **Cần xem xét** thay vì kết luận nội dung không đạt chuẩn Google.

Worker CRM dùng checklist này ngay từ bước lập dàn ý và viết bài. Các lỗi tiêu đề, mô tả, vị trí từ khóa, slug, độ dài bài và đoạn văn được đưa vào tối đa hai lượt chỉnh sửa có mục tiêu. Chỉ chạy lượt tiếp nếu bản trước đã sửa được lỗi nhưng còn tiêu chí có thể sửa; bản chỉnh chỉ được dùng khi giữ các tiêu chí đã đạt. Báo cáo của job kiểm tra độ dài theo yêu cầu ±15%, trong giới hạn 600–2.500 từ (ví dụ yêu cầu 1.500 từ chấp nhận 1.275–1.725). Khi chấm lại trên form, truyền thêm `targetWords` bằng độ dài đã yêu cầu để dùng cùng ngân sách; nếu bỏ trường này, API JavaScript cũ tiếp tục dùng khoảng 600–2.500 từ.

Mật độ từ khóa vẫn là số liệu tham khảo với `repairable = false`: bộ đếm dùng số lần xuất hiện nguyên cụm chia tổng số từ, nên ép một cụm dài lặp lại để đạt tỷ lệ có thể làm giảm chất lượng bài. Liên kết nội bộ cũng không tự kích hoạt sửa khi không có trang đích thật. Kiểm tra chỉ nhận biết URL cùng website, không kiểm chứng trang đích còn hoạt động, tính liên quan hay chất lượng nội dung. Trước khi xuất bản, người biên tập cần kiểm tra độ chính xác của bài và metadata, giá trị bổ sung cho người đọc và liên kết thực tế; không thêm nội dung đệm hoặc URL giả chỉ để tăng điểm.

Trong component PHP chứa `$checkConfig()` và `$check()`, đặt `title.min = 41`, `title.max = 70`, `description.min = 155`, `description.max = 160` và cập nhật các thông báo độ dài tương ứng. JavaScript có các ngưỡng này trong `window.SeoScore.limits.title` và `window.SeoScore.limits.metaDescription`. Để bộ đếm khi gõ dùng cùng cách đếm ký tự tiếng Việt, đổi hàm đếm trong `initSeoChecker` thành hàm sau.

```js
const length = (value) => Array.from(value.trim().normalize('NFC')).length;
```

Trong `renderScore`, thay các dòng cập nhật `test-success`, `test-fail` và `status.textContent` của vòng lặp `result.findings.forEach` bằng đoạn sau để mục về ảnh hiển thị đúng trạng thái `Chưa chấm`.

```js
const applicable = finding.applicable !== false;
item.dataset.applicable = String(applicable);
item.classList.toggle('test-success', applicable && finding.passed);
item.classList.toggle('test-fail', applicable && !finding.passed);
const status = item.querySelector('[data-seo-result]');
if (status) {
    status.textContent = applicable ? (finding.passed ? 'Đạt gợi ý' : 'Cần xem xét') : 'Chưa chấm';
}
```

Trong phần đếm theo nhóm, thay phép đếm `total` bằng biểu thức sau để tổng theo nhóm khớp với các tiêu chí thực sự được chấm.

```js
const total = group.querySelectorAll('[data-seo-score-finding]:not([data-applicable="false"])').length;
```
