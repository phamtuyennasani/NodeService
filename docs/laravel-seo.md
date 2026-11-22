# Đồng bộ bộ chấm SEO của Laravel với CRM

Chạy `npm run build:seo` hoặc `npm run build` trong CRM. Chép tệp `dist/widget/v1/seo-score.js` vào `public/assets/admin/js/seo-score.js` của Laravel. Đổi phiên bản trong URL của thẻ script ở `seo-box.blade.php` để trình duyệt tải bản mới.

Blade tiếp tục dùng `window.SeoScore.evaluate(...)` với các trường hiện có. Khi nhận `article.ready`, tìm yêu cầu đã lưu ở Laravel theo `X-Client-Request-Id` và dùng từ khóa chính của yêu cầu đó cho `focus_keyword`. Với bản xem trước, dùng từ khóa đã gửi khi tạo yêu cầu. Trường `keywords` lấy danh sách `Keywords` trong bài; giao diện có thể hiển thị nhãn **Từ khóa**. `stats.permalinkLength` là số ký tự của slug do bộ chấm chỉ nhận được phần slug của URL bài.

Điểm SEO là checklist biên tập nội bộ, không phải chứng nhận đáp ứng chính sách Google hay dự báo thứ hạng. Các khóa tiêu chí, ngưỡng số và cách tính điểm được giữ để tương thích CRM/Laravel; các mốc 41–70 ký tự cho tiêu đề, 155–160 ký tự cho mô tả, 600–2.500 từ, vị trí từ khóa và mật độ từ khóa chỉ là gợi ý tham khảo. Google không quy định các mốc này là điều kiện để nội dung được xếp hạng. Khi hiển thị, dùng `finding.message` để người biên tập thấy rõ giới hạn kiểm tra; với mục chưa đạt nên dùng nhãn **Cần xem xét** thay vì kết luận nội dung không đạt chuẩn Google.

Các gợi ý thuần số lượng hoặc vị trí từ khóa có `repairable = false`: chúng không tự kích hoạt lượt viết lại. Slug trống/sai định dạng và cấu trúc đoạn khó đọc vẫn có thể được chỉnh có mục tiêu. Kiểm tra liên kết nội bộ chỉ nhận biết URL cùng website, không kiểm chứng trang đích còn hoạt động, tính liên quan hay chất lượng nội dung. Trước khi xuất bản, người biên tập cần kiểm tra độ chính xác của bài và metadata, giá trị bổ sung cho người đọc và liên kết thực tế; không thêm nội dung đệm chỉ để tăng điểm.

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
