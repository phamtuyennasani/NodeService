import { useState } from 'react';
import { App, Button, Collapse, Space, Tabs, Tag } from 'antd';
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { signedFetch, useResource } from './api';
import { ResourceError } from './shared';
import type { Website } from './types';
import laravelGuide from './laravel-guide.json';
import phpGuide from './php-guide.json';

type Platform = 'laravel' | 'php';
type Release = { platform: Platform; version: string; filename: string; compatibility: string; bytes: number; sha256: string };
const { provider: providerSnippet, files: laravelFiles, form: formSnippet, widget: widgetSnippet } = laravelGuide;
const multilingualFieldsSnippet = `languages: {
  source: 'vi',
  targets: ['en', 'ja'],
},
fields: {
  Title: '[name="ten[$lang]"]',
  SeoTitle: '[name="seo[title][$lang]"]',
  Content: '[name="noidung[$lang]"]',
  Desc: '[name="mota[$lang]"]',
  Slug: '[name="slug[$lang]"]',
  Description: '[name="seo[description][$lang]"]',
  Keywords: '[name="seo[keywords][$lang]"]',
  FocusKeyword: '[name="seo[focus_keyword][$lang]"]',
},`;
const singleLanguageFieldsSnippet = `languages: { source: 'vi', targets: [] },
fields: {
  Title: '[name="ten"]',
  SeoTitle: '[name="seo[title]"]',
  Content: '[name="noidung"]',
  Desc: '[name="mota"]',
  Slug: '[name="slug"]',
  Description: '[name="seo[description]"]',
  Keywords: '[name="seo[keywords]"]',
  FocusKeyword: '[name="seo[focus_keyword]"]',
},`;
const pageFieldsSnippet = `@include('crm-ai.writer', ['aiFields' => [
  'Title' => '[name="ten[$lang]"]',
  'SeoTitle' => '[name="seo[title][$lang]"]',
  'Content' => '[name="noidung[$lang]"]',
  'Desc' => '[name="mota[$lang]"]',
  'Slug' => '[name="slug[$lang]"]',
  'Description' => '[name="seo[description][$lang]"]',
  'Keywords' => '[name="seo[keywords][$lang]"]',
  'FocusKeyword' => '[name="seo[focus_keyword][$lang]"]',
]])`;
const seoTitleFieldSnippet = `SeoTitle: '[name="seo[title][$lang]"]',`;
const phpSeoTitleFieldSnippet = `'SeoTitle' => '[name=seo_title]',`;
const customButtonCss = `.crm-ai-launch {
  background: #2455d6;
  color: #fff;
  border: 0;
  border-radius: 6px;
  padding: 8px 14px;
  font: inherit;
  cursor: pointer;
}`;

export function laravelConnectionConfig(siteId: string, token: string) {
  return `'connection' => '${window.location.origin}|${siteId}|${token}',`;
}

