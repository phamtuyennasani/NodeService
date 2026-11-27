# NodeService

NodeService là CRM tiếng Việt để quản lý yêu cầu viết bài AI, lịch viết, bản viết lại và các bản dịch theo từng website. Website Laravel hoặc PHP thuần có thể gọi API và gắn widget vào trang biên tập. CRM theo dõi hạn mức, chi phí AI và việc giao bài theo lịch qua webhook. Giao diện dùng React, Ant Design và Recharts, API dùng Fastify và dữ liệu lưu trong MongoDB.

## Chạy dịch vụ

Khuyến nghị Node.js 24 LTS. Dùng MongoDB Atlas hoặc MongoDB 7 trở lên chạy dưới dạng replica set hoặc sharded cluster để hỗ trợ transaction và change stream. Khi chạy cục bộ, có thể dùng replica set một nút. Lệnh `npm run build` cần Python 3 gọi được bằng `python` để đóng gói các bộ tích hợp.

```sh
npm ci
npx playwright install --with-deps chromium --only-shell
cp .env.example .env
openssl rand -base64 32
```

Điền chuỗi vừa tạo vào `ENCRYPTION_KEY`, địa chỉ MongoDB vào `MONGODB_URI` và URL CRM vào `APP_ORIGIN`. Với cấu hình mẫu cục bộ, khởi động MongoDB với `--replSet rs0`, chạy `rs.initiate()` trong `mongosh` một lần và đợi nút trở thành PRIMARY. Tài khoản MongoDB cần quyền tạo collection và quản lý chỉ mục trong cơ sở dữ liệu của ứng dụng. Giữ cùng một khóa mã hóa cho các tiến trình dùng chung cơ sở dữ liệu. Có thể đặt `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` hoặc `XAI_API_KEY` cho cấu hình cũ. Cách quản lý mới là mở **Nhà cung cấp AI** trong CRM, chọn **Cấu hình key** hoặc **Cấu hình kết nối**, rồi nhập key. NodeService mã hóa key bằng `ENCRYPTION_KEY` trước khi ghi vào MongoDB và chỉ hiển thị trạng thái đã cấu hình.

Đặt `CRM_ADMIN_EMAIL` trong `.env` thành địa chỉ đã xác minh của quản trị viên trước khi tạo tài khoản. Khai báo cấu hình SMTP trong `.env` để CRM gửi OTP tới địa chỉ này khi đăng nhập lần đầu.

```sh
npm run migrate
npm run admin -- quantri
npm run build
npm start
```

Khi phát triển, dùng `npm run dev:watch` để theo dõi mã nguồn, tự chạy lại build và khởi động lại dịch vụ sau mỗi thay đổi.

Trong **Yêu cầu viết → Chi tiết**, nút **Xuất PDF** xuất hiện khi đã có nội dung bài viết. File PDF A4 giữ tiêu đề, danh sách, bảng và CSS inline an toàn; dàn ý đứng trước, bài viết bắt đầu ở trang mới. Không có dàn ý thì chỉ xuất bài viết. Nội dung dài tự nối trang để giữ đủ chữ, không ép vào đúng hai trang. Chromium headless ở bước cài đặt trên cần có trên máy/container chạy API cả khi cài bằng `npm ci --omit=dev`; không tự tải trình duyệt trong lúc xử lý yêu cầu. Linux cần các thư viện hệ thống do `--with-deps` cài đặt. Mỗi tiến trình giới hạn hai lượt render đồng thời, mỗi lượt tối đa 25 giây, 60 trang và 20 MB; API yêu cầu phiên CRM hợp lệ cùng chữ ký trình duyệt, giới hạn 6 lượt/phút cho mỗi khóa giới hạn lưu lượng hiện có. Nội dung HTML được lọc, tắt JavaScript và chặn tải mạng khi xuất.

Đăng nhập trên thiết bị mới yêu cầu OTP gửi tới email đã xác minh của tài khoản. Vào **Cài đặt → Email / SMTP** để cấu hình máy chủ, cổng, bảo mật, email gửi và thông tin đăng nhập SMTP; cổng 465 thường dùng TLS trực tiếp, cổng 587 dùng STARTTLS bắt buộc. Có thể dùng các biến `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` và cặp `SMTP_USER`/`SMTP_PASSWORD` để khởi tạo khi chưa có cấu hình trong CRM. Không ghi OTP hoặc thông tin SMTP vào log. Khi tạo tài khoản bằng CLI, có thể cấp sẵn hộp thư do người vận hành đã xác minh qua `CRM_ADMIN_EMAIL`. Khi nâng cấp lên OTP, phiên đã gắn khóa trình duyệt và vẫn hợp lệ tiếp tục dùng được đến hạn thông thường: mở **Tài khoản** để xác minh email sau khi cấu hình SMTP, trước khi đăng xuất. Đăng nhập từ thiết bị chưa tin cậy không bỏ qua OTP khi thiếu email đã xác minh hoặc SMTP. Nếu không còn phiên hợp lệ, người vận hành cấp email bằng `npm run admin:email -- <username>` với `CRM_ADMIN_EMAIL` và mật khẩu hiện tại (nhập ẩn hoặc `CRM_ADMIN_PASSWORD`); lệnh này thu hồi toàn bộ phiên, thiết bị tin cậy và yêu cầu OTP cũ, không thay mật khẩu. Không đặt bí mật trực tiếp trong command line. Chi tiết xem [hướng dẫn bảo mật](docs/security.md).

