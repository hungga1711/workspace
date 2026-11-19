# Đánh giá tác động: AI Insights

> Mẫu hồ sơ đánh giá tác động xử lý dữ liệu cá nhân (Việt Nam: Nghị định 13/2023/NĐ-CP, Điều 24; EU: đánh giá tác
> động theo GDPR Điều 35, đọc cùng Điều 88 cho bối cảnh lao động). Không phải tư vấn pháp lý. Các câu trả lời điền sẵn
> mô tả cách workspace hoạt động; đối chiếu với cấu hình của công ty và điền mọi chỗ `[trong ngoặc]`.

**Bên kiểm soát dữ liệu:** [công ty], [địa chỉ] · **Đầu mối:** [họ tên, email] · **Người lập:** [họ tên] · **Ngày:** [ngày]

## 1. Mô tả hoạt động xử lý

| Mục | Nội dung |
|---|---|
| Mục đích | Ngăn dữ liệu của công ty và khách hàng lọt vào công cụ AI; quản lý công cụ AI được phép và chi phí; biết AI có giúp công việc xong tốt hơn không. |
| Không phải mục đích | Chấm điểm hay xếp hạng hiệu suất cá nhân; theo dõi hoạt động ngoài công cụ AI. |
| Đối tượng | Nhân viên, cộng tác viên đã kết nối tiện ích hoặc dùng AI của công ty trong workspace: [số người]. |
| Dữ liệu | Câu gửi trên các trang AI trong danh sách; câu trả lời chỉ khi bật ghi câu trả lời ([có/không]); trang, model, thời gian; chủ đề; loại dữ liệu nhạy cảm phát hiện được; liên kết với việc; câu trả lời "AI có giúp không?"; số lần bộ lọc dữ liệu nhạy cảm can thiệp (không ghi nội dung); một câu tóm tắt do AI viết. |
| Có thể có dữ liệu nhạy cảm | Nhân viên có thể gõ thông tin sức khoẻ hay dữ liệu nhạy cảm khác. Giảm thiểu bằng bộ lọc dữ liệu nhạy cảm và giới hạn truy cập (mục 4). |
| Nguồn | Chính người đó (tiện ích sau khi họ kết nối; AI của công ty trong workspace); file nhập từ bảng điều khiển nhà cung cấp AI nếu dùng ([có/không]). |
| Bên nhận | Chính người đó; quản lý của họ ở mức [chủ đề/tóm tắt]; quản trị viên [vai trò] ở cùng mức; ngoài người đó không ai đọc được nội dung câu hỏi. Không có bên thứ ba. [Nhà cung cấp model cho phần tóm tắt, nếu có: tên, hợp đồng.] |
| Nơi lưu | Máy chủ của công ty [vị trí, đơn vị vận hành]; schema `ai` trong Postgres; bản sao lưu [ở đâu]. |
| Thời hạn lưu | [180] ngày (đặt được 7–730), quá hạn tự xoá mỗi giờ. |
| Chuyển ra nước ngoài | [Không / tới nhà cung cấp model tại [quốc gia], chỉ để tóm tắt]. |

## 2. Sự cần thiết và tương xứng

- Phương án ít xâm phạm hơn đã cân nhắc: chỉ đào tạo, chặn trang AI, kiểm tra lưu lượng mạng. [Vì sao chọn AI
  Insights, ví dụ chặn thì nhân viên chuyển sang thiết bị cá nhân; kiểm tra mạng thì đọc toàn bộ lưu lượng.]
- Tối thiểu hoá: chỉ các trang AI trong danh sách; chỉ khi bấm gửi; mặc định không ghi câu trả lời; quản lý mặc định chỉ
  thấy chủ đề hoặc tóm tắt; nội dung bị che hay bị chặn không bao giờ được lưu.
- Minh bạch: thông báo trên mọi trang được ghi; thông báo cho nhân viên [đường dẫn]; Của tôi › AI cho mỗi người thấy
  toàn bộ dữ liệu của mình và đúng những gì quản lý thấy.
- Căn cứ xử lý: [sự đồng ý theo Điều 11 Nghị định 13 / căn cứ khác — cần xác nhận]. Nếu là sự đồng ý: phải tự nguyện;
  nói rõ điều gì xảy ra nếu một người không kết nối tiện ích: [không ảnh hưởng gì / chỉ dùng AI của công ty].
- Bảo đảm trong quan hệ lao động (tham khảo GDPR Điều 88): không dùng để chấm điểm hiệu suất hay làm căn cứ duy nhất để
  kỷ luật; [đã tham vấn tổ chức đại diện người lao động ngày …].

## 3. Rủi ro đối với con người

| Rủi ro | Khả năng | Mức độ | Ghi chú |
|---|---|---|---|
| Nhân viên thấy bị theo dõi, né hoặc giấu việc dùng AI | [ ] | [ ] | |
| Quản lý đọc nội dung riêng tư trong câu hỏi | [ ] | [ ] | |
| Dữ liệu prompt bị dùng để đánh giá bất lợi một người | [ ] | [ ] | |
| Máy chủ workspace bị xâm nhập làm lộ prompt | [ ] | [ ] | |
| Phát hiện nhầm dữ liệu nhạy cảm chặn công việc hợp lệ | [ ] | [ ] | |
| Lưu lâu hơn cần thiết | [ ] | [ ] | |

## 4. Biện pháp

| Biện pháp | Tình trạng |
|---|---|
| Mặc định tắt; mã kết nối riêng từng người; thông báo trên mọi trang được ghi | có sẵn |
| Mức chi tiết cho quản lý chủ đề / tóm tắt (một câu do AI viết); ngoài người đó không ai đọc được nội dung câu hỏi | có sẵn; mức của công ty: [ ] |
| Bộ lọc dữ liệu nhạy cảm [cảnh báo/tự che/chặn] và danh sách từ khoá của công ty | đã cấu hình: [ ] |
| Tự xem, xuất (JSON) và yêu cầu xoá trong Của tôi › AI | có sẵn |
| Lưu [180] ngày, tự xoá; nút xoá toàn bộ cho quản trị viên | có sẵn |
| Phân quyền theo vai trò và tuyến báo cáo, máy chủ kiểm tra ở mọi yêu cầu; vai trò cơ sở dữ liệu của mô-đun AI chỉ truy cập được schema của chính nó | có sẵn |
| Gia cố máy chủ, sao lưu mã hoá, rà soát nhật ký truy cập | [ ] |
| Quy định bằng văn bản rằng dữ liệu AI Insights không dùng để chấm điểm người | [đường dẫn chính sách] |
| Hướng dẫn quản lý những gì được và không được làm với dữ liệu | [ ] |

## 5. Kết luận

Rủi ro còn lại: [thấp / trung bình / cao]. Quyết định: [triển khai / triển khai có điều chỉnh / không triển khai].
Người phê duyệt: [họ tên, vai trò, ngày]. Rà soát lần sau: [ngày].
