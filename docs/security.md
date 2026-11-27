# Bảo vệ CRM khi triển khai

Các lớp bảo vệ trong ứng dụng giảm khả năng làm cạn tài nguyên, dò mật khẩu, giả mạo yêu cầu và thực thi HTML độc hại. Chúng không bảo đảm ngăn mọi cuộc tấn công hoặc hấp thụ được DDoS làm đầy đường truyền. Bản cấu hình reverse proxy ở `deploy/nginx.conf.example` là mẫu cần chỉnh và kiểm tra trên máy triển khai; dự án không tự áp dụng firewall, chứng chỉ, CDN hay WAF.

## Khóa ký máy chủ website

Mỗi website dùng site token cùng một cặp khóa EC P-256 độc lập. Backend PHP giữ khóa riêng ngoài public root và Git. CRM lưu khóa công khai. Khi nâng cấp, migration bật yêu cầu chữ ký cho các website hiện có. Website mới cũng yêu cầu khóa ký. Lịch đã được CRM tiếp nhận tiếp tục chạy bằng worker.

Với bộ Laravel, mở `route('crm-ai.settings')` (mặc định `/crm-ai/settings`, tùy prefix đã cấu hình) và bấm **Tạo khóa máy chủ**, rồi sao chép khóa công khai tại cùng trang. Trong CRM, mở **Website → Kết nối API → Đăng ký khóa ký** và dán khóa công khai. Thay khóa yêu cầu phiên CRM hợp lệ và xác nhận mật khẩu như các thao tác nhạy cảm khác. Đổi token giữ khóa ký đã đăng ký. Giữ bản sao an toàn của khóa riêng khi chuyển server hoặc đăng ký khóa công khai mới sau khi đổi khóa.

API quản trị `PUT /api/crm/websites/{id}/signing-key` nhận `{ public_key, expected_fingerprint }`. Lần đầu gửi `expected_fingerprint: null`. Khi thay khóa, gửi vân tay đang hiển thị trên CRM để tránh ghi đè thay đổi đồng thời. API dùng site token không có quyền đăng ký hoặc thay khóa.

Các API `/v1` dùng Bearer token yêu cầu thêm `X-Site-Proof` khi website bật bảo vệ. Chữ ký ràng buộc method, nguyên path/query, origin, hash SHA-256 của đúng byte body, `Idempotency-Key`, `If-Match`, thời gian và nonce. Thời gian chấp nhận là 60 giây, dung sai đồng hồ tương lai 10 giây. Header có dạng `created.nonce.signature`, nonce là 16 byte ngẫu nhiên dạng hex, signature là ECDSA SHA-256 dạng DER, mã hóa base64url bỏ padding.

Ví dụ PHP dùng chung cho các framework, với token và khóa riêng lấy từ kho cấu hình backend.

```php
function crmRequestProof(string $siteId, string $token, string $privateKeyPem,
    string $method, string $target, string $body = '', string $origin = '',
    string $idempotencyKey = '', string $ifMatch = ''): string
{
    $created = (string) time();
    $nonce = bin2hex(random_bytes(16));
    $message = implode("\n", [
        'site-request-v1', $siteId, hash('sha256', $token), $method, $target,
        $origin, hash('sha256', $body), $idempotencyKey, $ifMatch, $created, $nonce,
    ]);
    if (!openssl_sign($message, $signature, $privateKeyPem, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('Cannot sign CRM request');
    }
    return $created.'.'.$nonce.'.'.rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');
}
```

Gửi đúng chuỗi `$body` đã ký, cùng các header tương ứng. Lượt gọi server-to-server thường dùng origin rỗng. Khi lấy quyền cho widget, backend ký origin trang biên tập và path `/v1/widget/{site_id}/previews`. Chỉ cấp quyền sau khi xác thực đăng nhập, quyền biên tập và CSRF. Script nhúng đặt `data-authorize-url` trỏ tới endpoint PHP cùng origin. Với bộ Laravel, lấy URL bằng `route('crm-ai.authorize')` (mặc định `POST /crm-ai/authorize`, tùy prefix đã cấu hình), nhận `{ body, id }` và trả `{ proof }`. Widget gửi nguyên body và mã yêu cầu tới CRM cùng chữ ký vừa cấp.

