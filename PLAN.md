# Kế hoạch dịch vụ Node.js viết bài AI cho website Laravel

Biên tập viên nhập từ khóa, chọn giờ bắt đầu viết và bấm **Gửi lịch** trong trang quản trị Laravel. Laravel chuyển yêu cầu sang Node.js ngay khi bấm gửi. Node.js nhận diện website bằng token, lưu lịch, gọi AI khi đến giờ rồi gửi bài về đúng website. Bản đầu đề xuất mỗi lịch tương ứng với một bài. Biên tập viên nhận bản nháp trong trình soạn thảo Laravel.

Biên tập viên cũng có thể viết ngay trên form tạo hoặc sửa bài bằng widget JavaScript do Node.js cung cấp. Kết quả mở ở chế độ xem trước. Nút **Chấp nhận** điền nội dung vào form, sau đó biên tập viên chỉnh sửa và bấm nút lưu của website.

## CRM tại trang gốc của ứng dụng Node.js

Chủ dịch vụ truy cập `/`. Nếu chưa có phiên đăng nhập, ứng dụng hiển thị form tên đăng nhập và mật khẩu. Đăng nhập thành công mở trang Tổng quan tại `/`. Mọi màn hình và thao tác quản lý đều yêu cầu phiên đăng nhập CRM, kể cả khi mở đường dẫn trực tiếp. Backend Laravel xác thực các lệnh gọi API bằng token riêng của website.

### Thư viện và thiết kế giao diện CRM

Đề xuất dùng React + TypeScript, build bằng Vite. Ant Design cung cấp bảng dữ liệu, bộ lọc ngày, form, tab và ngăn chi tiết mở từ cạnh phải (Drawer). Recharts vẽ biểu đồ sản lượng và chi phí. Fastify phục vụ bản build CRM tại trang gốc và cung cấp dữ liệu qua API. Widget gắn trên Laravel có bản build JavaScript riêng để trang khách chỉ tải phần nút và modal viết bài.

| Màn hình | Thiết kế và thao tác |
| --- | --- |
| Tổng quan | Bộ lọc thời gian chung cho biểu đồ số bài và biểu đồ chi phí AI. Hiển thị đơn vị bài và USD trên hai biểu đồ riêng. Bên dưới là lịch sắp chạy và danh sách lỗi có thể bấm để xử lý. |
| Hồ sơ khách hàng | Tên khách và gói hiện tại ở đầu trang. Hai thanh hạn mức thể hiện số lượt đã dùng, đang giữ và còn lại trong ngày và tháng. Các tab Website, Bài viết và Chi phí dùng chung bộ lọc khách hàng. |
| Lịch viết | Bảng có cột website, từ khóa, giờ hẹn, model và trạng thái. Chọn một dòng để xem tiến trình, chi phí từng lần gọi AI và lịch sử giao bài trong Drawer. Khi đóng Drawer, danh sách giữ vị trí cuộn và bộ lọc. |

Giao diện dùng font Inter hỗ trợ tiếng Việt, nền sáng, thanh điều hướng xanh than và một màu nhấn cho hành động chính. Số tiền và số lượt căn phải, dùng chữ số có độ rộng bằng nhau để dễ đối chiếu. Trạng thái có tên tiếng Việt kèm màu. Trên điện thoại, ưu tiên các cột nhận diện và trạng thái, đưa phần chi tiết vào Drawer toàn màn hình.

### Chức năng trên giao diện CRM

| Mục | Dữ liệu cần thấy | Thao tác của chủ dịch vụ |
| --- | --- | --- |
| Nhà cung cấp AI | OpenAI, Anthropic, xAI và OpenAI Compatible, trạng thái mở cung cấp, tình trạng key dịch vụ và danh sách model của từng nhà cung cấp. OpenAI Compatible lưu Base URL và API key đã mã hóa trong CRM. | Thêm mã model, đặt tên hiển thị và bật/tắt từng model hoặc cả nhà cung cấp. Gói khách hàng chọn các model từ danh mục này. |
| Bảng giá model | Nhà cung cấp, model, đơn vị tiền, đơn giá theo loại sử dụng, nguồn công bố và thời điểm bắt đầu hiệu lực của từng phiên bản. | Nhập giá từ bảng giá chính thức cho model có API không cung cấp đơn giá. Khi nhà cung cấp đổi giá, thêm phiên bản mới và xem được lịch sử các phiên bản. |
| Tài khoản | Tên đăng nhập và phiên làm việc của người vận hành. | Đăng nhập, đăng xuất và đổi mật khẩu. Lưu mật khẩu dưới dạng băm. |
| Tổng quan | Tổng khách, tổng website, sản lượng theo thời gian, bài đã giao qua webhook, lịch sắp đến hạn, yêu cầu lỗi viết và bài lỗi giao. | Chọn hôm nay, tháng này hoặc khoảng ngày. Bấm vào một số liệu để mở danh sách chi tiết với cùng bộ lọc. |
| Quản lý khách hàng | Mã khách, tên, thông tin liên hệ nếu có, ngày tạo, danh sách website và số bài theo website. | Tạo và cập nhật hồ sơ, tìm khách theo tên hoặc thông tin liên hệ. Từ một khách có thể mở website hoặc lọc toàn bộ yêu cầu của khách đó. |
| Gói viết bài | Trong hồ sơ khách hàng, hiển thị nguồn API key, hạn mức bài/ngày và bài/tháng, thời hạn gói, số đã dùng, đang giữ chỗ và còn có thể đặt. | Chọn dùng key riêng hoặc cấp gói dùng key dịch vụ. Nhập hạn mức riêng cho khách, chỉnh hạn mức và gia hạn gói. Xem các yêu cầu đã dùng hoặc đang giữ từng lượt. |
| Quản lý website | Mã website, khách sở hữu, tên hiển thị, tên miền, URL nhận bài, trạng thái token, thời điểm API được dùng gần nhất. | Thêm website, sửa thông tin kết nối, cấp hoặc thay token, thu hồi token. Khi cấp mới, hiển thị giá trị đầy đủ một lần để người vận hành sao chép vào Laravel. Lưu mã nhận biết để đối chiếu về sau. |
| Yêu cầu viết | Mã công việc, mã yêu cầu Laravel, khách, website, nguồn lịch hoặc widget, từ khóa, model, giọng văn, phong cách, độ dài, giờ nhận, giờ hẹn, giờ bắt đầu và giờ hoàn tất. | Tìm theo mã hoặc từ khóa, lọc theo website, khách, thời gian, nguồn và trạng thái. Xem yêu cầu đang chờ đến giờ, đang viết, đã viết hoặc lỗi. |
| Chi tiết bài viết | Dữ liệu yêu cầu được phép hiển thị, kết quả sáu trường, diễn biến từng bước và lỗi gần nhất. | Xem trước bài, xem mảng JSON thực tế và đối chiếu với yêu cầu ban đầu. Mở lịch sử giao bài nếu đây là yêu cầu theo lịch. |
| Lịch sử giao bài | Website nhận, mã sự kiện, mã công việc, từng lần gửi, mã HTTP phản hồi, thời điểm xác nhận và lần thử tiếp theo. | Lọc các bài đã viết nhưng chưa giao, xem lý do gần nhất, bấm **Gửi lại** để chuyển chính kết quả đã lưu. |
| Tích hợp JavaScript | Trong hồ sơ website có URL script theo phiên bản, mẫu `const config`, ví dụ ánh xạ sáu trường và các API Laravel lấy danh sách model và xem trước bài. | Sao chép đoạn nhúng, khai báo DIV đặt nút, form đích và selector hoặc hàm điền dữ liệu cho editor. |

