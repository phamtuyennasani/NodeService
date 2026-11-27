# Cấu hình ngôn ngữ cho AI Writer

Widget tự gom bản gốc và các bản dịch của mỗi lượt viết thành một nhóm trên CRM. Website không cần lưu mã nhóm hoặc mã job. Xem [quản lý bài gốc và các phiên bản](article-groups.md).

Website khai báo ngôn ngữ nội dung trong `AIConfig.languages`. Ngôn ngữ gốc lấy từ cấu hình website, không từ ngôn ngữ trình duyệt hoặc tên miền. Các mã dùng BCP 47 như `en`, `vi`, `en-US`, `ja`, `zh-Hant`, `ar`. Tối đa 10 ngôn ngữ đích; không trùng bản gốc hoặc trùng nhau sau chuẩn hóa.

```js
const AIConfig = {
  mount: '#ai-tools',
  form: '#article-form',
  languages: { source: 'en', targets: ['vi', 'ja'] },
  fields: {
    Title: '[name="name[$lang]"]',
    SeoTitle: '[name="seo[title][$lang]"]',
    FocusKeyword: '[name="seo[focus_keyword][$lang]"]',
    Keywords: '[name="seo[keywords][$lang]"]',
    Content: '[name="content[$lang]"]',
  },
};
window.AIWriter.mount(AIConfig);
```

Widget thay mọi `$lang` trong selector bằng mã ngôn ngữ đang xử lý: `name[$lang]` thành `name[en]`, `name[vi]` hoặc `name[ja]`. Mã dùng trong tên trường giữ nguyên cách khai báo của website, còn mã gửi API được chuẩn hóa BCP 47. Chỉ cần khai báo `fields` một lần, không cần lặp `fieldsByLocale` cho từng ngôn ngữ.

Selector không chứa `$lang` chỉ áp dụng cho bản gốc khi dùng mapping tự động. Ví dụ `Slug: '[name="slug"]'` giữ slug dùng chung ở bản gốc, các bản dịch không ghi đè trường này. Nếu slug đa ngôn ngữ thì dùng `Slug: '[name="slug[$lang]"]'`. Quy tắc tương tự áp dụng cho SEO.

`fieldsByLocale` vẫn được hỗ trợ khi một ngôn ngữ có tên trường khác quy luật. Khi khai báo, mapping đó thay toàn bộ mapping của locale tương ứng; có thể chứa selector cố định hoặc `$lang`. Hai ngôn ngữ không được trỏ vào cùng phần tử form. Selector phải khớp đúng một phần tử, nên các input/textarea tương ứng cần có trên form.

Có thể map thêm `Desc`, `Description`, `Keywords`, `FocusKeyword`. Với rich editor, truyền `{selector, setValue, getValue}`; selector vẫn dùng `$lang`, hai callback nhận đúng phần tử sau khi thay ngôn ngữ. `getValue(element)` trả chuỗi nội dung mới nhất từ editor. Khi thiếu `getValue`, widget đọc giá trị input/textarea. Cấu hình không khai báo `languages` tiếp tục hỗ trợ selector cố định như trước.

`Title` là tên bài/H1, còn `SeoTitle` là tiêu đề SEO riêng. Widget hiển thị và điền hai giá trị độc lập, đồng thời gửi cả hai trong snapshot để dịch. Bài cũ chưa có `SeoTitle` dùng `Title` làm dự phòng. Chỉ thêm mapping vào ô SEO thực tế của website; selector SEO không chứa `$lang` chỉ áp dụng cho bản gốc.

`FocusKeyword` của bản gốc giữ từ khóa đã nhập. Bản dịch mới trả `FocusKeyword` là từ khóa chính đã chuyển ngữ và `Keywords` là các từ khóa liên quan trong ngôn ngữ đích. Widget điền đúng từng ô theo locale, không lấy phần tử đầu `Keywords` làm từ khóa chính. Status API khi `ready` trả `keyword` theo từ khóa của kết quả; bản ghi yêu cầu gốc vẫn được giữ. Kết quả lịch sử chưa có `FocusKeyword` tiếp tục dùng từ khóa yêu cầu làm dự phòng; tạo lại bản dịch để có dữ liệu đã chuyển ngữ.

## Quy trình

1. Bấm **Viết bài AI**, chọn và nhập tiêu chí rồi bấm **Viết ngay**. Ngôn ngữ gốc lấy từ AIConfig.
2. CRM trả bản gốc vào popup xem trước; form website chưa thay đổi.
3. Chọn **Áp dụng** để điền ngay bản gốc, hoặc **Dịch sang các ngôn ngữ khác** để tạo toàn bộ ngôn ngữ đích đã cấu hình.
4. Khi chọn dịch, widget gửi bản gốc đang xem trước, không đọc nội dung cũ trên form. CRM giữ dữ kiện, tên riêng, HTML và URL; không chạy lại nghiên cứu/dàn ý hoặc ép số từ/điểm SEO.
5. Dịch xong có thể đổi ngôn ngữ xem trước; phần thao tác chỉ còn nút **Áp dụng**. Bấm một lần để điền bản gốc và toàn bộ bản dịch vào đúng trường. Khi đích đã có nội dung, widget hỏi trước khi thay thế.
6. Sau khi áp dụng, bấm Viết bài AI sẽ trở về tiêu chí để bắt đầu một bài mới. Không có thao tác dịch tiếp bài đã áp dụng.