Chữ ký script có hạn một giờ phục vụ tải danh mục model. Với website đã bật bảo vệ, tạo bài cần chữ ký riêng cho từng yêu cầu. Nonce được lưu trong MongoDB dùng chung giữa các replica. Với thao tác ghi, ghi nonce và cập nhật dữ liệu/hạn mức nằm trong cùng transaction. Gửi lại cùng yêu cầu tạo bài cùng `Idempotency-Key` trả cùng job, giữ một lượt. Khi thử lại sau lỗi mạng, giữ nguyên body và mã yêu cầu, lấy chữ ký mới nếu chữ ký trước đã hết hạn. Nonce đã dùng cho yêu cầu khác trả `409 site_proof_replayed`. Kho chống replay lỗi trả `503`, thiếu/sai/hết hạn chữ ký trả `401`, website chưa đăng ký khóa trả `403`.

Nếu cả token và khóa riêng bị lấy, thu hồi token rồi thay token và cặp khóa. Khóa riêng luôn ở backend. API key AI riêng của luồng mount trực tiếp vẫn xuất hiện trong trang biên tập có xác thực theo cấu hình tích hợp.

## Đường vào dịch vụ

Đặt CDN/WAF có bảo vệ DDoS trước reverse proxy HTTPS. Chỉ cho phép lưu lượng từ các mạng CDN đã xác minh tới origin nếu dùng CDN; chặn truy cập thẳng origin bằng firewall của hạ tầng. Không mở cổng Node.js hoặc MongoDB công khai. Với Nginx cùng máy, giữ `HOST=127.0.0.1` và cho Nginx chuyển tiếp tới cổng 3210. Nếu khác máy/container, chỉ mở mạng nội bộ cần thiết và dùng kết nối được bảo vệ phù hợp.

Đặt `NODE_ENV=production`, `APP_ORIGIN=https://crm.ten-mien-cua-ban` đúng với origin trình duyệt đang mở, không chứa thông tin đăng nhập. Production yêu cầu HTTPS. Origin khác sẽ bị từ chối ở API quản trị; ngay cả subdomain cùng miền cũng không được tự gửi thao tác ghi. Vite proxy khi phát triển cũng cần `APP_ORIGIN` khớp origin giao diện. Widget tải từ CRM, lấy chữ ký từng yêu cầu qua backend PHP đã xác thực, rồi gửi trực tiếp tới nhóm API widget của CRM. API server-to-server dùng site token cùng chữ ký máy chủ. Phiên quản trị CRM phục vụ giao diện quản trị.

`TRUSTED_PROXIES` mặc định rỗng: không tin header chuyển tiếp do client gửi. Chỉ khai báo IP/CIDR của reverse proxy thực sự, ví dụ `127.0.0.1,::1` khi Nginx cùng máy. Không dùng `true`, số hop, wildcard hoặc CIDR toàn Internet. Mẫu Nginx ghi đè `X-Forwarded-For` bằng địa chỉ kết nối tới Nginx. Nếu thêm CDN, trước tiên cấu hình Real IP của Nginx chỉ tin dải IP chính thức của CDN và kiểm tra không thể giả mạo IP; không chuyển tiếp mù quáng header client tự đặt. Nếu chưa làm bước này, mọi khách có thể bị tính chung vào IP proxy/CDN.

## Giới hạn mặc định

Các biến này ở `.env`, cần khởi động lại API khi đổi. Giới hạn HTTP ở từng process; nhiều replica cần thêm giới hạn chung tại CDN/WAF hoặc reverse proxy.