### Những việc Node.js tự thực hiện

| Chức năng | Quy tắc xử lý |
| --- | --- |
| Xác thực yêu cầu | Xác định website bằng Bearer token, suy ra khách hàng và giới hạn quyền tra cứu trong website đó. Token đã thu hồi hết hiệu lực với các lệnh gọi tiếp theo. |
| Tiếp nhận | Kiểm tra model, từ khóa, giọng văn, phong cách và độ dài. Chế độ key riêng yêu cầu thêm `keyAI`. Với gói dùng key dịch vụ, kiểm tra quyền và giữ lượt trước khi nhận việc. Kiểm tra giờ hẹn và múi giờ với lịch viết. Cấp `job_id` sau khi lưu thành công. Dùng mã yêu cầu của Laravel để nhận biết lần gửi lặp. |
| Điều phối lịch | Nhận việc viết ngay từ widget hoặc giữ việc đến giờ đã hẹn. Khôi phục lịch chờ sau khi dịch vụ khởi động lại. Lưu thời điểm thực tế để CRM có thể đối chiếu với giờ hẹn. |
| Gọi AI | Tra nhà cung cấp OpenAI, Anthropic, xAI hoặc OpenAI Compatible theo mã model trong danh mục CRM. OpenAI Compatible gọi chuẩn Chat Completions tại Base URL đã cấu hình. Dùng key và yêu cầu viết của đúng job, kiểm tra cấu trúc kết quả rồi lưu bài. Ghi nhà cung cấp, model, thời gian xử lý và lỗi. Khi provider trả số token đầu vào và đầu ra, có thể lưu để đối chiếu mức sử dụng. |
| Trả kết quả | Job theo lịch tạo sự kiện webhook có chữ ký, gửi bài hoặc thông báo lỗi đến Laravel. Job widget cung cấp trạng thái và kết quả cho modal xem trước. |
| Xử lý lỗi | Phân biệt lỗi đầu vào, AI key bị từ chối, lỗi tạm thời của nhà cung cấp, kết quả thiếu trường và lỗi giao webhook. Lưu giai đoạn lỗi, thời điểm và trạng thái thử lại. CRM chỉ hiển thị thông tin cần để xử lý, che các giá trị xác thực. |

Thông tin bài được biên tập, tác giả đăng bài, chuyên mục và thời điểm xuất bản do Laravel quản lý. Với luồng widget, thao tác chấp nhận điền form diễn ra trong trình duyệt. Để thống kê số bài thực sự được lưu hoặc xuất bản theo luồng này, Laravel cần gửi một xác nhận riêng sau thao tác tương ứng.

### Cách tính số liệu

- **Tổng khách hàng và website** đếm theo hồ sơ trong hệ thống tại thời điểm xem. Một khách sở hữu ba website được tính là một khách và ba website. Khách vừa tạo vẫn xuất hiện dù chưa đặt bài.
- **Bài đã viết** đếm mỗi `job_id` một lần khi Node.js đã lưu kết quả thành công. Bộ lọc ngày dựa trên thời điểm lưu bài. Bài chờ đến lịch, đang viết hoặc viết lỗi chưa đóng góp vào số này.
- **Bài đã giao** đếm mỗi `job_id` một lần khi Laravel xác nhận đã lưu bản nháp. Bộ lọc ngày dựa trên thời điểm xác nhận thành công đầu tiên. Ví dụ, bài viết xong hôm qua và giao hôm nay sẽ xuất hiện ở hai ngày tương ứng. Gửi lại webhook giữ nguyên số bài.
- Mỗi yêu cầu ghi nhận nguồn thao tác và loại viết mới hoặc viết lại để lọc thống kê. Mỗi phiên bản tạo thành công đóng góp một lượt vào **Bài đã viết**, kể cả khi biên tập viên bỏ bản xem trước. **Chấp nhận** chỉ tác động lên form. Chỉ số **Bài đã giao** áp dụng cho các bản nháp được Laravel xác nhận qua luồng webhook.
- Node.js lưu quan hệ khách hàng → website → lịch viết cùng thời điểm hoàn tất và thời điểm giao thành công đầu tiên. Dashboard dùng cùng các bản ghi này cho tổng toàn hệ thống, tổng theo khách và danh sách chi tiết. Bản đầu hiển thị ngày theo múi giờ Việt Nam.

## Chi phí AI theo bài, website và khách hàng