Mỗi bản gốc/bản dịch là một job riêng, tính một lượt nếu dùng gói dịch vụ. Retry mạng giữ nguyên body và Idempotency-Key để nhận lại cùng job; các bản đã hoàn tất được giữ lại. Một bản dịch lỗi không làm thay đổi form. Khi chưa dịch đủ các ngôn ngữ đích, bấm **Thử lại bản dịch** để hoàn tất trước khi áp dụng. Sau khi áp dụng vẫn lưu bài qua chức năng hiện có của website.

Giao diện widget hiện dùng tiếng Việt. Ngôn ngữ giao diện độc lập với ngôn ngữ nội dung. Preview hỗ trợ chiều RTL cho các locale phổ biến. Khi dịch sang ngôn ngữ dùng hệ chữ ngoài Latin, CRM tạo slug phiên âm bằng chữ Latin không dấu, số và dấu gạch ngang, tối đa 75 ký tự. Website quyết định đường dẫn từ slug khi lưu. Báo cáo SEO dùng checklist chung của CRM.

## Dữ liệu gửi CRM

Mỗi lần tạo job gửi `languages`, `locale` (ngôn ngữ kết quả), và khi chuyển ngữ gửi `translation_source`:

```json
{
  "languages": { "source": "en", "targets": ["vi", "ja"] },
  "locale": "vi",
  "translation_source": {
    "Title": "Approved English title",
    "SeoTitle": "Read the reviewed English article",
    "Content": "<p>The edited and reviewed English text.</p>"
  }
}
```

Các trường viết bài khác vẫn giữ nguyên. Snapshot hỗ trợ thêm `Desc`, `Description`, `Keywords`; `Content` tối đa 120.000 đơn vị chuỗi JavaScript, yêu cầu JSON tối đa 512 KiB qua widget. Chữ ký máy chủ ràng buộc toàn bộ cấu hình ngôn ngữ và snapshot. CRM kiểm tra mã locale, tính duy nhất, ngôn ngữ đích thuộc danh sách và bản gốc bắt buộc khi dịch. Không khai báo `languages` thì giữ hành vi tiếng Việt của tích hợp cũ.

## Laravel

```blade
@php
    $aiFields = [
        'Title' => '[name="name[$lang]"]',
        'SeoTitle' => '[name="seo[title][$lang]"]',
        'FocusKeyword' => '[name="seo[focus_keyword][$lang]"]',
        'Keywords' => '[name="seo[keywords][$lang]"]',
        'Content' => '[name="content[$lang]"]',
    ];
@endphp
<x-crm-ai::writer
    form="#article-form"
    :fields="$aiFields"
    :languages="['source' => 'en', 'targets' => ['vi']]"
/>
```

Với bộ Laravel dạng chép file, đặt `AIConfig.languages` trực tiếp trong `resources/views/admin/layouts/js.blade.php` và điều chỉnh selector theo form của website. Mẫu component phía trên dành cho package Composer. Trong PHP, dùng chuỗi nháy đơn để giữ nguyên `$lang`, tránh PHP nội suy biến. File JS mẫu hỗ trợ callback CKEditor. Các trường SEO/slug dùng chung giữa các ngôn ngữ chỉ map vào bản gốc. Bản dịch luôn lấy bản gốc đang xem trước trong cùng lượt viết; không dùng bài đã áp dụng làm nguồn.

## PHP thuần

```php
echo $widget->render([
    'authorize_url' => '/admin/crm-authorize.php',
    'form' => '#article-form',
    'languages' => ['source' => 'en', 'targets' => ['vi']],
    'fields' => [
        'Title' => '[name="name[$lang]"]',
        'SeoTitle' => '[name="seo[title][$lang]"]',
        'Content' => '[name="content[$lang]"]',
    ],
], $csrf);
```

Nâng cả package và script CRM khi bật đa ngôn ngữ. Từ 1.1.1 hỗ trợ selector mẫu `$lang` trong cả hai package. Package từ 1.1.0 tăng giới hạn endpoint cấp chữ ký để nhận snapshot nội dung; giữ cơ chế xác thực, quyền biên tập và CSRF của website.

Khi bổ sung tiêu đề SEO cho website đã tích hợp, thêm `SeoTitle` vào mapping đang được sử dụng thực tế: `AIConfig.fields`, `aiFields` của từng trang, `fieldsByLocale` hoặc `fields_by_locale` trong options PHP. Mapping riêng thay toàn bộ mapping chung; chỉ sửa mẫu chung sẽ không cập nhật được trang đang dùng mapping riêng. Bỏ phần code cũ sao chép `Title` sang ô SEO, tải lại trang và kiểm tra một bài mới cùng các bản dịch trước khi lưu.