| Biến | Mặc định | Phạm vi |
| --- | ---: | --- |
| `RATE_LIMIT_PER_IP` | 600/phút | Tất cả đường dẫn, kể cả 404 và tài nguyên tĩnh |
| `RATE_LIMIT_API_PER_IP` | 240/phút | `/api` và `/v1` |
| `RATE_LIMIT_WRITE_PER_IP` | 60/phút | Thao tác ghi tại `/api` và `/v1` |
| `RATE_LIMIT_GLOBAL` | 12.000/phút | Tổng yêu cầu được bộ lọc IP cho qua trên mỗi API process |
| `RATE_LIMIT_MAX_IPS` | 10.000 | Số bộ đếm IP tối đa trong bộ nhớ |
| `HTTP_MAX_CONNECTIONS` | 1.000 | Kết nối TCP trên mỗi API process |
| `HTTP_MAX_CONCURRENT_REQUESTS` | 200 | Yêu cầu đang mở, gồm SSE |
| `HTTP_MAX_CONCURRENT_PER_IP` | 20 | Yêu cầu đang mở của một IP/nhóm IPv6 |
| `HTTP_REQUEST_TIMEOUT_MS` | 15.000 | Nhận đầy đủ yêu cầu HTTP; không phải thời hạn chạy job AI |
| `HTTP_HEADERS_TIMEOUT_MS` | 10.000 | Nhận header HTTP |
| `HTTP_CONNECTION_TIMEOUT_MS` | 30.000 | Socket không hoạt động |
| `MAX_PENDING_JOBS_PER_CUSTOMER` | 100 | Tổng job `scheduled`, `queued`, `writing` của mỗi khách |

IPv4-mapped được chuẩn hóa; IPv6 gộp theo `/64` để hạn chế đổi địa chỉ né bộ đếm. Bộ nhớ đếm có trần và không loại bộ đếm còn hiệu lực chỉ để nhận IP mới. Khi đầy, IP mới có thể nhận 503 đến khi có chỗ. IP dùng chung qua NAT cũng dùng chung hạn mức; cần theo dõi tải thực tế trước khi tăng trần. Cửa sổ giới hạn HTTP là 60 giây, không phải một bộ điều tiết phân tán chính xác theo từng giây.

Node giới hạn body 1 MiB, body đăng nhập/đổi mật khẩu 8 KiB, header 16 KiB, 64 header, URL 2.048 ký tự và 100 yêu cầu trên một kết nối keep-alive. Mỗi phiên mở tối đa 4 kết nối cập nhật SSE, mỗi process tối đa 128. SSE kiểm tra lại phiên mỗi 25 giây, tự đóng sau 5 phút để trình duyệt kết nối lại, và đóng client đọc quá chậm. Các kết nối này vẫn chiếm giới hạn đồng thời. Job AI chạy ở worker, không giữ kết nối tạo job đến khi viết xong.

429/503 do bộ lọc trả `Retry-After`; client nên chờ, có backoff và tránh lặp tức thì. Đầy hàng đợi trả 429 `job_queue_full`, áp dụng cả key dịch vụ và key cá nhân, cả widget và CRM. Gửi lại cùng `Idempotency-Key` của yêu cầu đã nhận vẫn lấy được job cũ khi hàng đợi đầy. Không tăng trần chỉ để che một đợt flood.

## Tài khoản và phiên quản trị

- Mỗi tài khoản tối đa 10 lượt xác thực trong cửa sổ 5 phút, bao gồm tài khoản không tồn tại. Bộ đếm MongoDB dùng chung giữa các replica; TTL dọn dữ liệu hết hạn. Đăng nhập còn có giới hạn 10 yêu cầu/phút/IP tại endpoint.
- Đổi mật khẩu tối đa 5 lượt/5 phút; thao tác kiểm tra/băm mật khẩu tối đa 2 tác vụ đồng thời trên một API process. Yêu cầu vượt tải nhận 503 thay vì xếp hàng không giới hạn.
- Mật khẩu mới dài 12–256 ký tự, lưu bằng scrypt với salt. Dùng mật khẩu dài, riêng cho CRM; không chia sẻ tài khoản quản trị. Tài khoản CRM hiện là tài khoản quản trị, chưa có vai trò chi tiết.
- Production dùng cookie `__Host-crm_session`: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, không có `Domain`. Cookie cũ `crm_session` không được nhận trong production; sau nâng cấp cần đăng nhập lại. Dev giữ tên cookie cũ để chạy HTTP cục bộ.
- Nếu không chọn **Ghi nhớ đăng nhập**, cookie là cookie phiên trình duyệt, máy chủ vẫn áp dụng hạn tối đa 12 giờ hoặc 30 phút không có yêu cầu hợp lệ được ký. Nếu chọn ghi nhớ, cookie/phiên có hạn tối đa 30 ngày và hết hạn sau 7 ngày không hoạt động. Đổi mật khẩu thu hồi các phiên rồi tạo phiên mới trong transaction. Phiên gắn phiên bản mật khẩu để vô hiệu khi hash thay đổi ngoài luồng thông thường. Kiểm tra origin và token CSRF tiếp tục áp dụng cho thao tác ghi.

