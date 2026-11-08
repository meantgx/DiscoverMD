# Máy chủ đa người chơi — Măng Đen 3D

Không cần cài thư viện, chỉ cần Node.js ≥ 18.

## Chạy thử
```
node server.js                       # cổng 8080
node loadtest.js                     # (terminal khác, đặt PORT=8099 cho server) 52 client giả: 50 vào phòng, 2 bị báo "đầy"
```

## Cấu hình (biến môi trường)
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | 8080 | Cổng |
| `MAX_PER_ROOM` | 50 | Số người tối đa mỗi phòng |
| `MAX_ROOMS` | 1 | Số phòng tối đa. Hết chỗ → máy chủ báo `full`, game tự chuyển sang chơi một mình cùng bot (không tốn tài nguyên máy chủ). Muốn phục vụ 200 người đồng thời: `MAX_ROOMS=4`. |
| `TICK_MS` | 200 | Nhịp gửi (5 lần/giây) |
| `AOI_R` / `AOI_MAX` | 120 / 24 | Chỉ gửi cho mỗi người những người chơi ở gần (bán kính, số lượng tối đa) |
| `ALLOWED_ORIGINS` | (trống = cho tất cả) | Danh sách tên miền được phép kết nối, ví dụ `https://mangden.example.com` |

Kiểm tra tình trạng: `GET /health` → số người từng phòng.

## Vì sao nhẹ
- Máy chủ **không mô phỏng thế giới**, chỉ chuyển tiếp vị trí (x, z, hướng, tốc độ, cử chỉ).
- Client chỉ gửi khi có thay đổi, tối đa ~4,5 gói/giây; máy chủ bỏ qua gói vượt 12 gói/giây và gói > 512 byte.
- Mỗi nhịp 200 ms, mỗi client chỉ nhận **người ở gần và có thay đổi** (tối đa 24 người).
- Người ngoài 50 chỗ **chơi một mình với bot**, không kết nối giữ chỗ nào.
- Ước tính một phòng 50 người đang chạy: ra ≲ 250 KB/s (≈ 2 Mbit/s) ở mức tệ nhất, vào ≈ 20 KB/s, CPU rất thấp. Một máy 1 vCPU / 512 MB đủ cho vài phòng.

## Đưa lên mạng (ví dụ)
1. **Máy chủ**: đưa thư mục này lên Render / Railway / Fly.io / VPS (có sẵn `Dockerfile`). Nhà cung cấp cấp HTTPS cho bạn → địa chỉ dạng `wss://mangden-server.onrender.com`.
2. **Trang game**: `index.html` là một file tĩnh duy nhất → đưa lên Cloudflare Pages / Netlify / GitHub Pages (miễn phí, chịu tải lớn). Trang tĩnh không tốn tải máy chủ game.
3. **Nối hai bên**, chọn một cách:
   - Gửi link kèm tham số: `https://trang-game.example.com/?ws=wss://mangden-server.onrender.com`
   - Hoặc thêm dòng này vào `index.html`, ngay trước thẻ `<script>` chính của game: `<script>window.MANGDEN_WS='wss://mangden-server.onrender.com'</script>`

Nếu không đặt địa chỉ máy chủ, game vẫn chạy bình thường: chơi một mình cùng 14 khách ảo (hoặc dùng phòng chung của nền tảng claude.ai cho người đã đăng nhập).

## Giới hạn hiện tại
- Chưa có chat, chưa chống gian lận (máy chủ chỉ giới hạn tốc độ và kích thước, không kiểm tra vị trí có hợp lệ).
- Mọi người chơi nhìn thấy nhau như du khách có tên "Du khách ###"; chưa có tài khoản.
