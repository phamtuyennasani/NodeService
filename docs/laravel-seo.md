# Đồng bộ bộ chấm SEO của Laravel với CRM

Chạy `npm run build:seo` hoặc `npm run build` trong CRM. Chép tệp `dist/widget/v1/seo-score.js` vào `public/assets/admin/js/seo-score.js` của Laravel. Đổi phiên bản trong URL của thẻ script ở `seo-box.blade.php` để trình duyệt tải bản mới.

Blade tiếp tục dùng `window.SeoScore.evaluate(...)` với các trường hiện có. Khi nhận `article.ready`, tìm yêu cầu đã lưu ở Laravel theo `X-Client-Request-Id` và dùng từ khóa chính của yêu cầu đó cho `focus_keyword`. Với bản xem trước, dùng từ khóa đã gửi khi tạo yêu cầu. Trường `keywords` lấy danh sách `Keywords` trong bài; giao diện có thể hiển thị nhãn **Từ khóa**. `stats.permalinkLength` là số ký tự của slug do bộ chấm chỉ nhận được phần slug của URL bài.

Điểm SEO là checklist hình thức, không phải chứng nhận đáp ứng chính sách Google hay dự báo thứ hạng. Báo cáo mới có `version: 2`. Các khóa cũ và số đo vẫn có để tương thích, nhưng mục về nguyên cụm từ khóa, vị trí, mật độ, mốc ký tự tiêu đề/mô tả và sự hiện diện liên kết nội bộ có `advisory: true`, `applicable: false`, `repairable: false`. Các mục này không tính vào điểm. `passed` của chúng chỉ ghi nhận phép đo. Không cộng điểm bằng cách đếm mọi `passed` mà bỏ qua `applicable`.

Worker chỉ tự chỉnh lỗi hình thức có thể sửa: thiếu tiêu đề/mô tả, slug, cấp đề mục, đoạn lặp nguyên nội dung, ngân sách từ và đoạn văn dài. Tối đa hai lượt, chỉ tiếp tục khi bản trước đã có tiến bộ và giữ tiêu chí hình thức đã đạt. Ngân sách từ do người đặt bài chọn, không phải số từ Google ưu tiên. Job kiểm tra theo yêu cầu ±15%, trong giới hạn sản phẩm 600–2.500 từ. Khi chấm lại trên form, truyền thêm `targetWords` bằng độ dài đã yêu cầu. Nếu bỏ trường này, API JavaScript tiếp tục dùng khoảng 600–2.500 từ.

Mật độ từ khóa vẫn là số liệu tham khảo với `repairable = false`: bộ đếm dùng số lần xuất hiện nguyên cụm chia tổng số từ, nên ép một cụm dài lặp lại để đạt tỷ lệ có thể làm giảm chất lượng bài. Liên kết nội bộ cũng không tự kích hoạt sửa khi không có trang đích thật. Kiểm tra chỉ nhận biết URL cùng website, không kiểm chứng trang đích còn hoạt động, tính liên quan hay chất lượng nội dung. Trước khi xuất bản, người biên tập cần kiểm tra độ chính xác của bài và metadata, giá trị bổ sung cho người đọc và liên kết thực tế; không thêm nội dung đệm hoặc URL giả chỉ để tăng điểm.

Lấy danh sách tiêu chí từ `window.SeoScore.criteria` hoặc `result.findings` để hiển thị cả bốn khóa mới `titlePresent`, `descriptionPresent`, `headingStructure`, `distinctParagraphs`. Dùng `result.score`, `result.passed`, `result.applicable` cho tổng điểm. Nếu component PHP có `$checkConfig()` và `$check()` riêng, cần đồng bộ cách loại mục tham khảo khỏi điểm hoặc dùng kết quả từ bộ JavaScript. Các mốc cũ vẫn có trong `window.SeoScore.limits` cho mục đích tham khảo. Để bộ đếm khi gõ dùng cùng cách đếm ký tự tiếng Việt, dùng hàm sau.

```js
const length = (value) => Array.from(value.trim().normalize('NFC')).length;
```

Trong `renderScore`, thay các dòng cập nhật `test-success`, `test-fail` và `status.textContent` của vòng lặp `result.findings.forEach` bằng đoạn sau để mục về ảnh hiển thị đúng trạng thái `Chưa chấm`.

```js
const applicable = finding.applicable !== false;
const advisory = finding.advisory === true;
item.dataset.applicable = String(applicable);
item.classList.toggle('test-success', applicable && finding.passed);
item.classList.toggle('test-fail', applicable && !finding.passed);
const status = item.querySelector('[data-seo-result]');
if (status) {
    status.textContent = advisory ? 'Tham khảo' : applicable ? (finding.passed ? 'Đạt gợi ý' : 'Cần xem xét') : 'Chưa chấm';
}
```

Trong phần đếm theo nhóm, thay phép đếm `total` bằng biểu thức sau để tổng theo nhóm khớp với các tiêu chí thực sự được chấm.

```js
const total = group.querySelectorAll('[data-seo-score-finding]:not([data-applicable="false"])').length;
```