### OTP, thiết bị tin cậy và email tài khoản

Sau khi mật khẩu hợp lệ, thiết bị chưa được tin cậy phải nhập OTP 8 chữ số gửi tới email đã xác minh của tài khoản. OTP hết hạn sau 10 phút, chỉ dùng một lần, tối đa 5 lần nhập và chờ ít nhất 60 giây giữa các lượt gửi lại; mã gửi lại thay thế mã cũ. Giới hạn lượt/gửi email dùng dữ liệu MongoDB để phối hợp giữa các replica. Không cấp phiên CRM trước khi OTP hoàn thành. Mã OTP không được ghi log hoặc trả về API. Lỗi gửi mail trả lỗi dịch vụ an toàn; không bỏ qua OTP khi SMTP chưa cấu hình hoặc bị lỗi.

**Không hỏi lại trên thiết bị này** tin cậy thiết bị trong 30 ngày, chỉ sau khi xác minh OTP thành công. Thiết bị tin cậy gắn với khóa ký của trình duyệt; nó cho phép bỏ qua OTP ở các lần đăng nhập bằng mật khẩu tiếp theo, không tự cấp quyền chỉ từ cookie và không bỏ qua chữ ký yêu cầu/CSRF. Đây là lựa chọn riêng với **Ghi nhớ đăng nhập**, vốn điều chỉnh thời gian sống của phiên hiện tại. Không chọn hai tùy chọn này trên máy dùng chung. Email OTP không có khả năng chống phishing như passkey và không cứu được tài khoản khi cả email hoặc chính trình duyệt đã bị chiếm quyền.

Mục **Tài khoản** cho phép cập nhật thông tin tài khoản đăng nhập và email nhận OTP. Việc đổi email phải kiểm tra mật khẩu và xác minh hộp thư theo quy trình của CRM; không lấy email tự nhập chưa xác minh làm đích nhận OTP đăng nhập. Đổi mật khẩu/email và thu hồi thiết bị phải làm mất hiệu lực các phiên/challenge/trust cũ tương ứng. Tách biệt email quản trị trong `users` với email khách hàng trong `customers`; không dùng email khách hàng để xác thực tài khoản quản trị.

SMTP được cấu hình tại **Cài đặt → Email / SMTP**. Nhập host thuần (không chứa URL hoặc credential), email gửi thuần (không kèm tên), cổng và chế độ bảo mật: thường là 465 với TLS trực tiếp hoặc 587 với STARTTLS bắt buộc. Chứng chỉ luôn được kiểm tra, tối thiểu TLS 1.2; giao diện không có tùy chọn tắt TLS. Cấu hình được lưu riêng tại `crm_mail_settings`, có revision chống ghi đè, mật khẩu mã hóa AES-256-GCM với `ENCRYPTION_KEY`; API chỉ trả trạng thái đã có mật khẩu. Không đổi `ENCRYPTION_KEY` khi thay SMTP. Mật khẩu cũ chỉ được giữ khi host/cổng/chế độ bảo mật/tài khoản không đổi; đổi đích kết nối phải nhập lại mật khẩu để tránh chuyển bí mật cũ sang máy chủ khác. Xóa tài khoản SMTP sẽ xóa thông tin đăng nhập đã lưu. Lưu và kiểm tra kết nối được bảo vệ bằng phiên có chữ ký, CSRF và xác nhận mật khẩu CRM cho từng thao tác; kiểm tra kết nối có giới hạn lượt và không gửi email. Kết nối thành công chưa xác nhận quyền gửi từ địa chỉ From hoặc khả năng email vào hộp thư.