Mở CRM và đăng nhập. Trong **Nhà cung cấp AI**, chọn OpenAI, Anthropic, xAI hoặc **OpenAI Compatible** để thêm mã model, đặt tên hiển thị và bật các model muốn cung cấp. OpenAI, Anthropic và xAI dùng **Cấu hình key** để nhập API key. Với OpenAI Compatible, mở **Cấu hình kết nối**, nhập Base URL của API tương thích OpenAI và API key. Ở bản cài mới, GPT-4.1 được bật sẵn. Sau đó cấu hình **Khách hàng**, **Website** và **Bảng giá model**. Thêm model vào danh sách cho phép khi cấu hình gói dịch vụ. [Mở CRM ở localhost](http://localhost:3210/)

Trong **Website → Kết nối API**, chọn **Cấp token** để lấy thông tin kết nối, rồi chọn **Đăng ký khóa ký** để dán khóa công khai do backend website tạo. Nếu website nhận bài theo lịch, dùng **Cấp khóa webhook** để lấy khóa xác minh webhook.

Để dùng nhiều API tương thích OpenAI, mở tab dạng kết nối **OpenAI Compatible** trong **Nhà cung cấp AI**, rồi bấm **Thêm provider**. Các provider nằm trong danh sách bên trong tab này; chọn một provider để quản lý cấu hình và model của nó. Mỗi kết nối có tên, Base URL, API key mã hóa và danh sách model riêng; **Kiểm tra kết nối** và ping model dùng đúng kết nối đang chọn. Hai provider có thể dùng cùng mã model API: CRM lưu mã nội bộ riêng để cấp quyền khách hàng, lên lịch và tính giá chính xác, rồi gửi mã model API thực khi gọi upstream. Widget hiển thị thêm tên kết nối để phân biệt. Cấu hình OpenAI Compatible cũ được hiển thị là **Kết nối mặc định** nếu chưa đổi tên; các lịch/model đã có được giữ nguyên. Các giới hạn OpenAI Compatible trong **Cài đặt** áp dụng riêng cho từng kết nối, với cửa sổ đồng thời/phút độc lập.

`npm start` chạy CRM, API, worker viết và worker giao bài trong cùng tiến trình. Khi triển khai thành các tiến trình độc lập, khởi chạy các lệnh sau và dùng chung `.env`. Chạy từ thư mục dự án để dịch vụ tìm được bản build và các migration.

```sh
npm start -- api
npm start -- writer
npm start -- webhook
```

Khi nâng cấp từ bản cũ, dừng các tiến trình NodeService bản cũ trước khi chạy `npm run migrate` và khởi động bản mới. Migration thay chỉ mục token website và xóa trường `keyAI` dạng rõ khỏi các job cũ, đồng thời giữ các khóa đã mã hóa.

Khi vận hành qua HTTPS, đặt `NODE_ENV=production` và `APP_ORIGIN` bằng URL HTTPS thực tế của CRM. `GET /health` kiểm tra kết nối MongoDB. Mở **Hệ thống → Cài đặt** để điều chỉnh số luồng viết/giao, thời gian chờ, số lần thử, nghiên cứu và giới hạn theo nhà cung cấp mà không cần sửa code hoặc khởi động lại. Các giá trị `.env` như `WORKER_CONCURRENCY`, `WEBHOOK_CONCURRENCY` và các biến `*_CONCURRENCY`, `*_REQUESTS_PER_MINUTE`, `*_TOKENS_PER_MINUTE` là mặc định khi chưa lưu cấu hình CRM. Giới hạn nhà cung cấp được phối hợp qua MongoDB; số luồng viết/giao tính trên mỗi tiến trình đang chạy.

Xem [hướng dẫn bảo vệ CRM và triển khai reverse proxy](docs/security.md) trước khi mở dịch vụ ra Internet. Bản này bổ sung giới hạn lưu lượng/kết nối, chống dò mật khẩu dùng chung MongoDB, kiểm tra origin/CSRF và bảo vệ nội dung HTML. Phiên CRM yêu cầu cả cookie và chữ ký từ private key WebCrypto không cho xuất của trình duyệt; sao chép cookie đơn thuần không đủ truy cập. Thao tác nhạy cảm cần nhập lại mật khẩu cho từng lần thực hiện. Nâng cấp đồng bộ API/CRM và chạy migration; phiên cũ chưa gắn khóa phải đăng nhập lại, còn phiên đã gắn khóa hợp lệ có thể hoàn tất thiết lập email như hướng dẫn ở trên. Production cần HTTPS, WebCrypto và IndexedDB. Cơ chế này không bảo vệ tuyệt đối khi mã độc điều khiển chính trình duyệt. Giới hạn trong Node.js không thay thế CDN/WAF hoặc bảo vệ DDoS của hạ tầng.

Khi thử với Laravel trên máy cục bộ, đặt `ALLOW_LOCAL_WEBHOOKS=true` để gửi webhook đến địa chỉ nội bộ.

Mỗi yêu cầu viết ngay, viết lại hoặc theo lịch tự chạy qua nghiên cứu khi được bật, lập dàn ý, viết bản nháp và kiểm tra SEO. Trường `use_research` cho phép chọn có dùng dữ liệu tìm kiếm web làm tư liệu hay không. Mặc định là `true` để giữ nguyên hành vi hiện có; đặt `false` để bỏ qua lượt tìm kiếm cho yêu cầu đó. Nếu dàn ý lỗi hoặc vượt ngân sách prompt, worker tiếp tục viết từ yêu cầu và tư liệu nghiên cứu. Với cảnh báo tiêu đề, mô tả, slug, vị trí từ khóa, độ dài và khả năng đọc có thể sửa, hệ thống thử chỉnh tối đa hai lượt; chỉ tiếp tục lượt thứ hai nếu lượt đầu đã sửa được tiêu chí nhưng vẫn còn lỗi có thể sửa. Chỉ nhận bản chỉnh khi có tiêu chí tốt hơn và không làm mất tiêu chí đã đạt. Độ dài dùng ngân sách yêu cầu ±15%, trong giới hạn 600–2.500 từ. Đây là checklist biên tập nội bộ; mật độ từ khóa và việc thiếu liên kết nội bộ không tự kích hoạt lượt AI để tăng điểm. Cảnh báo SEO không làm bài viết bị lỗi. Bản nháp hợp lệ được lưu trước lượt chỉnh để phục hồi và giao bài nếu tiến trình gián đoạn.

### Nội dung tạo với hỗ trợ AI

Chính sách viết áp dụng cho cả dàn ý, bài mới/viết lại và lượt chỉnh sửa: giải đáp nhu cầu người đọc, có giá trị bổ sung từ cách giải thích và dữ liệu có thật; không tạo biến thể hàng loạt chỉ để lấy thứ hạng, không bịa tác giả/chuyên môn/trải nghiệm hay xác nhận đã được kiểm duyệt. Tiêu đề và mô tả phải khớp nội dung, không giật tít hoặc thêm lời hứa thiếu căn cứ. Độ dài là mục tiêu theo chủ đề, không ép lặp từ hoặc thêm nội dung đệm cho đủ điểm. Nghiên cứu hiện tại là trích đoạn tìm kiếm, chưa phải toàn văn hay kiểm chứng độc lập; không đủ căn cứ thì bỏ khẳng định, không giả vờ đã xác minh hoặc gọi thông tin là mới nhất.

Trước khi xuất bản, người biên tập phải kiểm tra toàn bộ bài, tiêu đề, mô tả, ngày áp dụng, thông tin tác giả và liên kết; bổ sung dữ liệu/trải nghiệm thực tế được phép sử dụng và rà soát bài trùng chủ đề. Các tư liệu hoặc ghi chú trong dàn ý không thay thế bước đối chiếu nguồn gốc. CRM không thực hiện kiểm chứng sự thật tự động, không chứng nhận tuân thủ Google và không bảo đảm thứ hạng. Nhãn **Đã viết/Đã giao** chỉ là trạng thái xử lý/giao webhook; Laravel nên lưu thành bản nháp để con người duyệt trước khi xuất bản. Điểm SEO vẫn giữ cấu trúc tương thích Laravel và chỉ là checklist nội bộ.

Website nên cân nhắc giải thích cách dùng tự động hóa ở vị trí phù hợp với độc giả (ví dụ trang quy trình biên tập); chỉ nêu người duyệt, bằng cấp và việc đã kiểm chứng khi có thật. Hệ thống không tự chèn một tuyên bố đã được chuyên gia kiểm duyệt vào bài. Nếu dùng dữ liệu sản phẩm/hình ảnh AI trong Merchant Center hoặc thêm structured data/alt text ở Laravel, cần kiểm tra và thực hiện các yêu cầu riêng tương ứng; luồng bài viết này chưa triển khai các bước đó. Tham khảo [hướng dẫn dùng nội dung generative AI của Google](https://developers.google.com/search/docs/fundamentals/using-gen-ai-content).

Mục **Yêu cầu viết** hiển thị giai đoạn đang chạy, lịch sử từng lượt gọi AI và tab **Kiểm tra SEO** cho bài hoàn tất. **Tổng quan** hiển thị yêu cầu đang xử lý và số luồng đang hoạt động. Chi phí dàn ý, viết và chỉnh SEO được ghi riêng cho key dịch vụ. `AI_TIMEOUT_MS` là thời gian tối đa không nhận dữ liệu stream. Mỗi chunk mới gia hạn timeout này. `AI_OUTLINE_TIMEOUT_MS` và `AI_SEO_REPAIR_TIMEOUT_MS` cho phép đặt riêng thời gian chờ khi không nhận chunk cho dàn ý và chỉnh SEO. Dàn ý mặc định theo `AI_TIMEOUT_MS`, còn chỉnh SEO mặc định 90 giây.

CRM nhận thay đổi job, chi phí AI và trạng thái giao webhook qua SSE từ MongoDB change stream, kể cả khi API và worker chạy ở các tiến trình riêng. Danh sách chỉ tải lại thông tin của job thay đổi; khi kết nối được khôi phục hoặc quay lại tab, CRM đối chiếu lại dữ liệu để bù các sự kiện bị lỡ. Trang Tổng quan kiểm tra thêm hoạt động hiện tại mỗi 10 giây và báo cáo mỗi 60 giây khi tab hiển thị, để cập nhật heartbeat và bù gián đoạn sự kiện mà không tải lại cả trang.

**Tổng quan** ưu tiên lỗi viết, lỗi giao bài và lease cần phục hồi. Các cảnh báo và hàng đợi theo khách hàng/website, độc lập khoảng ngày; chỉ số sản lượng và chi phí theo kỳ đã chọn. Worker gửi heartbeat vào `worker_heartbeats` mỗi 5 giây, hết hiệu lực sau 15 giây: số tiến trình và tổng luồng nhận việc là toàn hệ thống, tách khỏi cấu hình luồng mỗi tiến trình. Lượt kiểm tra / xử lý đang chạy bao gồm kiểm tra hàng đợi và phục hồi lease. Worker đang drain hoặc không đọc được cài đặt vẫn báo còn sống nhưng không cộng vào công suất nhận việc. Trạng thái kết nối trực tiếp dựa trên SSE; snapshot hoạt động quá 30 giây báo chưa cập nhật được. Bộ lọc Tổng quan được giữ trong URL để tải lại hoặc dùng Back/Forward.

Nút **Xem dạng lịch** cạnh **Làm mới** mở lịch bài viết theo tháng, giữ bộ lọc khách hàng/website và bắt đầu ở tháng cuối của khoảng ngày báo cáo. Mỗi ngày có số bài **Lên lịch**, **Đã viết** và **Đã giao**; chọn ngày để xem đủ 24 giờ, chuyển ngày hoặc trở lại tháng. Số lên lịch tính theo giờ hẹn và bỏ yêu cầu đã hủy; số đã viết tính theo giờ hoàn tất thành công; số đã giao tính theo giờ giao thành công đầu tiên của mỗi bài trong ngày. Tất cả dùng giờ Việt Nam (UTC+7), bao gồm cả bài dùng key cá nhân vì đây là số liệu hoạt động, không phải chi phí. Lịch tự cập nhật khi nhận sự kiện bài viết, khi quay lại tab và theo chu kỳ báo cáo; có nút làm mới thủ công. Dữ liệu tổng hợp lấy từ `GET /api/crm/dashboard/calendar?month=YYYY-MM&date=YYYY-MM-DD` (`date` là tùy chọn để lấy số liệu giờ), không bị giới hạn bởi phân trang danh sách.

CRM chỉ ghi nhận chi phí AI cho các bài dùng **key dịch vụ theo hạn mức được cấp**, hiển thị bằng **Việt Nam đồng (₫)** trên dashboard, danh sách yêu cầu và từng lượt gọi. **Key cá nhân không theo dõi chi phí**, kể cả dữ liệu chi phí key cá nhân còn lưu từ trước cũng không được cộng vào báo cáo. Đặt số VND cho 1 USD tại **Cài đặt → Vận hành**; `USD_TO_VND` trong `.env` (mặc định `25000`) chỉ là giá trị khởi tạo. Đây là tỷ giá do quản trị viên đặt, không tự cập nhật theo thị trường. Chi phí dịch vụ vẫn lưu USD và được quy đổi khi đọc báo cáo, vì vậy tỷ giá mới cũng áp dụng cho chi phí lịch sử đang hiển thị. Các tổng được cộng trước khi làm tròn để hiển thị; chi phí dương dưới 1 đồng hiển thị `< 1 ₫`, còn chi phí chưa xác định hiển thị `Chưa có dữ liệu chi phí`. CRM không yêu cầu thao tác đối soát.

### Cài đặt vận hành và lưu trữ

Cấu hình CRM được lưu trong collection `runtime_settings`, dùng chung cho các máy kết nối cùng database, kiểm tra lại tối đa mỗi 5 giây. Lưu cấu hình có kiểm tra phiên bản để tránh hai quản trị viên ghi đè thay đổi của nhau. Tác vụ đang chạy giữ cấu hình lúc nhận việc; giảm số luồng không hủy tác vụ đó. Số lần thử gồm lần đầu tiên và được xét khi kết thúc lần chạy hoặc phục hồi lease; một lần thử đã chờ trong hàng đợi vẫn có thể được xử lý sau khi giảm giới hạn. Nút **Điền mặc định** chỉ điền biểu mẫu từ cấu hình khởi động của máy API hiện tại, cần bấm **Lưu cài đặt** để áp dụng.

Tab **Email / SMTP** có nút lưu riêng và **Kiểm tra kết nối** cho cấu hình đã lưu. Kiểm tra chỉ kết nối/TLS/xác thực SMTP, không gửi email và không xác nhận email sẽ vào hộp thư. Cấu hình lưu riêng tại `crm_mail_settings`, ưu tiên hơn biến môi trường, áp dụng ngay cho lượt gửi OTP tiếp theo. Mật khẩu được mã hóa bằng `ENCRYPTION_KEY` và không trả lại qua API; để trống giữ mật khẩu cũ khi máy chủ, cổng, chế độ bảo mật và tài khoản SMTP không đổi. Thay một trong các thông tin này cần nhập lại mật khẩu nếu có dùng xác thực. Để trống tài khoản SMTP sẽ bỏ thông tin đăng nhập, chỉ dùng cho máy chủ chuyển tiếp cho phép gửi không cần xác thực. Lưu và kiểm tra SMTP đều yêu cầu xác nhận mật khẩu tài khoản CRM. Sau khi lưu SMTP, mở **Tài khoản** để xác minh email nhận OTP.

**Lưu trữ dữ liệu** mặc định tắt tự xóa (`0` ngày). Có thể đặt riêng thời gian lưu yêu cầu viết và lịch sử giao bài. Dọn dẹp chỉ chọn yêu cầu hoàn thành/thất bại/đã hủy, bỏ qua lượt giao đang chờ/đang gửi và bài nguồn còn được yêu cầu viết lại đang chờ/đang viết sử dụng. Xóa yêu cầu sẽ xóa nội dung bài, lịch sử AI, lượt giao và chi phí liên quan, ảnh hưởng báo cáo lịch sử; hạn mức đã tiêu thụ vẫn giữ nguyên. Chỉ xóa lịch sử giao không xóa bài viết. Bật hoặc rút ngắn thời gian lưu cần xác nhận trong giao diện.

Các tiến trình `api`, `writer`, `webhook` đều có thể dọn dẹp với lịch và lease phối hợp qua MongoDB. Đợt đầu chờ hết chu kỳ sau khi lưu; mỗi đợt xử lý tối đa 50 yêu cầu và 100 lượt giao độc lập để tránh giao dịch quá lớn. Backlog lớn cần nhiều chu kỳ. Kết nối database, `ENCRYPTION_KEY`, tên miền/cổng, cấu hình bảo mật và khóa bí mật vẫn ở biến môi trường; API key nhà cung cấp được quản lý tại **Nhà cung cấp AI**. Không đổi `ENCRYPTION_KEY` khi thay các cài đặt vận hành.

Xóa bài đã hoàn tất không hoàn lại lượt viết đã dùng trong kỳ. Xóa yêu cầu còn chờ sẽ giải phóng lượt giữ tương ứng.

## Tích hợp Laravel và PHP thuần

Trong **Website → chọn website → Hướng dẫn tích hợp**, CRM hiển thị phiên bản, đoạn cấu hình mẫu và nút tải ZIP cho hai bộ sau.

- **Laravel 10–13** dùng bộ chép file vào ứng dụng và chỉnh `AIConfig` theo form biên tập. [Hướng dẫn bộ Laravel](integrations/laravel-upload/README.md)
- **PHP thuần 8.2+** dùng Composer hoặc autoloader trong ZIP, có HTTP client tự ký, helper widget và trang mẫu. [Hướng dẫn bộ PHP thuần](packages/php-crm-ai/README.md)

Các ZIP được tạo trong `dist/packages` khi build. Laravel cũng có thể tích hợp qua package Composer riêng với Blade component và lệnh Artisan. [Package Composer cho Laravel](packages/laravel-crm-ai/README.md) · [Quy trình đóng gói ZIP](docs/integration-downloads.md)

## API cho website

Để chèn liên kết nội bộ, nhập **URL danh mục liên kết** HTTPS công khai cùng tên miền website, lưu rồi chọn **Kiểm tra danh mục**. Endpoint trả JSON dạng `{ "items": [...] }` với `id`, `url`, `title`, `summary` và `categories` tùy chọn cho mỗi mục. Website chỉ cung cấp trang đã xuất bản cùng URL canonical thực. API đẩy `POST /v1/site-content` vẫn dùng được khi chưa cấu hình URL danh mục. [Hướng dẫn cấu hình danh mục](docs/laravel-internal-links.md)

Trước lượt viết, CRM lấy danh mục và lưu vào bộ nhớ đệm trong năm phút. CRM so khớp từ khóa và ngữ cảnh dàn ý với tiêu đề, tóm tắt và danh mục để chọn tối đa 8 ứng viên. AI có thể chọn tối đa 3 trang đích trong chính lượt viết. CRM đối chiếu các URL trước khi lưu bài. Tab **Liên kết nội bộ** trong chi tiết yêu cầu hiển thị kết quả đối chiếu theo danh mục. [Cách chọn và kiểm tra liên kết](docs/laravel-internal-links.md)

Backend website gửi header `Authorization: Bearer <site_token>` và `Accept: application/json`. Khi tạo một yêu cầu, sinh một mã duy nhất, lưu cùng yêu cầu và gửi mã đó qua `Idempotency-Key`. Dùng lại mã khi thử gửi cùng yêu cầu sau lỗi mạng.

Sau nâng cấp, website cần đăng ký khóa công khai EC P-256 tại **Website → Kết nối API → Đăng ký khóa ký**. Các API dùng site token yêu cầu thêm `X-Site-Proof` do khóa riêng của backend website ký. Với bộ Laravel, mở `route('crm-ai.settings')` (mặc định `/crm-ai/settings`, tùy prefix đã cấu hình), tạo khóa máy chủ rồi sao chép khóa công khai để đăng ký. Xem [cách ký yêu cầu và chống dùng lại cho PHP](docs/security.md#khóa-ký-máy-chủ-website). Widget lấy chữ ký từng lượt qua endpoint PHP đã xác thực trước khi gửi trực tiếp tới CRM.

| Thao tác | Endpoint | Payload hoặc kết quả |
| --- | --- | --- |
| Tạo lịch | `POST /v1/article-jobs` | Gửi trường viết và `scheduled_at` theo ISO 8601 có múi giờ. HTTP 202 trả `job_id` và `version`. |
| Viết ngay | `POST /v1/article-jobs` | Gửi trường viết cùng `mode: "preview"`. HTTP 202 trả `job_id`. |
| Tra cứu yêu cầu | `GET /v1/article-jobs/{job_id}` | Trả trạng thái, thời điểm và lỗi nếu có. Trạng thái `ready` cho biết có thể lấy bài. |
| Lấy bài | `GET /v1/article-jobs/{job_id}/result` | HTTP 200 trả trực tiếp mảng có một đối tượng bài viết. HTTP 202 báo còn chờ. |
| Danh sách bài | `GET /v1/articles` | Lọc bằng `from`, `to` dạng `YYYY-MM-DD`, `q`, `limit` và `cursor`. |
| Danh sách lịch | `GET /v1/schedules` | Lọc bằng `from`, `to`, `status`, `limit` và `cursor`. Mặc định lấy lịch đang chờ. |
| Sửa hoặc dời lịch | `PATCH /v1/schedules/{job_id}` | Gửi các trường cần đổi và header `If-Match: "<version>"`. HTTP 412 yêu cầu tải lại phiên bản mới. |
| Hủy lịch | `DELETE /v1/schedules/{job_id}` | HTTP 204 xác nhận hủy hoặc đã hủy từ trước. |
| Viết lại | `POST /v1/articles/{article_id}/rewrites` | Mã yêu cầu mới, có thể gửi `instructions`. Kế thừa model của bài gốc; key cá nhân gửi `base_url` và `api_key`, luôn dùng OpenAI Compatible. |
| Lấy model khả dụng | `GET /v1/models` | Trả `{ "key_mode": "service", "data": [{ "provider": "openai", "model": "gpt-4.1", "display_name": "GPT-4.1" }] }`. `key_mode` lấy từ khách hàng sở hữu site token hiện tại. Với key riêng, website thấy các model đang bật của nhà cung cấp đang bật. Với key dịch vụ, danh sách còn lọc theo gói khách và key dịch vụ đã cấu hình. |
| Xem hạn mức | `GET /v1/usage` | Trả gói, số lượt dùng, lượt giữ và còn lại theo kỳ. Có thể chọn `date=YYYY-MM-DD`. |

Các danh sách trả `{ data, next_cursor }`. Giữ nguyên bộ lọc và gửi `next_cursor` làm `cursor` để lấy trang kế tiếp. Lịch đang viết hoặc đã kết thúc trả HTTP 409 khi yêu cầu sửa hoặc hủy. Dời lịch giữ nguyên mã công việc và chuyển lượt giữ sang kỳ mới. Nếu kỳ mới hết lượt, HTTP 429 và giờ hẹn cũ vẫn còn hiệu lực.

Khi ngừng cung cấp model hoặc tắt nhà cung cấp, yêu cầu viết mới, viết lại và đổi lịch sang model đó sẽ bị từ chối. Lịch đã nhận vẫn chạy bằng nhà cung cấp đã lưu. Nếu gói còn cho phép, bạn có thể dời lịch đó với cùng model.

Mẫu dữ liệu tạo lịch cho khách dùng gói dịch vụ

```json
{
  "model": "gpt-4.1",
  "keyword": "cách chọn máy lọc nước",
  "tone": "thân thiện",
  "style": "hướng dẫn từng bước",
  "length": 800,
  "use_research": true,
  "scheduled_at": "2027-03-22T09:00:00+07:00"
}
```

`use_research` là tùy chọn boolean trong payload tạo yêu cầu và dời lịch. Khi tạo mới, bỏ qua trường này sẽ dùng `true`. Khi sửa hoặc dời lịch, bỏ qua trường này sẽ giữ lựa chọn hiện tại. Yêu cầu viết lại kế thừa lựa chọn của bài nguồn.

Với key riêng, website cấu hình **Base URL, API key, Model** trong quản trị Laravel. Backend gửi `base_url`, `api_key` và `model`; CRM luôn dùng chuẩn **OpenAI Compatible**, không cần tạo provider/model trong CRM. Base URL HTTPS công khai dài tối đa 500 ký tự, ví dụ `https://api.example.com/v1`, không có tài khoản/query/fragment và không thêm `/chat/completions`. Model là mã API thực tế của nhà cung cấp. Trường `keyAI` cũ vẫn được hỗ trợ thay `api_key`, nhưng yêu cầu mới vẫn cần Base URL. CRM không lưu kết nối riêng trong hồ sơ khách hàng/nhà cung cấp và không tính chi phí các lượt gọi này. Để worker chạy bất đồng bộ và theo lịch, endpoint và key được mã hóa cùng nhau trong `jobs.encrypted_key` cho đến khi job kết thúc hoặc bị hủy. Sửa lịch giữ kết nối cũ nếu không gửi thay đổi; đổi Base URL phải nhập lại key. Job cũ đã xếp hàng trước nâng cấp vẫn được worker xử lý theo cấu hình cũ.

Với key dịch vụ, đặt đơn giá theo **VND trên một triệu token** và chọn mốc hiệu lực trong CRM. Dịch vụ giữ đơn giá VND đã nhập và dùng tỷ giá trong **Cài đặt** tại thời điểm lưu để quy đổi sang USD phục vụ tính chi phí; các phiên bản giá cũ giữ nguyên tỷ giá đã ghi. Giá đồng bộ từ nhà cung cấp được quy đổi theo tỷ giá đang cấu hình. Khi xAI trả chi phí theo request, dịch vụ ghi nhận chi phí đó. Nếu thiếu usage hoặc biểu giá, chi phí chưa xác định và không được coi là miễn phí; hệ thống không tạo cảnh báo hoặc quy trình đối soát.

```json
[
  {
    "Title": "Cách chọn máy lọc nước",
    "Content": "<p>Xác định nguồn nước và nhu cầu sử dụng.</p>",
    "Slug": "cach-chon-may-loc-nuoc",
    "Desc": "Các bước để chọn máy lọc nước.",
    "Description": "Hướng dẫn chọn máy lọc nước theo nhu cầu.",
    "Keywords": ["máy lọc nước", "chọn máy lọc nước"]
  }
]
```

## Nhận webhook trong Laravel

CRM gửi webhook cho bài theo lịch. Với yêu cầu xem trước, lấy bài qua endpoint kết quả. Khai báo route POST nhận webhook từ Node.js. Đọc nội dung nguyên gốc qua `$request->getContent()` trước khi giải mã JSON. Xác nhận chữ ký bằng khóa webhook của đúng website.

```php
$raw = $request->getContent();
$timestamp = (string) $request->header('X-Timestamp');
abort_unless(ctype_digit($timestamp) && abs(time() - (int) $timestamp) <= 300, 401);

$event = (string) $request->header('X-Article-Event');
$eventId = (string) $request->header('X-Event-Id');
$jobId = (string) $request->header('X-Job-Id');
$requestId = (string) $request->header('X-Client-Request-Id');
$signingMessage = implode("\n", [$timestamp, $event, $eventId, $jobId, $requestId, $raw]);
$expected = 'sha256=' . hash_hmac('sha256', $signingMessage, $webhookSecret);
abort_unless(hash_equals($expected, (string) $request->header('X-Signature')), 401);

$body = json_decode($raw, true, 512, JSON_THROW_ON_ERROR);
```

Với `article.ready`, body là mảng bài viết. Dùng `X-Client-Request-Id` để tìm yêu cầu Laravel đã ghi khi lên lịch. Trong một giao dịch, khóa bản ghi yêu cầu, kiểm tra `X-Job-Id`, lưu bản nháp và mã bài. Sau khi giao dịch lưu thành công, trả HTTP 2xx với JSON:

```json
{"success": true, "id_post": 123}
```

`success` phải đúng boolean `true`. `id_post` là số nguyên dương an toàn trong JavaScript, hoặc chuỗi ID không rỗng tối đa 160 ký tự không có ký tự điều khiển. Với ID số lớn, trả chuỗi để không mất độ chính xác. CRM ghi lại `id_post` và thời điểm xác nhận trong lần giao và lịch sử từng lần thử; giao diện **Giao bài** hiển thị các thông tin này. HTTP 2xx đơn thuần, HTML, JSON sai, `success:false` hoặc thiếu ID đều chưa được coi là giao thành công. CRM chỉ đọc phản hồi tối đa 64 KiB trong thời hạn webhook; không lưu toàn bộ body phản hồi.

Nếu Laravel chưa xác nhận hợp lệ hoặc lỗi kết nối/HTTP, CRM gửi lại tối đa **3 lần sau lần đầu** (tổng cộng 4 lần). Khoảng chờ cố định mặc định **5 phút**, chỉnh tại **Cài đặt → Khoảng chờ gửi lại (phút)** từ 1 đến 1.440 phút; giá trị mặc định môi trường là `WEBHOOK_RETRY_MINUTES=5`. Thay đổi áp dụng khi worker xử lý lần tiếp theo, không dời lại thời điểm các lượt đã được lên lịch. Sau lần thứ tư vẫn không có xác nhận, trạng thái giao là lỗi và có thể gửi lại thủ công. Lỗi cấu hình URL/địa chỉ mạng không được phép hoặc khóa ký không hợp lệ cần sửa cấu hình trước, không tự gửi lặp. Bài đã viết và chi phí AI không bị thay đổi bởi việc thử giao lại.

Webhook có thể được gửi lại nếu Laravel đã lưu nhưng CRM không nhận được phản hồi hoặc tiến trình bị ngắt. Giữ `X-Event-Id`/`X-Job-Id` làm khóa chống tạo trùng: nếu đã lưu bài cho sự kiện/yêu cầu đó, trả lại **cùng** `id_post` với `success:true`, giữ nội dung biên tập viên. Chỉ trả xác nhận sau khi lưu thành công; không tạo bài mới mỗi lần retry.

Với `article.failed`, body chứa `{ "error": { "code": "...", "message": "..." } }`. Lưu trạng thái lỗi trên lịch và trả HTTP 2xx sau khi đã lưu; sự kiện này không yêu cầu `id_post`. Cài đặt **Số lần báo lỗi tối đa** chỉ áp dụng sự kiện `article.failed`.

## Gắn widget vào trang biên tập

Trang biên tập tải script từ CRM bằng URL đã ký, sau đó gọi CRM trực tiếp để lấy model, tạo yêu cầu viết và xem kết quả. CRM xử lý bằng cùng worker với **Viết bài ngay** trong mục **Yêu cầu viết**. Lấy đoạn nhúng tương ứng trong tab **Hướng dẫn tích hợp** của website.

Bộ [Laravel dạng chép file](integrations/laravel-upload/README.md) dùng kết nối trong `config/crm-ai.php` và AIConfig tại `resources/views/admin/layouts/js.blade.php`. Mỗi website điều chỉnh mapping theo form của mình, gồm hỗ trợ CKEditor, trường đa ngôn ngữ và tùy chọn `customStyle`, `customClass` cho nút viết bài. CRM sinh đoạn hướng dẫn JS từ chính file mẫu khi build.

Ví dụ cấu hình cho form có bản gốc tiếng Việt và bản dịch tiếng Nhật. Đặt khối này ở đầu script mẫu của bộ Laravel và chỉnh các selector theo HTML thực tế.

```js
const AIConfig = {
  mount: '#news-ai-writer',
  form: '#news-main-form',
  customStyle: false,
  customClass: '',
  languages: { source: 'vi', targets: ['ja'] },
  fields: {
    Title: '[name="name[$lang]"]',
    Content: '[name="content[$lang]"]',
    Desc: '[name="desc[$lang]"]',
    Slug: '[name="slug[$lang]"]',
    Description: '[name="seo[description][$lang]"]',
    Keywords: '[name="seo[keywords][$lang]"]',
    FocusKeyword: '[name="seo[focus_keyword][$lang]"]',
  },
};
```

Widget thay `$lang` bằng mã ngôn ngữ của từng bản, ví dụ `name[vi]` và `name[ja]`. Giữ các khóa trong `fields` và đổi selector bên phải khi form dùng tên khác. Nếu form dùng `ten[vi]`, `noidung[vi]` và `mota[vi]`, đặt `Title`, `Content` và `Desc` lần lượt thành `'[name="ten[$lang]"]'`, `'[name="noidung[$lang]"]'` và `'[name="mota[$lang]"]'`. Mỗi selector đã khai báo phải khớp đúng một trường trong form. `Desc` là mô tả ngắn, `Description` là mô tả SEO. Widget điền `Keywords` từ danh sách từ khóa của bài và điền `FocusKeyword` riêng từ từ khóa chính của yêu cầu.

Form một ngôn ngữ có thể dùng `targets: []` và selector cố định như `[name="name"]`. Với mapping tự động, `Slug: '[name="slug"]'` chỉ điền slug chung từ bản gốc. Nếu các trang Laravel dùng chung layout, có thể truyền `aiFields` khi include `crm-ai.writer` để thay mapping của từng trang. Widget hỗ trợ `fieldsByLocale` khi một ngôn ngữ cần mapping riêng. [Cấu hình fields và ngôn ngữ](integrations/laravel-upload/README.md#fields-và-ngôn-ngữ)

Với ứng dụng chọn dùng package Composer [nodeservice/laravel-crm-ai](packages/laravel-crm-ai/README.md), có thể cài package và dùng component hoặc đoạn Blade dưới đây cho mapping riêng. Đây là cách tích hợp Composer tùy chọn; bộ chép file dùng hướng dẫn ở liên kết phía trên. Các giá trị AI nhận `null` khi chưa cấu hình key riêng.

```blade
@php($crmAi = app(\NodeService\CrmAi\CrmAi::class))
@if ($widgetScript = $crmAi->scriptUrl())
@php($credentials = $crmAi->mountCredentials())
<div id="ai-tools"></div>
<script src="{{ $widgetScript }}" data-authorize-url="{{ route('crm-ai.authorize') }}"></script>
<script>
(() => {
  const config = {
    mount: '#ai-tools',
    form: '#article-form',
    base_url: @json($credentials['base_url']),
    api_key: @json($credentials['api_key']),
    model: @json($credentials['model']),
    fields: {
      Title: '[name="title"]',
      Content: '[name="body"]',
      Slug: '[name="slug"]',
      Desc: '[name="summary"]',
      Description: '[name="seo_description"]',
      Keywords: '[name="keywords"]',
      FocusKeyword: '[name="focus_keyword"]'
    }
  };
  window.AIWriter?.mount(config);
})();
</script>
@endif
```

Website có hạn mức được chọn model CRM cấp. Khi cấu hình đủ **Base URL**, **API key** và **Model** trong setting website, người viết có thể chọn **Dùng key riêng**. Lượt dùng key riêng kết nối theo chuẩn OpenAI Compatible và không trừ hạn mức hay tính chi phí CRM. Website chỉ được dùng key riêng luôn lấy model từ setting.

Backend website giữ site token và khóa ký riêng, tạo URL script đã ký và cấp chữ ký cho từng yêu cầu viết của widget. Luồng trực tiếp truyền key AI riêng vào `AIWriter.mount` trên trang biên tập có xác thực. [Hướng dẫn tích hợp Laravel](docs/laravel-widget.md)

Sau khi nhận bản xem trước, biên tập viên có thể **Áp dụng** bản gốc hoặc chọn **Dịch sang các ngôn ngữ khác** rồi áp dụng tất cả một lần. Mỗi bản dịch là một yêu cầu riêng. Bản dịch thành công tính một lượt khi dùng key dịch vụ. Worker dịch từ bản xem trước, giữ URL đích trong nội dung, dịch phần chữ của liên kết và bỏ qua bước nghiên cứu, dàn ý và chỉnh SEO tự động. CRM hiển thị bản gốc và các bản dịch trong **Yêu cầu viết → Nhóm theo bài gốc**. Sau khi áp dụng, biên tập viên lưu bài bằng chức năng của website. [Quy trình đa ngôn ngữ](docs/multilingual.md) · [Quản lý nhóm bài](docs/article-groups.md) · [Đồng bộ bộ chấm SEO](docs/laravel-seo.md)

### Slug của bản dịch

Khi tạo bản dịch sang ngôn ngữ dùng hệ chữ ngoài Latin, CRM yêu cầu AI phiên âm một cụm ngắn từ tiêu đề đã dịch theo cách đọc của ngôn ngữ đích. Slug kết quả viết thường, có tối đa 75 ký tự và chỉ gồm `a-z`, `0-9` và dấu gạch ngang. Tiêu đề, nội dung và metadata khác vẫn dùng ngôn ngữ đích. [Prompt và xử lý slug của worker](src/worker/provider.ts)

Nếu slug AI trả về không dùng được sau khi chuẩn hóa, CRM thử tạo slug ASCII từ tiêu đề bản dịch rồi đến tiêu đề bản gốc. Nếu cả hai tiêu đề đều không tạo được slug hợp lệ, CRM dùng một mã ổn định dạng `article-<mã>` để giữ bản dịch.

Ví dụ slug cho các bản dịch của bài **Cách pha cà phê Việt Nam**.

| Ngôn ngữ | Tiêu đề | Slug phiên âm mẫu |
| --- | --- | --- |
| Nhật (`ja`) | ベトナムコーヒーの淹れ方 | `betonamu-kohi-no-irekata` |
| Hàn (`ko`) | 베트남 커피 내리는 법 | `beteunam-keopi-naerineun-beop` |
| Trung giản thể (`zh`) | 如何冲泡越南咖啡 | `ruhe-chongpao-yuenan-kafei` |
| Lào (`lo`) | ວິທີຊົງກາເຟຫວຽດນາມ | `vithi-song-kafe-viat-nam` |
| Khmer (`km`) | របៀបឆុងកាហ្វេវៀតណាម | `robiep-chhong-kafe-viet-nam` |
| Nga (`ru`) | Как приготовить вьетнамский кофе | `kak-prigotovit-vyetnamskiy-kofe` |

Với `Slug: '[name="slug[$lang]"]'`, widget điền slug vào từng ô như `slug[ja]`. Website quyết định cấu trúc đường dẫn, chẳng hạn `/ja/betonamu-kohi-no-irekata`, và xử lý slug trùng khi lưu. Cách phiên âm thực tế có thể khác giữa các model.

### Xem widget cục bộ với dữ liệu CRM thật

Chạy CRM/API và worker bằng `npm start` (hoặc các tiến trình riêng như phần đầu), rồi mở terminal khác trong cùng dự án:

```sh
npm run dev:widget
```

Trang xem thử chạy tại `http://127.0.0.1:3220`, dùng `.env` hiện có và website trong MongoDB. Đặt `WIDGET_SITE_ID` theo ID của website dùng hạn mức dịch vụ trước khi chạy. Adapter cục bộ tạo job thật, gọi nhà cung cấp AI và dùng hạn mức của website. Để thử chữ ký và key riêng trên trang biên tập, xem [hướng dẫn kiểm tra tích hợp trên website](docs/laravel-widget.md#kiểm-tra-tích-hợp-trên-website).

Các worker dùng cùng MongoDB database sẽ cùng lấy việc từ một hàng đợi. Khi thử bản build local cạnh môi trường khác, dùng `MONGODB_DATABASE` riêng cho cả CRM/worker và widget preview để tránh worker cũ nhận bài. Nếu chủ ý chạy chung database, mọi worker cần cùng phiên bản và `ENCRYPTION_KEY`; chỉ khởi động lại API không cập nhật các worker bên ngoài.

CRM/API khởi tạo một giá trị kiểm tra mã hóa dùng chung trong `service_security` và xác thực lại mỗi lần khởi động. Worker và widget preview phải dùng đúng `ENCRYPTION_KEY` đó; sai khóa sẽ dừng trước khi nhận việc. Với database mới hoặc khi nâng cấp lần đầu, khởi động vai trò `api`/`all` trước rồi mới chạy worker. Không xóa giá trị kiểm tra hoặc tạo lại `ENCRYPTION_KEY` để bỏ qua lỗi: cần khôi phục khóa gốc, đồng bộ và khởi động lại **tất cả** tiến trình. Các worker phiên bản cũ chưa có kiểm tra này vẫn phải dừng/nâng cấp. Giá trị kiểm tra mới không khôi phục được API key đã mã hóa bằng một khóa khác trước đó; CRM hiển thị rõ key không đọc được để quản trị viên xử lý.

API từ chối nhận yêu cầu dùng key dịch vụ không giải mã được trước khi giữ quota. Nếu key thay đổi sau khi đã nhận bài, worker giữ job ở hàng đợi với mã `AI_KEY_UNREADABLE`, thử lại sau 60 giây và không tăng số lần thất bại hoặc xóa key riêng/quota. Sau khi sửa đúng cấu hình, job tiếp tục; quản trị viên có thể hủy job đang chờ theo cách thông thường. Lỗi xác thực do nhà cung cấp trả về vẫn được xử lý riêng.

## Kiểm thử

```sh
npm run typecheck
npm run build
npx playwright install chromium --only-shell
npm test
```

Kiểm thử dùng MongoDB tạm, phản hồi AI giả lập và trình duyệt Chromium.