Đối chiếu tài liệu API công khai ngày 19/11/2026. Đơn giá là giá cho một đơn vị sử dụng. Chi phí của bài là tổng tiền các lần gọi AI phục vụ job đó. Báo cáo chi phí tài khoản dùng để đối soát theo kỳ.

| Nhà cung cấp | Nguồn đơn giá và cách ghi nhận chi phí |
| --- | --- |
| OpenAI (GPT) | Schema của `GET /v1/models` cung cấp thông tin model. Với mỗi lần viết, lấy usage thực tế của phản hồi và dùng giá input, cached input, output theo model và chế độ xử lý. Đối soát tổng chi phí qua `GET /v1/organization/costs` với quyền quản trị tổ chức. [Models](https://developers.openai.com/api/reference/resources/models/methods/list) · [Bảng giá](https://openai.com/api/pricing/) · [Costs API](https://platform.openai.com/docs/api-reference/usage/costs) |
| Anthropic (Claude) | Schema của `GET /v1/models` cung cấp thông tin model. Tính từ usage thực tế, gồm input thường, ghi cache theo thời hạn, đọc cache và output theo bảng giá. Đối soát bằng `GET /v1/organizations/cost_report` với quyền quản trị tổ chức. [Models](https://platform.claude.com/docs/en/api/models/list) · [Bảng giá](https://platform.claude.com/docs/en/about-claude/pricing) · [Cost Report](https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve) |
| xAI (Grok) | `GET /v1/language-models` cung cấp `prompt_text_token_price`, `cached_prompt_text_token_price`, `completion_text_token_price` và giá long context khi áp dụng. Đơn vị của các trường này là cent Mỹ trên 100 triệu token. Chia giá API cho 10.000 để quy đổi sang USD trên một triệu token. Với request viết, ưu tiên lấy trực tiếp `usage.cost_in_usd_ticks / 10^10` để ghi tiền USD. [Models API](https://docs.x.ai/developers/rest-api-reference/inference/models#list-language-models) · [Cost Tracking](https://docs.x.ai/developers/cost-tracking) |

- **Nhập giá theo thời gian hiệu lực.** Với model cần nhập tay, chủ CRM ghi giá input, output, các mức cache và bậc giá nếu có, đúng đơn vị nhà cung cấp công bố, kèm đường dẫn nguồn và mốc hiệu lực có múi giờ. Mỗi lần đổi giá tạo một phiên bản mới. Trong cùng một biểu giá của model, phiên bản áp dụng là bản có mốc hiệu lực gần nhất tại hoặc trước thời điểm gửi request.
- **Chốt đơn giá khi gọi AI.** Ngay lúc worker gửi request, ghi mã lần gọi, thời điểm gửi và phiên bản biểu giá đang hiệu lực. Khi nhận usage, tính tiền từng nhóm token theo biểu giá đã chốt, rồi lưu đơn giá đã áp dụng, số lượng và thành tiền trên bản ghi của lần gọi đó. Nếu nhà cung cấp trả trực tiếp chi phí cho request, lưu số tiền đó cùng nguồn. Mỗi lần thực sự gọi lại AI có thời điểm và bản ghi chi phí riêng.
- **Báo cáo lịch sử.** Tổng hợp các khoản tiền đã ghi theo job, website, khách và nguồn key. Bảng giá và các phiên bản đã dùng được lưu để tra cứu. Với OpenAI, trừ phần cache trong tổng input trước khi áp giá input thường. Với Claude, dùng từng nhóm usage do Anthropic trả. Lưu tiền dưới dạng số thập phân chính xác hoặc số nguyên theo đơn vị nhỏ.
- **Tiêu chí nghiệm thu khi đổi giá.** Giả sử giá mới có hiệu lực lúc 10:00. Request gửi lúc 09:59 và nhận phản hồi lúc 10:01 dùng giá cũ. Một lịch tạo hôm trước nhưng gọi AI lúc 10:00 dùng giá mới. Sau khi thêm một biểu giá nữa, báo cáo của hai request này vẫn phải khớp với số tiền đã ghi trên từng lần gọi.
- **Đối soát.** CRM ghi nguồn số tiền là nhà cung cấp trả theo request hoặc ước tính theo bảng giá. Khi thiếu usage hoặc giá, đánh dấu chờ đối soát. Có thể so tổng theo kỳ với báo cáo của tài khoản dịch vụ khi có quyền. Tổng hợp báo cáo tổ chức riêng để tránh cộng hai lần cùng một chi phí.
- **Màn hình CRM.** Xem giá vốn cho key dịch vụ theo khách, website, model, bài và thời gian. Chi phí dùng key riêng hiển thị ở nhóm khách tự trả. Khi một job cần gọi AI hai lần, ghi đủ chi phí của từng lần có phát sinh, dù job thành công chỉ tiêu thụ một lượt trong gói. Dời lịch và gửi lại webhook dùng các bản ghi hiện có, không gọi AI.

## Gói viết bài cho khách chưa có API key

Trong **Quản lý khách hàng → Gói viết bài**, chủ CRM chọn một trong hai chế độ. **Dùng key riêng** yêu cầu Laravel gửi `keyAI` và khách tự thanh toán cho nhà cung cấp AI. **Dùng gói dịch vụ** cho phép Laravel gửi yêu cầu mà bỏ trường `keyAI`. Node.js nhận diện khách từ token website và dùng key dịch vụ lưu ở backend Node.js. Khách chỉ dùng được key dịch vụ khi chủ CRM đã cấp gói có hiệu lực. Lỗi hoặc thiếu key riêng được trả về cho Laravel.

- **Cấu hình bán gói.** Chủ CRM đặt số bài tối đa mỗi ngày và mỗi tháng cho từng khách, có thể ghi ngày hiệu lực và ngày hết hạn. Cả hai hạn mức cùng áp dụng cho tổng các website, bao gồm lịch viết và widget. Khách dùng key dịch vụ chỉ được gọi model do chủ CRM cho phép trong gói. Có thể đặt độ dài tối đa mỗi bài để kiểm soát chi phí.
- **Kỳ sử dụng.** Đề xuất dùng ngày và tháng dương lịch theo `Asia/Ho_Chi_Minh`. Lượt thuộc ngày và tháng của giờ hẹn đối với lịch viết, hoặc của lúc tiếp nhận đối với widget. Lịch phải nằm trong thời hạn gói. Nếu job chạy trễ qua ngày hoặc tháng, giữ nguyên kỳ đã đặt. Sản lượng bài viết trên dashboard vẫn tính theo thời điểm hoàn tất thực tế.
- **Nhận lịch và giữ chỗ.** Kiểm tra yêu cầu trùng trước. Với job mới, trong cùng giao dịch tạo job, kiểm tra số đã dùng cộng số đang giữ ở cả hai kỳ và giữ một lượt cho job ở mỗi kỳ. Hai website gửi đồng thời khi còn một lượt thì chỉ một yêu cầu được nhận. Ví dụ, hạn mức 5 bài/ngày và 100 bài/tháng, đã dùng 4 hôm nay và 99 tháng này, còn đặt được 1 bài cho hôm nay.
- **Chốt hoặc hoàn lượt.** Khi lưu thành công một bài hợp lệ, chuyển lượt giữ thành lượt đã dùng cùng giao dịch lưu kết quả. Lỗi viết cuối cùng hoặc hủy trước khi viết sẽ giải phóng lượt. Thử lại cùng job dùng chính lượt đã giữ. Gửi lại webhook, đọc lại kết quả và bấm Chấp nhận trên widget đều dùng kết quả cũ. Nếu người dùng yêu cầu AI viết một bản mới, đó là một job mới.
- **Dời lịch dùng chính lượt đã giữ.** Ví dụ, khi dời lịch từ 22/11 sang 25/11, Node.js cập nhật ngày hẹn trên cùng `job_id` và chuyển chỗ đã giữ sang ngày 25/11. Trong tháng 11, lịch này chiếm đúng một chỗ dù đổi ngày nhiều lần. Khi bài viết thành công, hệ thống ghi nhận một lượt đã dùng.
- **Hiển thị và phản hồi.** CRM và Laravel có thể hiển thị hạn mức, số đã dùng, đang giữ và còn lại cho từng kỳ. Nếu hết lượt, API trả HTTP 429 trước khi gọi AI, chỉ rõ kỳ ngày, kỳ tháng hoặc cả hai cho thời điểm yêu cầu. Laravel dùng thông tin đó trên cả màn hình đặt lịch và modal. Nếu gói hết hiệu lực, trả lỗi gói hết hạn để phân biệt với hết lượt.
- **Thay đổi hạn mức.** Hạn mức mới áp dụng cho yêu cầu mới, vẫn tính số bài đã dùng và chỗ đã giữ trong kỳ. Khi hạ mức xuống dưới số đã dùng và đang giữ, số lượt còn có thể đặt là 0. Gia hạn trong cùng kỳ giữ nguyên lịch sử sử dụng.

## Quản lý bài và lịch trên Laravel

| Màn hình | Người dùng thao tác | Backend xử lý |
| --- | --- | --- |
| Cài đặt dịch vụ viết bài | Quản trị viên nhập token do dịch vụ Node.js cấp cho website, chọn model từ danh mục và nhập API key của nhà cung cấp tương ứng khi dùng key riêng. Với gói dịch vụ, hiển thị model được phép và số lượt còn lại. | Laravel lưu site token và mã hóa AI key ở backend. Với chế độ key riêng, backend gửi key tương ứng qua HTTPS trong trường `keyAI`. Với gói dịch vụ, backend chỉ gửi thông tin viết. |
| Lên lịch viết | Biên tập viên chọn model, nhập từ khóa, giọng văn, phong cách viết, độ dài mục tiêu và chọn ngày giờ theo múi giờ hiển thị của website và bấm **Gửi lịch**. Có thể chọn chuyên mục hoặc yêu cầu thêm về nội dung. | Laravel lưu mã yêu cầu, tác giả và chuyên mục, sau đó gửi lịch đến Node.js. Màn hình hiển thị giờ hẹn và trạng thái tiếp nhận. Khi nhận bài, người dùng có thể mở bản nháp từ chính dòng lịch đó. |
| Danh sách lịch | Xem các lịch của website, lọc theo ngày hẹn hoặc trạng thái, sửa thông tin hoặc xóa lịch còn chờ. | Laravel đọc danh sách từ Node.js. Sau khi sửa hoặc hủy, hiển thị giờ hẹn, trạng thái và lượt còn lại theo kết quả API. |
| Bài đã viết | Tìm bài theo tiêu đề hoặc từ khóa, mở một phiên bản và bấm **Viết lại**. | Laravel gửi mã phiên bản nguồn, hiển thị tiến trình, rồi dùng kết quả mới cho thao tác xem trước và chấp nhận vào form. |

## Nhúng nút Viết bài AI vào form Laravel

### Mẫu cấu hình dự kiến cho khách hàng

Ví dụ dưới đây đặt nút vào `#ai-tools` trên form hiện có `#article-form`. Thay tên miền minh họa bằng URL dịch vụ và các selector bằng trường thật trên website. Đặt đoạn nhúng sau các phần tử của form. Khách hàng khai báo những trường muốn điền.

```html
<div id="ai-tools"></div>
<script src="https://content.example.com/widget/v1/ai-writer.js"></script>
<script>
  const config = {
    mount: '#ai-tools',
    form: '#article-form',
    endpoint: '/admin/ai/previews',
    modelsEndpoint: '/admin/ai/models',
    fields: {
      Title: '[name="title"]',
      Content: '[name="body"]',
      Slug: '[name="slug"]',
      Desc: '[name="summary"]',
      Desction: '[name="seo_description"]',
      'Từ khóa': '[name="keywords"]'
    }
  };

  AIWriter.mount(config);
</script>
```

### Trải nghiệm trên form

1. Script gắn nút **Viết bài AI** kiểu `button` vào đúng DIV. Bấm nút mở modal có các trường model, từ khóa, giọng văn, phong cách viết, độ dài và nút **Viết ngay**. Ví dụ, biên tập viên có thể yêu cầu độ dài 800 chữ, giọng văn thân thiện và thêm mục câu hỏi thường gặp.
2. Widget gửi yêu cầu qua Laravel. Node.js xếp việc để viết ngay bằng cấu hình AI của website. Modal theo dõi cùng một `job_id`, hiển thị tiến trình, lỗi hoặc bản xem trước gồm các trường sắp điền.
3. Khi bấm **Chấp nhận**, widget lấy bài ở phần tử đầu tiên của mảng kết quả. Với input từ khóa dạng văn bản, widget nối các mục trong `Từ khóa` bằng dấu phẩy. Widget tra các selector bên trong form đã cấu hình và kiểm tra tất cả đích trước khi áp dụng. Nếu selector thiếu, trùng hoặc trường kết quả tương ứng bị thiếu, modal chỉ rõ trường cần sửa để tránh điền dở dang. Với input và textarea, widget gán `value` rồi phát sự kiện `input` và `change`. Với trình soạn thảo như CKEditor, cấu hình trường có thể cung cấp hàm `setValue(element, value)` để gọi API của editor. Nội dung HTML dùng để xem trước và điền vào editor phải được lọc theo danh sách thẻ và thuộc tính cho phép.
4. Bấm **Đóng** trước khi chấp nhận sẽ bỏ qua thao tác điền. Sau khi chấp nhận, biên tập viên có thể sửa tiếp và dùng nút **Lưu** hiện có của Laravel.

### API dùng cho widget

- Script được tải từ Node.js. Khi bấm **Viết ngay**, trình duyệt gọi `POST /admin/ai/previews` cùng origin bằng phiên đăng nhập và CSRF của Laravel. Laravel kiểm tra quyền tạo hoặc sửa bài, ghi nhận mã yêu cầu theo người dùng và dùng site token phía server để gọi Node.js.
- Node.js nhận `POST /v1/article-jobs` với dữ liệu viết và `mode: "preview"`. Backend Laravel bổ sung `keyAI` khi khách dùng key riêng. Job này có hiệu lực ngay, dùng chung worker viết bài và trả kết quả qua API tra cứu. Webhook tạo bản nháp chỉ áp dụng cho job lên lịch.
- Widget tra `GET /admin/ai/previews/{job_id}`. Laravel kiểm tra người dùng sở hữu yêu cầu trước khi lấy trạng thái hoặc nội dung từ Node.js. Site token và AI key nằm ở backend. Khi mở modal, widget lấy danh mục từ `GET /admin/ai/models`. Backend Laravel gọi `GET /v1/models` bằng site token và chuyển phản hồi cho widget.

## Luồng từ lúc gửi lịch đến lúc nhận bài

1. Trong mục **Quản lý website** của CRM, chủ dịch vụ đăng ký website cho khách hàng, cấu hình URL webhook HTTPS, khóa ký webhook và cấp token. Backend Laravel dùng token này làm Bearer token. Node.js tra token để xác định website sở hữu yêu cầu và webhook tương ứng.
2. Laravel tạo mã yêu cầu duy nhất trước khi gửi. Ví dụ, người dùng chọn 09:00 ngày 25/11/2026 theo giờ Việt Nam. Laravel gửi ngay từ khóa cùng thời điểm `2026-11-25T09:00:00+07:00`. Node.js lưu mốc tương ứng `2026-11-25T02:00:00Z`.
3. Sau khi lịch đã được lưu, Node.js trả HTTP `202` kèm `job_id`, `scheduled_at` và trạng thái `scheduled`. Biên tập viên có thể đóng trang. Nếu mất phản hồi, Laravel gửi lại cùng mã yêu cầu để nhận đúng lịch cũ.
4. Worker trong Node.js lấy các lịch đã đến giờ theo đồng hồ cơ sở dữ liệu. Worker nhận quyền xử lý một lịch, chuyển trạng thái sang `writing`, lấy key theo chế độ đã ghi trên job và gọi model đã nhận, dùng từ khóa, giọng văn, phong cách và độ dài của lịch đó. Lịch đã nhận vẫn chạy khi Laravel đang bảo trì.
5. Khi AI trả bài, Node.js kiểm tra nội dung, lưu kết quả và tạo sự kiện chờ gửi trong cùng giao dịch. Worker giao bài đến URL webhook của website sở hữu lịch.
6. Laravel kiểm tra chữ ký, tìm yêu cầu ban đầu, tạo bản nháp đúng tác giả và chuyên mục, ghi liên kết tới bài rồi mới phản hồi thành công. Khi AI báo lỗi cuối cùng, Node.js gửi sự kiện lỗi để Laravel cập nhật dòng lịch.

## API hai chiều giữa Laravel và Node.js

Hai ứng dụng triển khai độc lập và trao đổi dữ liệu JSON qua HTTPS giữa hai backend. Laravel lưu địa chỉ gốc của API Node.js để gửi yêu cầu viết và tra cứu kết quả. Node.js lưu địa chỉ API nhận bài của từng website để chủ động giao kết quả khi viết xong. Mỗi ứng dụng quản lý cơ sở dữ liệu riêng.

### Dữ liệu Laravel gửi khi yêu cầu viết bài

Backend Laravel xác thực website qua header `Authorization: Bearer <site_token>`. Mẫu JSON dưới đây áp dụng cho khách dùng key riêng. Khách dùng gói dịch vụ bỏ trường `keyAI` và gửi năm trường còn lại. Ví dụ payload trước khi bổ sung thông tin lên lịch hoặc xem trước:

```json
{
  "keyAI": "<API key do khách nhập trong Laravel>",
  "model": "gpt-4.1",
  "keyword": "cách chọn máy lọc nước",
  "tone": "thân thiện",
  "style": "hướng dẫn từng bước",
  "length": 800
}
```

`length` là số từ mục tiêu, kiểu số nguyên dương. `model` là mã model để Node.js chọn nhà cung cấp. Với lịch viết, Laravel bổ sung `scheduled_at` có múi giờ. Với widget, Laravel bổ sung `mode: "preview"`. Backend gửi `Idempotency-Key` để đối chiếu yêu cầu khi thử lại.

### Mảng JSON khi viết xong

Một yêu cầu tạo một bài, nên mảng kết quả có một phần tử. Năm trường đầu là chuỗi. `Từ khóa` là mảng chuỗi. Ví dụ rút gọn nội dung:

```json
[
  {
    "Title": "Cách chọn máy lọc nước cho gia đình",
    "Content": "<p>Trước tiên, hãy xác định nguồn nước gia đình đang dùng.</p>",
    "Slug": "cach-chon-may-loc-nuoc-cho-gia-dinh",
    "Desc": "Các bước chọn máy lọc nước phù hợp với gia đình.",
    "Desction": "Tìm hiểu cách chọn máy lọc nước theo nguồn nước, nhu cầu sử dụng và chi phí thay lõi.",
    "Từ khóa": ["cách chọn máy lọc nước", "máy lọc nước gia đình"]
  }
]
```

Quy ước đề xuất cho nội dung là `Content` chứa HTML, `Desc` là mô tả ngắn hiển thị trên bài và `Desction` là mô tả SEO. Laravel và widget đọc đúng chính tả, chữ hoa và dấu của cả sáu khóa. Laravel xử lý trùng slug bằng logic lưu bài hiện có.

| Hướng | Endpoint | Dữ liệu chính |
| --- | --- | --- |
| Laravel → Node.js | `POST /v1/article-jobs` | Gửi payload viết cùng thông tin lịch hoặc preview. Node.js xác thực site token, kiểm tra trường bắt buộc và model hỗ trợ. HTTP 202 xác nhận đã nhận việc, kèm `job_id` và trạng thái để theo dõi. |
| Laravel → Node.js | `GET /v1/models` | Liệt kê mã model và tên hiển thị đang cung cấp cho website. Với key dịch vụ, lọc thêm theo gói và key cấu hình trên Node. |
| Laravel → Node.js | `GET /v1/usage` | Trả chế độ dùng key và, với gói dịch vụ, hạn mức ngày/tháng của khách sở hữu token, đã dùng, đang giữ, còn lại và thời điểm bắt đầu kỳ kế tiếp. Cho phép tra theo ngày dự định viết. |
| Laravel → Node.js | `GET /v1/article-jobs/{job_id}` | Trả trạng thái, giờ hẹn và lỗi nếu có, trong phạm vi website sở hữu yêu cầu. |
| Laravel → Node.js | `GET /v1/article-jobs/{job_id}/result` | Khi hoàn tất, trả HTTP 200 với body là mảng JSON bài viết ở trên. Laravel dùng cùng kết quả cho widget và đồng bộ bản nháp. |
| Node.js → Laravel | `POST /api/webhooks/ai-articles` | Khi thành công, body là cùng mảng JSON. Khi thất bại, body mang thông tin lỗi. Loại sự kiện, mã sự kiện, mã job, mã yêu cầu và timestamp nằm trong header và được ký HMAC cùng body gốc. |

### API danh sách, quản lý lịch và viết lại cho Laravel

Mỗi API xác định website từ Bearer token, kể cả khi hai website thuộc cùng khách hàng. Hai API danh sách trả `data` và `next_cursor`, nhận `cursor` và `limit` để phân trang. Các mã tài nguyên ngoài phạm vi website trả HTTP 404. Kết quả chi tiết của một bài vẫn dùng mảng JSON sáu trường ở trên.

| Chức năng | Phương thức và đường dẫn | Laravel gửi hoặc nhận |
| --- | --- | --- |
| Danh sách bài đã viết | `GET /v1/articles` | Mỗi dòng là một phiên bản hoàn tất từ lịch, widget hoặc thao tác viết lại. Có `article_id`, `source_article_id` (bản đầu là `null`), `Title`, từ khóa, model và `completed_at`. Lọc theo `q` (tiêu đề hoặc từ khóa), `from`, `to` theo ngày hoàn tất. Sắp xếp bài hoàn tất gần nhất trước, dùng ID để phân định khi trùng thời điểm. |
| Danh sách lịch | `GET /v1/schedules` | Mỗi dòng có `job_id`, thông tin viết có thể sửa, `scheduled_at`, `status` và `version`. Mặc định lấy các lịch còn chờ theo giờ hẹn gần nhất. Có thể lọc theo `from`, `to` trên giờ hẹn và `status` để xem lịch đang viết, hoàn tất, lỗi hoặc đã hủy. |
| Thêm lịch | `POST /v1/article-jobs` | Dùng API tạo job hiện có, gửi thông tin viết, `scheduled_at` và `Idempotency-Key`. HTTP 202 trả `job_id`, giờ hẹn, trạng thái và `version` ban đầu. |
| Sửa lịch | `PATCH /v1/schedules/{job_id}` | Gửi các trường thay đổi trong `scheduled_at`, `keyword`, `tone`, `style`, `length`, `model`. Nếu đổi nhà cung cấp khi dùng key riêng, Laravel gửi kèm `keyAI` tương ứng. Dùng `If-Match` với version từ danh sách để tránh ghi đè một lần sửa mới hơn. Trả HTTP 200 với lịch đã cập nhật. |
| Xóa lịch | `DELETE /v1/schedules/{job_id}` | Hủy lịch đang chờ và hoàn lượt đã giữ trong cùng giao dịch. Trả HTTP 204, kể cả khi lặp lại lệnh hủy cho cùng lịch đã hủy. CRM vẫn tra cứu được lịch sử hủy. |
| Viết lại một bài | `POST /v1/articles/{article_id}/rewrites` | Laravel chọn chính xác phiên bản làm tư liệu. Mỗi thao tác mới gửi một `Idempotency-Key` mới. Body có thể thêm `instructions` để nêu điểm cần sửa và cần có `keyAI` nếu khách đang dùng key riêng. Trả HTTP 202 cùng `job_id` mới và `source_article_id`. |

**Khi sửa hoặc hủy lịch.** Chỉ lịch ở trạng thái `scheduled` mới có thể thay đổi. Node.js kiểm tra trạng thái và cập nhật trong cùng giao dịch với thao tác giữ lượt và thao tác nhận việc của worker để chỉ một phía giành được quyền xử lý. Nếu worker đã bắt đầu, API trả HTTP 409 kèm trạng thái hiện tại. Nếu version đã cũ khi sửa lịch chờ, trả HTTP 412 để Laravel tải lại lịch. Khi đổi giờ qua ngày hoặc tháng khác, Node.js kiểm tra hiệu lực gói, chuyển lượt giữ sang kỳ mới trong cùng giao dịch và dùng lại lượt của kỳ trùng. Nếu kỳ mới hết lượt, trả HTTP 429 và lịch cũ vẫn có hiệu lực. Việc sửa nội dung của cùng một lịch chờ dùng lượt đã giữ.

**Dữ liệu dùng khi viết lại.** Trong bản đầu, mỗi job thành công có đúng một kết quả, nên dùng chính `job_id` làm `article_id` cho phiên bản đó. Worker lấy model, từ khóa, giọng văn, phong cách, độ dài và toàn bộ kết quả cũ của phiên bản được chọn, gồm cả `Content`. Worker cung cấp các dữ liệu đó cùng hướng dẫn bổ sung cho AI. Node.js kiểm tra model và độ dài theo quyền hiện tại của khách trước khi nhận việc. Với gói dịch vụ, worker lấy key của dịch vụ. Bài mới liên kết với bản nguồn bằng `source_article_id`. Biên tập viên có thể mở lại từng phiên bản và chọn bản dùng cho form Laravel.

**Cách tính lượt và lấy kết quả.** Viết lại chạy ngay và giữ một lượt trong ngày, tháng tiếp nhận đối với gói dịch vụ. Một kết quả viết lại thành công được tính như một bài viết mới. Nếu viết lỗi cuối cùng, trả lại lượt đã giữ. Một lần Laravel gửi lại cùng mã yêu cầu do mất phản hồi trả về đúng job đã tạo, kể cả khi khách vừa hết lượt. Laravel theo dõi qua `GET /v1/article-jobs/{job_id}` và lấy bản mới tại `GET /v1/article-jobs/{job_id}/result` để xem trước. Mỗi lần viết lại chủ động tiếp theo tạo một job mới với một lượt mới.

## Công nghệ và xử lý nhiều yêu cầu đồng thời

Bản đầu đề xuất dùng Node.js LTS, TypeScript, Fastify và PostgreSQL. Chạy API/CRM, worker viết bài và worker giao webhook thành các tiến trình độc lập, hoạt động liên tục. Có thể triển khai cùng một máy và tăng riêng số bản sao của thành phần đang thiếu công suất.

| Thành phần | Cách xử lý khi nhiều website gửi cùng lúc |
| --- | --- |
| API và CRM bằng Fastify | API xác thực token, kiểm tra yêu cầu trùng, giữ lượt theo gói và tạo job trong một giao dịch PostgreSQL. Khi giao dịch đã lưu thành công, trả HTTP 202 cùng `job_id` để Laravel tiếp tục làm việc. |
| Hàng đợi bền vững trong PostgreSQL | Mỗi job có thời điểm được phép chạy. Viết ngay và viết lại lấy thời điểm hiện tại, lịch hẹn lấy `scheduled_at`. Worker lấy các job đủ điều kiện bằng giao dịch ngắn với `FOR UPDATE SKIP LOCKED`, ghi quyền xử lý có thời hạn rồi đóng giao dịch trước khi gọi AI. Các worker khác tiếp tục lấy job khác. |
| Worker viết bài bằng Node.js | Các lệnh gọi GPT, Claude và Grok là HTTP bất đồng bộ. Một worker có thể chờ nhiều phản hồi AI cùng lúc. Đặt số request đang chạy tối đa cho mỗi worker, chia lượt giữa khách đang chờ và thực thi giới hạn dùng chung theo tài khoản, model hoặc nhóm hạn mức mà nhà cung cấp áp dụng. Theo dõi cả request/phút và token/phút. Khi gặp giới hạn tạm thời, hẹn thử lại theo `Retry-After` nếu có, giải phóng chỗ cho job đủ điều kiện khác. |
| Worker giao webhook | Khi lưu bài, ghi luôn sự kiện cần gửi trong cùng giao dịch. Worker giao bài đọc các sự kiện đã lưu và gửi độc lập, để thời gian phản hồi của website khách không chiếm chỗ viết bài. |

**Ví dụ cấu hình để kiểm thử.** Hai worker viết, mỗi worker tối đa năm lệnh gọi đang chờ AI, cho phép tối đa mười lệnh gọi đồng thời nếu hạn mức nhà cung cấp cho phép. Khi 100 yêu cầu viết ngay hợp lệ đến cùng lúc, các job được lưu và xử lý dần khi có chỗ. Số người gửi tại một thời điểm, số bài đang viết và số bài hoàn tất mỗi phút là ba chỉ số khác nhau.

**Kiểm tra trước khi chọn công suất vận hành.** Dùng nhiều token website gửi tải đồng loạt với AI giả lập có độ trễ và lỗi 429. Đo thời gian trả `202`, thời gian từ lúc job đủ điều kiện đến lúc bắt đầu gọi AI, số cuộc gọi đang chạy và số bài hoàn tất/phút. Kiểm tra một khách gửi dồn vẫn chừa năng lực cho khách khác, website nhận webhook chậm vẫn cho phép job viết khác chạy, và số lượt đã dùng khớp với số bài thành công. Đối chiếu thêm độ trễ và giới hạn thực tế của từng nhà cung cấp trước khi cam kết công suất.

## Vận hành lịch trên Node.js

- **Khôi phục công việc.** Tạo chỉ mục theo trạng thái và thời điểm đủ điều kiện chạy. Worker gia hạn quyền xử lý trong khi đang thực hiện. Khi khởi động lại, worker lấy tiếp công việc còn chờ hoặc hết thời hạn giữ. Đối chiếu mã lần gọi AI nếu nhà cung cấp hỗ trợ khi phản hồi trước đó bị gián đoạn. Chỉ worker còn quyền xử lý được ghi kết quả cuối và chốt lượt của job.
- **Tách dữ liệu theo website.** Node.js lưu bản băm của site token. Mỗi job gắn với website đã xác thực, model và nguồn key. Với key riêng, lưu bản mã của keyAI nhận trong yêu cầu. Với key dịch vụ, job tham chiếu cấu hình của dịch vụ. Worker giữ key ở dạng mã hóa khi chờ viết hoặc chờ thử lại và xóa bản mã khi kết thúc bước viết. Khóa mã hóa nằm ngoài cơ sở dữ liệu. Loại keyAI và site token khỏi log, phản hồi và dữ liệu hiển thị trên dashboard.
- **Gửi lịch lặp.** Ràng buộc duy nhất theo website và mã yêu cầu. Nếu Laravel gửi lại cùng nội dung, trả lịch cũ, kể cả khi giờ hẹn đã qua. Nếu cùng mã nhưng nội dung thay đổi, trả HTTP `409`.
- **Lỗi viết hoặc lỗi giao.** Worker thử lại có giới hạn với lỗi AI tạm thời. Nếu key bị nhà cung cấp từ chối, trả lỗi cấu hình cho Laravel. Khi bài đã viết xong nhưng Laravel tạm ngừng hoạt động, worker chỉ gửi lại kết quả đã lưu.
- **Callback trùng.** Laravel khóa bản ghi yêu cầu và lưu bản nháp cùng ID bài trong một giao dịch. Nếu đã có ID bài, trả thành công và giữ nguyên nội dung biên tập viên đã sửa.

## Thứ tự triển khai và nghiệm thu

| Mốc | Công việc | Kiểm tra đạt |
| --- | --- | --- |
| 1. CRM và kết nối website | Dựng đăng nhập bằng tên người dùng và mật khẩu tại trang gốc, mục Quản lý khách hàng và mục Quản lý website. Cấp token trong hồ sơ website. Làm màn hình Laravel nhập AI key và ghép key tương ứng vào từng yêu cầu viết. | Truy cập trực tiếp một màn hình CRM khi chưa đăng nhập dẫn về form đăng nhập. Sau đăng nhập, tạo một khách có hai website và một khách chưa có website. Tổng quan hiển thị 2 khách, 2 website. Hai website gọi API bằng token riêng và chỉ tra cứu được job của mình. |
| 2. Nhận lịch và viết đúng thời điểm | Làm form lên lịch Laravel, API nhận dữ liệu viết theo chế độ key, worker xử lý lịch đến hạn và tích hợp OpenAI. | Gửi lịch trước giờ hẹn, thấy trạng thái đã nhận ngay. Trước giờ hẹn số lần gọi AI bằng 0. Sau khi đến giờ, worker dùng đúng nguồn key đã cấp cho khách. Khởi động lại Node.js trước giờ hẹn vẫn giữ được lịch. |
| 3. Trả bài và thống kê trên dashboard | Làm webhook có chữ ký, lưu bản nháp và hiển thị kết quả trên Laravel. Hoàn thiện dashboard Node.js, bộ lọc, danh sách lịch và thao tác gửi lại. | Hai website của cùng khách mỗi site viết xong một bài trong ngày. Khi một site tạm ngừng nhận webhook, dashboard ghi 2 bài đã viết, 1 bài đã giao. Sau khi gửi lại thành công trong ngày, số đã giao lên 2, số đã viết vẫn bằng 2. Tổng theo khách khớp với hai dòng chi tiết. |
| 4. Thêm Claude và kiểm tra lỗi | Tích hợp Anthropic qua cùng giao diện provider, kiểm tra key hết hiệu lực, gửi lịch lặp và đồng bộ kết quả. | Đặt lịch với GPT hoặc Claude từ Laravel. Biên tập viên thấy lý do khi lịch lỗi và mở được bản nháp khi lịch thành công. |
| 5. Nhúng widget vào form khách hàng | Phát hành script v1 và mẫu config trong trang quản trị Node.js, tích hợp API preview, modal và ánh xạ trường vào form Laravel. | Thử hai form có tên input khác nhau. Nút xuất hiện đúng DIV. Xem trước rồi đóng giữ nguyên dữ liệu đang nhập. Chấp nhận điền đúng các trường, kể cả editor có cấu hình riêng. Chỉ nút Lưu của website mới lưu bài. Một lần viết tăng đúng một bài trong thống kê. |
| 6. Bán gói theo hạn mức | Thêm cấu hình gói vào CRM, lưu giữ chỗ theo job và kỳ, trả hạn mức cho Laravel. | Hai website của một khách tranh lượt cuối trong cùng kỳ. Chỉ một job được nhận. Kiểm tra hết hạn mức tháng dù ngày còn lượt, giữ lượt đúng tháng cho lịch tương lai, trả lượt khi viết lỗi, thử lại webhook và widget không tính thêm lượt cho cùng kết quả. |
| 7. Danh sách, sửa lịch và viết lại | Nối hai danh sách trong Laravel với API Node.js, thêm thao tác sửa, hủy và viết lại từ một phiên bản. | Hai website chỉ thao tác được dữ liệu của mình. Dời lịch 22/11 sang 25/11 khi tháng 11 đã giữ hết chỗ và ngày 25 còn chỗ phải thành công với cùng một job, một lượt giữ trong tháng và một lượt dùng khi viết xong. Đổi lịch sang tháng khác đã hết lượt giữ nguyên lịch cũ. Hủy lặp chỉ hoàn một lượt. Mỗi lần viết lại dùng đúng tư liệu của bản được chọn và ghi một lượt khi thành công. Gửi lại cùng mã yêu cầu trả cùng job. |