Mỗi lần gửi OTP và đọc trạng thái email tài khoản đều lấy cấu hình SMTP hiện tại từ database, không cần khởi động lại. Khi chưa có cấu hình đã lưu mới dùng các biến `SMTP_HOST`, `SMTP_FROM`, `SMTP_PORT`, `SMTP_SECURE` và cặp `SMTP_USER`/`SMTP_PASSWORD`. Lỗi giải mã/cấu hình đã lưu không âm thầm quay lại SMTP môi trường. Thời gian đợi kết nối/greeting/DNS là 5 giây, socket 10 giây, toàn lượt gửi tối đa 15 giây, tối đa 4 lượt gửi đồng thời trên một process. Lỗi SMTP trả thông báo chung, không trả nội dung phản hồi chứa credential. Chỉ cấu hình môi trường mới có ngoại lệ plaintext tới capture server loopback khi phát triển với `SMTP_ALLOW_INSECURE_LOCAL=true`; cờ này bị từ chối trong production hoặc với host ngoài loopback. Không tự gửi thử tới email thật khi chạy test.

Với tài khoản mới, người vận hành có thể đặt `CRM_ADMIN_EMAIL` khi chạy `npm run admin -- <username>` để cấp địa chỉ đã được xác minh độc lập. Lệnh tạo admin không sửa tài khoản đã tồn tại. Với tài khoản cũ chưa có email, hoặc khôi phục khi mất quyền email, dùng CLI `npm run admin:email -- <username>` tại máy chủ tin cậy với `CRM_ADMIN_EMAIL` và mật khẩu hiện tại. Có thể nhập mật khẩu ẩn tương tác; nếu dùng `CRM_ADMIN_PASSWORD`, nạp bằng secret manager hoặc môi trường tin cậy, không chèn bí mật trực tiếp vào lịch sử lệnh. Người vận hành phải xác minh quyền sở hữu hộp thư và danh tính chủ tài khoản ngoài luồng trước khi chạy; đây là đường khôi phục có quyền truy cập máy chủ, không phải API end-user bỏ qua OTP. Lệnh thu hồi phiên, trusted device và login/email challenge trong cùng transaction, tăng revision, không đổi hash mật khẩu. Không chạy CLI này tự động khi khởi động và không dùng email mẫu để cấp cho tài khoản thật.

Khi nâng cấp từ bản đã yêu cầu chữ ký trình duyệt, việc bật OTP không xóa các phiên đã gắn khóa và còn hợp lệ. Người dùng có thể giữ phiên đó để mở **Tài khoản**, kiểm tra mật khẩu và xác minh email trước khi đăng xuất; thời hạn phiên và các điều kiện thu hồi vẫn được áp dụng. Cấu hình SMTP trước bước này. Dịch vụ có thể khởi động khi chưa cấu hình SMTP, nhưng đăng nhập mới vào thiết bị chưa tin cậy vẫn bị từ chối nếu thiếu email đã xác minh hoặc không gửi được OTP. Không có bước tự cấp email, tự đánh dấu email đã xác minh hay lấy email từ hồ sơ khách hàng. Nếu phiên đã hết hạn/mất khóa hoặc đang nâng cấp từ bản chỉ có cookie, phải chuẩn bị email bằng CLI trên máy chủ tin cậy trước khi đăng nhập lại; chạy CLI sẽ thu hồi cả phiên đang mở.

Cookie không còn đủ để truy cập CRM. Khi đăng nhập bằng mật khẩu, phiên được gắn với public key P-256 của trình duyệt. Private key do WebCrypto tạo với `extractable=false`, lưu dưới dạng CryptoKey trong IndexedDB của đúng origin. Mỗi yêu cầu đọc/ghi và mỗi lần mở lại SSE phải mang chữ ký `X-CRM-Proof` với method, nguyên đường dẫn/query, hash byte JSON, origin cấu hình, binding phiên, Idempotency-Key, thời gian và mã yêu cầu ngẫu nhiên. Proof cũ, sửa nội dung hoặc lặp lại bị từ chối; MongoDB dùng insert duy nhất và majority write để chia sẻ chống replay giữa các API replica. DB chống replay lỗi thì từ chối yêu cầu. Không đưa chữ ký vào URL.