export function IntegrationGuide({ website, copy }: { website: Website; copy: (text: string) => Promise<void> }) {
  const releases = useResource<{ data: Release[] }>('/integrations');
  const [downloading, setDownloading] = useState<Platform | null>(null);
  const { message } = App.useApp();

  async function download(release: Release) {
    setDownloading(release.platform);
    try {
      const response = await signedFetch(`/integrations/${release.platform}/${release.version}/download`);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = release.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) { message.error((error as Error).message); }
    finally { setDownloading(null); }
  }

  function releaseInfo(platform: Platform) {
    const release = releases.data?.data.find(item => item.platform === platform);
    return <>
      <ResourceError error={releases.error} onRetry={releases.reload} />
      <Space wrap>
        {release && <><Tag>Phiên bản {release.version}</Tag><span>{release.compatibility} · {Math.ceil(release.bytes / 1024)} KB</span></>}
        <Button type="primary" icon={<DownloadOutlined />} loading={downloading === platform}
          aria-label={`Tải ZIP ${platform === 'laravel' ? 'Laravel' : 'PHP thuần'}`}
          disabled={!release || downloading !== null} onClick={() => release && void download(release)}>
          Tải ZIP {platform === 'laravel' ? 'Laravel' : 'PHP thuần'}
        </Button>
        <Button aria-label={`Kiểm tra bản cập nhật ${platform === 'laravel' ? 'Laravel' : 'PHP thuần'}`}
          icon={<ReloadOutlined />} loading={releases.loading} onClick={releases.reload}>Kiểm tra cập nhật</Button>
      </Space>
      <p>ZIP gồm mã nguồn, cấu hình mẫu và README. Bấm Kiểm tra cập nhật để lấy phiên bản mới nhất và tải lại.</p>
      <p>Bấm Viết bài AI, nhập tiêu chí và nhận bản gốc trong cửa sổ xem trước. Chọn <strong>Áp dụng</strong> để điền ngay bản gốc,
        hoặc <strong>Dịch sang các ngôn ngữ khác</strong> để tạo tất cả ngôn ngữ đích đã cấu hình. Dịch xong chỉ còn nút Áp dụng để điền toàn bộ phiên bản vào form.
        Sau khi áp dụng, lần bấm Viết bài AI tiếp theo sẽ bắt đầu một lượt viết mới.</p>
      <h3>Tên bài và tiêu đề SEO</h3>
      <p><code>Title</code> là tên bài viết/H1; <code>SeoTitle</code> là tiêu đề SEO riêng cho thẻ HTML <code>title</code>.
        Map hai khóa vào hai ô khác nhau trên form. <code>Desc</code> là tóm tắt, còn <code>Description</code> là mô tả SEO.</p>
      <p>Bài mới và bản dịch có cả hai tiêu đề trong cửa sổ xem trước, API lấy kết quả và webhook.
        Bài lịch sử chưa có <code>SeoTitle</code> dùng <code>Title</code> làm dự phòng; tải lại bài cũ không tự tạo tiêu đề SEO mới.</p>
      <p><code>FocusKeyword</code> là từ khóa chính của từng ngôn ngữ: bản gốc giữ từ khóa đã nhập, bản dịch dùng từ khóa đã chuyển ngữ.
        <code>Keywords</code> là danh sách từ khóa liên quan đã chuyển ngữ. Map cả hai bằng selector có <code>$lang</code> nếu mỗi ngôn ngữ có ô riêng;
        không sao chép lại từ khóa gốc vào các bản dịch hoặc lấy phần tử đầu của <code>Keywords</code> để thay từ khóa chính.</p>
    </>;
  }

  const phpConfig = JSON.stringify({ url: window.location.origin, site_id: website.id, token: '<token-website>',
    editor_origin: `https://${website.domain}`, allow_localhost: false }, null, 2);

  return <Tabs className="integration-guide" defaultActiveKey="laravel" items={[
    { key: 'laravel', label: 'Laravel', children: <>
      {releaseInfo('laravel')}
          <h3>Chép bộ tích hợp Laravel 10–13</h3>
          <p>Giải nén bộ Laravel và chép các file theo đúng đường dẫn dưới đây trong website.</p>
          <pre className="code-block">{laravelFiles}</pre>
          <p>Trong <code>app/Providers/AppServiceProvider.php</code>, thêm dòng sau vào phương thức <code>register()</code>.</p>
          <pre className="code-block">{providerSnippet}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(providerSnippet)}>Sao chép dòng đăng ký</Button>

          <h3>Cấu hình kết nối</h3>
          <p>Mở <code>config/crm-ai.php</code> và điền <code>connection</code>. Khi cấp token, CRM có nút <strong>Sao chép connection</strong>. Nếu đã giữ token, thay phần <code>{'<token-website>'}</code> trong mẫu sau. Trang biên tập cần mở trên tên miền <strong>{website.domain}</strong>.</p>
          <pre className="code-block">{laravelConnectionConfig(website.id, '<token-website>')}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(laravelConnectionConfig(website.id, '<token-website>'))}>Sao chép mẫu connection</Button>
          <p>Đặt <code>middleware</code> trong config theo đăng nhập admin của website, ví dụ <code>['auth:admin']</code> khi dùng guard admin. Tài khoản đã đăng nhập được dùng tính năng AI.</p>
          <p>Mở trang cấu hình qua <code>route('crm-ai.settings')</code>, mặc định là <code>/crm-ai/settings</code>. Tạo khóa máy chủ rồi đăng ký khóa công khai ở tab <strong>Kết nối API</strong>. Trang này cũng có ba ô <strong>Base URL</strong>, <strong>API key</strong> và <strong>Model</strong>.</p>

          <h3>Gắn vị trí nút trong form bài viết</h3>
          <p>Đặt ID form là <code>news-main-form</code>, có <code>@csrf</code>, rồi chép dòng sau cạnh nút lưu.</p>
          <pre className="code-block">{formSnippet}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(formSnippet)}>Sao chép vị trí nút</Button>
          <h3>Đặt AIConfig trong layout admin</h3>
          <p>Chép cả đoạn sau vào <code>resources/views/admin/layouts/js.blade.php</code>, ngoài các thẻ script đang có. Nạp file này ở cuối layout admin bằng <code>@include('admin.layouts.js')</code>.</p>
          <p>Mẫu JS khai báo <code>languages</code> và tám mapping trong <code>fields</code>, gồm cả <code>SeoTitle</code> và <code>FocusKeyword</code>. Đổi <code>mount</code>, <code>form</code> và các selector theo HTML thực tế; bỏ mapping của những trường form không có.</p>
          <h3>Fields cho form nhiều ngôn ngữ</h3>
          <p>Dùng <code>$lang</code> cho các trường có phiên bản riêng theo ngôn ngữ. Ví dụ form dùng <code>ten</code>, <code>noidung</code>, <code>mota</code>:</p>
          <pre className="code-block">{multilingualFieldsSnippet}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(multilingualFieldsSnippet)}>Sao chép cấu hình đa ngôn ngữ</Button>
          <p>Widget thay <code>$lang</code> bằng mã ngôn ngữ để tìm <code>ten[vi]</code>, <code>ten[en]</code>, <code>ten[ja]</code> và các trường tương ứng. Các trường phải có trong form, kể cả ở tab đang ẩn. Đặt <code>source</code> và <code>targets</code> theo ngôn ngữ website thực sự hỗ trợ. Trang dùng <code>name</code> đổi selector tiêu đề thành <code>{`[name="name[$lang]"]`}</code>.</p>
          <h3>Fields cho form một ngôn ngữ</h3>
          <p>Đặt <code>targets: []</code> và dùng selector đúng tên input của trang:</p>
          <pre className="code-block">{singleLanguageFieldsSnippet}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(singleLanguageFieldsSnippet)}>Sao chép cấu hình một ngôn ngữ</Button>
          <p>Nếu slug dùng chung trong form đa ngôn ngữ, đặt <code>{`Slug: '[name="slug"]'`}</code>. Selector cố định chỉ được điền từ bản gốc; các bản dịch không ghi đè slug chung. Quy tắc tương tự áp dụng cho SEO dùng chung.</p>
          <p>Giữ nguyên các khóa <code>Title</code> (tên bài/H1), <code>SeoTitle</code> (tiêu đề SEO), <code>Content</code> (nội dung), <code>Desc</code> (mô tả ngắn), <code>Slug</code>, <code>Description</code> (mô tả SEO), <code>Keywords</code> (các từ khóa liên quan, ngăn cách bằng dấu phẩy) và <code>FocusKeyword</code> (từ khóa chính của từng ngôn ngữ). <code>FocusKeyword</code> được điền riêng, không lấy từ danh sách <code>Keywords</code>.</p>
          <p>Chỉ khai báo những trường muốn điền; mỗi selector cần khớp đúng một trường trong form. Nếu form không có ô SEO hoặc từ khóa chính, bỏ các mapping tương ứng. <code>Content</code> và <code>Desc</code> tự hỗ trợ CKEditor.</p>
          <p>Nếu nhiều trang dùng chung layout nhưng khác tên trường, truyền <code>aiFields</code> khi đặt nút ở từng trang:</p>
          <pre className="code-block">{pageFieldsSnippet}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(pageFieldsSnippet)}>Sao chép fields theo trang</Button>
          <p><code>aiFields</code> thay toàn bộ <code>AIConfig.fields</code> cho trang đó; ngôn ngữ vẫn lấy từ <code>AIConfig.languages</code> trong layout. Form một ngôn ngữ có thể truyền selector cố định như mẫu trên. Khi cập nhật bộ cũ, chép lại các view <code>crm-ai/writer.blade.php</code>, <code>admin/layouts/js.blade.php</code> từ ZIP mới và điều chỉnh cấu hình theo form.</p>
          <p>Để tự CSS nút Viết bài AI, đổi <code>customStyle: false</code> thành <code>customStyle: true</code> trong AIConfig.
            Nút có class <code>.crm-ai-launch</code> nằm trong HTML của website; popup tiếp tục dùng CSS riêng của widget. Thêm CSS vào stylesheet admin, ví dụ:</p>
          <p>Có thể thêm <code>{"customClass: 'btn btn-primary'"}</code> để gắn class vào nút.
            Khi dùng cùng <code>customStyle: true</code>, nút có <code>{'class="crm-ai-launch btn btn-primary"'}</code> và nhận CSS của website.</p>
          <pre className="code-block">{customButtonCss}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(customButtonCss)}>Sao chép CSS nút</Button>
          <p>Mẫu AIConfig và script đầy đủ. Khai báo <code>languages</code> và <code>fields</code> ngay đầu file; mẫu có cả <code>SeoTitle</code>, <code>Description</code>, <code>Keywords</code>, <code>FocusKeyword</code>. Đổi selector theo form và bỏ những trường không có:</p>
          <pre className="code-block">{widgetSnippet}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(widgetSnippet)}>Sao chép AIConfig và script</Button>
      <h3>Cập nhật bộ Laravel</h3>
      <p>Sao lưu trước khi cập nhật. Chép các file dịch vụ, controller, middleware, provider, route và view của bộ mới.
        Giữ giá trị connection, prefix và middleware trong <code>config/crm-ai.php</code>;
        đối chiếu AIConfig với form hiện tại khi ghép <code>js.blade.php</code>.
        Giữ nguyên <code>storage/app/private/crm-ai/</code> và <code>APP_KEY</code>, rồi làm mới cache cấu hình, route và view theo quy trình của website.</p>
      <h3>Thêm tiêu đề SEO vào website đang tích hợp</h3>
      <ol>
        <li>Ghép lại <code>admin/layouts/js.blade.php</code> từ ZIP mới và giữ selector, callback editor, ngôn ngữ đã tùy chỉnh.</li>
        <li>Thêm mapping dưới đây vào <code>AIConfig.fields</code>. Nếu trang truyền <code>aiFields</code> hoặc dùng <code>fieldsByLocale</code>, thêm <code>SeoTitle</code> vào mapping đó vì nó thay toàn bộ mapping chung.</li>
        <li>Bỏ đoạn callback cũ sao chép tên bài sang ô SEO. Với form một ngôn ngữ hoặc SEO dùng chung, dùng selector cố định như <code>{`[name="seo[title]"]`}</code>.</li>
        <li>Tải lại trang biên tập và viết bài mới. Kiểm tra hai ô tiêu đề trước khi lưu; nếu website nhận webhook, lưu <code>SeoTitle</code> vào trường SEO riêng và giữ nguyên mảng kết quả khi chuyển tiếp API.</li>
      </ol>
      <pre className="code-block">{seoTitleFieldSnippet}</pre>
      <Button icon={<CopyOutlined />} onClick={() => void copy(seoTitleFieldSnippet)}>Sao chép mapping tiêu đề SEO Laravel</Button>
    </> },
    { key: 'php', label: 'PHP thuần', children: <>
      {releaseInfo('php')}
      <h3>Giải nén và nạp thư viện</h3>
      <p>Giải nén ZIP vào thư mục thư viện riêng, ngoài document root. Gói có <code>autoload.php</code>, không cần cài Composer.
        Website cần PHP 8.2 trở lên cùng cURL, OpenSSL và JSON.</p>
      <h3>Cấu hình và tạo khóa máy chủ</h3>
      <p>Chép <code>config.example.json</code> thành <code>private/crm-ai.json</code> ngoài document root và Git, điền token đã cấp ở tab Kết nối API.
        <code> editor_origin</code> là origin chính xác của trang admin, gồm HTTPS và cổng nếu có.</p>
      <pre className="code-block">{phpConfig}</pre>
      <Button icon={<CopyOutlined />} onClick={() => void copy(phpConfig)}>Sao chép cấu hình PHP</Button>
      <p>Chạy từ thư mục chứa <code>autoload.php</code> của gói; thay đường dẫn config bằng đường dẫn thật.</p>
      <pre className="code-block">php bin/crm-ai install --config=/path/to/private/crm-ai.json</pre>
      <p>Dán khóa công khai lệnh in ra vào <strong>Kết nối API → Đăng ký khóa ký</strong>.
        Có thể lấy lại bằng lệnh <code>php bin/crm-ai public-key --config=/path/to/private/crm-ai.json</code>.</p>
      <h3>Gắn vào trang biên tập và endpoint ký</h3>
      <p>ZIP có ba file hoàn chỉnh trong <code>examples/</code>. Dùng bootstrap đăng nhập và session hiện có của website;
        sửa callback <code>$canWrite</code>, đường dẫn autoload, config và URL <code>authorize_url</code> theo website.
        Endpoint ký phải dùng cùng kiểm tra đăng nhập, session và CSRF như trang biên tập.</p>
      <p>Mẫu bootstrap đọc <code>CRM_AUTOLOAD_PATH</code> và <code>CRM_CONFIG_PATH</code> từ môi trường server.
        Hoặc sửa hai đường dẫn ngay trong file khi tích hợp. Các đoạn dưới đây được lấy trực tiếp từ file trong ZIP.</p>
      <Collapse items={(['bootstrap', 'editor', 'authorize'] as const).map(name => ({ key: name, label: `examples/${name}.php`, children: <>
        <pre className="code-block">{phpGuide[name]}</pre>
        <Button aria-label={`Sao chép ${name}.php`} icon={<CopyOutlined />} onClick={() => void copy(phpGuide[name])}>Sao chép {name}.php</Button>
      </> }))} />
      <p>Chỉnh <code>form</code> và <code>fields</code> trong <code>{'$widget->render()'}</code> theo form.
        Đa ngôn ngữ và nhóm bài gốc có ví dụ trong <code>docs/multilingual.md</code> và <code>docs/article-groups.md</code> của ZIP.</p>
      <p>Để tự CSS nút viết bài, thêm <code>{"'customStyle' => true"}</code> vào options của <code>{'$widget->render()'}</code>,
        rồi CSS class <code>.crm-ai-launch</code> trong stylesheet website. Có thể thêm <code>{"'customClass' => 'btn btn-primary'"}</code> để gắn thêm class. Popup vẫn dùng CSS riêng.</p>
      <p>Để dùng key AI riêng, tạo ba ô Base URL, API key và Model trong admin, lưu bằng <code>CredentialsStore</code>,
        truyền <code>{'$credentials->read()'}</code> vào widget như file mẫu. README có ví dụ lưu kèm kiểm tra đăng nhập và CSRF của website.</p>
      <h3>Cập nhật bộ PHP</h3>
      <p>Sao lưu rồi thay mã thư viện bằng ZIP mới. Giữ config, token, khóa ký, khóa mã hóa và dữ liệu trong thư mục private;
        ghép lại các thay đổi riêng ở bootstrap và trang biên tập. Lệnh install chạy lại sẽ giữ khóa đang có.</p>
      <h3>Thêm tiêu đề SEO vào form PHP</h3>
      <p>Trong <code>{'$widget->render()'}</code>, thêm mapping dưới đây vào <code>fields</code> và bảo đảm form có ô <code>seo_title</code>.
        Đổi selector theo HTML thực tế. Với form đa ngôn ngữ, dùng <code>{`[name="seo[title][$lang]"]`}</code> và bổ sung khóa này vào các mapping <code>fields_by_locale</code> đang dùng.</p>
      <pre className="code-block">{phpSeoTitleFieldSnippet}</pre>
      <Button icon={<CopyOutlined />} onClick={() => void copy(phpSeoTitleFieldSnippet)}>Sao chép mapping tiêu đề SEO PHP</Button>
      <p>Tải lại trang và viết bài mới, kiểm tra tên bài và tiêu đề SEO được điền riêng.
        Khi nhận webhook hoặc lấy kết quả qua API, lưu <code>SeoTitle</code> vào trường SEO, không gán lại từ <code>Title</code>.</p>
    </> },
  ]} />;
}