`/api/crm/session/bootstrap` chỉ trả binding ngẫu nhiên và giờ máy chủ cho cookie hợp lệ; không trả danh tính, CSRF, key hoặc cho đổi key. `/session` vẫn yêu cầu chữ ký. Chép cookie sang trình duyệt khác không có private key tương ứng sẽ không dùng được; tự tạo key khác cũng không được chấp nhận. Phiên cũ không gắn key bị từ chối, kể cả khi phát triển. Mất IndexedDB/khóa hoặc đổi origin phải đăng nhập lại bằng mật khẩu. Private key không được gửi lên máy chủ hay ghi thành chuỗi bí mật trong localStorage/sessionStorage.

Các thao tác xóa và thay đổi nhà cung cấp AI, khách hàng, website/token/webhook, bảng giá hoặc cài đặt yêu cầu nhập lại mật khẩu. Máy chủ cấp action token ngẫu nhiên chỉ dùng một lần, hết hạn sau 60 giây, gắn với đúng phiên, method, đường dẫn/query và hash nội dung; không mở khóa toàn bộ phiên. Kiểm tra lại mật khẩu có giới hạn lượt dùng chung theo tài khoản. Đổi Base URL nhà cung cấp, kể cả đổi path trên cùng host, yêu cầu cung cấp lại API key; không âm thầm gửi key cũ sang endpoint mới. URL tương đương được chuẩn hóa để tránh yêu cầu nhập key lại không cần thiết.

Đây là bảo vệ trước tình huống **chỉ cookie bị sao chép**, không phải khóa thiết bị dựa vào phần cứng hay bảo đảm an toàn khi trình duyệt/máy tính đã bị điều khiển. Nonextractable chỉ chặn API xuất private key; XSS cùng origin hoặc extension/mã độc có quyền phù hợp vẫn có thể dùng trình duyệt ký yêu cầu và đánh cắp mật khẩu nhập lại. Bản sao toàn bộ profile cũng không nằm trong bảo đảm này. Không dựa vào IP/User-Agent như yếu tố bí mật. Nếu nghi thiết bị bị xâm nhập, dùng thiết bị sạch đổi mật khẩu để thu hồi mọi phiên, xử lý mã độc/extension và xoay các credential đã có khả năng lộ. Passkey là lớp bổ sung có thể triển khai để chống phishing tốt hơn; OTP chỉ ở bước đăng nhập không tự chặn cookie bị dùng lại.

Đăng nhập, đổi mật khẩu và tạo/thu hồi phiên phối hợp transaction để mật khẩu vừa bị thay không thể dùng từ một lượt đăng nhập đang đua để mở phiên mới. Không xoay `ENCRYPTION_KEY` tùy tiện: dữ liệu key đã mã hóa đang dùng phụ thuộc khóa này.

## Nội dung và kết nối ra ngoài

CRM lọc lại HTML trước khi hiển thị bài, bao gồm bài lưu từ trước hoặc nhập vào. Script, event handler, iframe, SVG, form, CSS ngoài danh sách cho phép và URL nguy hiểm bị loại; định dạng bài/bảng an toàn được giữ. CSP chỉ cho script cùng origin, chặn object, đổi base URL và nhúng CRM bằng frame. CSS inline vẫn được phép để tương thích Ant Design và định dạng bài. Các tài nguyên `/widget/` không bị đặt CORP same-origin để script nhúng trên website khách vẫn tải được.

Các truy vấn bài/lịch public được giới hạn theo cả khách và website; sửa/hủy lịch kiểm tra lại quyền/token trong transaction. Không đưa site token hay key AI dịch vụ vào JavaScript nhúng công khai. Backend Laravel vẫn phải xác thực người dùng, kiểm tra CSRF/quyền website và chuyển tiếp đúng dữ liệu.

Kết nối OpenAI Compatible dùng HTTPS công khai, kiểm tra toàn bộ địa chỉ DNS và ghim địa chỉ đã kiểm tra vào socket TLS để tránh đổi DNS giữa kiểm tra và kết nối. Không theo redirect, không nhận địa chỉ nội bộ, chặn response quá 8 MiB. Transport yêu cầu `Accept-Encoding: identity` và từ chối response nén; upstream phải hỗ trợ phản hồi không nén. Streaming và hủy kết nối vẫn được giữ. Cấu hình mạng private cho các kết nối này sẽ không được chấp nhận.

MongoDB có giới hạn pool, thời gian đợi pool/kết nối/socket; truy vấn vẫn cần index và dữ liệu phù hợp. Access log tự động từng yêu cầu đã tắt để tránh flood khuếch đại log. Log lỗi ứng dụng vẫn bật và che header credential. Tại proxy/CDN, dùng log rotation, hạn mức lưu trữ và không ghi body, bearer token, cookie hoặc query chứa bí mật.

## Đưa bản nâng cấp vào hoạt động

1. Sao lưu dữ liệu/cấu hình, giữ nguyên khóa mã hóa và xác nhận các tiến trình cùng database dùng cùng khóa. Kiểm tra domain, HTTPS, mạng origin và `TRUSTED_PROXIES` trên môi trường thử.
2. Chạy `npm ci`, `npm run typecheck`, `npm test`, `npm run build`. Dừng/drain các API và worker bản cũ theo quy trình vận hành trước khi nâng cấp đồng bộ.
3. Cấu hình SMTP và chuẩn bị đường thiết lập email trước khi cho người dùng đăng nhập lại. Chạy `npm run migrate` với đúng database, rồi khởi động API/worker bản mới. Migration thêm collection/bộ đếm bảo mật, TTL và index tìm phiên theo user; `crm_request_proofs`, `crm_action_tokens`, các OTP challenge và thiết bị tin cậy có TTL trên `expires_at`, còn email đã xác minh có unique partial index. Migration không tự cấp hoặc xác minh email và không xóa hàng loạt phiên đã gắn khóa. Cập nhật đồng bộ API và frontend, không chạy lẫn API cũ vẫn chấp nhận cookie đơn thuần. Với database lớn, đánh giá thời gian tạo index trước rollout; socket MongoDB của ứng dụng có timeout 45 giây.
4. Chỉnh domain/chứng chỉ/upstream trong mẫu Nginx, kiểm tra bằng `nginx -t` trên máy có Nginx rồi reload. File mẫu chưa được dự án tự cài đặt. Không công khai cổng 3210 để né proxy.
5. Nếu còn phiên đã gắn khóa hợp lệ, dùng **Tài khoản** để xác minh email trước khi đăng xuất; nếu không, cấp email qua CLI theo quy trình ở trên. Sau đó kiểm tra đăng nhập trên thiết bị mới nhận OTP, gửi lại mã, hai tùy chọn ghi nhớ và thu hồi thiết bị. Kiểm tra cookie `__Host-`, chữ ký đọc/ghi, tải lại trang/nhiều tab, hộp thoại xác nhận mật khẩu, cập nhật SSE và một lượt widget qua Laravel. Production cần HTTPS và WebCrypto/IndexedDB; HTTP chỉ dùng trên localhost. Xác minh cookie sao chép sang browser context mới nhận 401, còn trình duyệt gốc vẫn dùng được; SMTP lỗi không được cấp phiên mới. Kiểm tra 429/503 với lưu lượng nhỏ có kiểm soát trên staging; không thử flood production.
6. Theo dõi tỷ lệ 401/403/429/503, CPU, RAM, pool MongoDB, số kết nối và backlog job ở hạ tầng quan sát. Điều chỉnh theo lưu lượng thật; áp dụng rule CDN/WAF chung cho nhiều replica. Không trả lời challenge HTML cho endpoint `/v1` dùng server-to-server.

Các bước này là hướng dẫn triển khai, không phải xác nhận hệ thống production đã có CDN/WAF, SMTP được cấu hình đúng hoặc đã được pentest độc lập.
