# Luồng Logic Avatar WebRTC - Gemini Live

## Tổng quan
Ứng dụng quản lý các trạng thái avatar theo luồng tương tác:
- **Idle** (mặc định): Hiển thị idle.gif - sẵn sàng lắng nghe
- **Listening**: Hiển thị listening.gif - người dùng đang nói
- **Speaking**: Hiển thị speaking.gif - Gemini đang trả lời

## Trạng thái và Chuyển đổi

```
┌─────────────────────────────────────────────────────────────────┐
│                   [Trang thái mặc định: Phát idle.gif]          │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
        [Người dùng bắt    [Gemini phát giọng nói]
         đầu nói đầu tiên]    (Chuyển sang speaking.gif)
        (Chuyển sang         │
         listening.gif)      ├─→ (Không có FAQ)
                │            │   → Giữ speaking.gif
                │            │   → Khi xong → idle.gif
                │            │
                │            └─→ (Có FAQ GIF)
                │                → Thu nhỏ avatar
                │                → Hiển thị FAQ GIF
                │                → Khi Gemini nói xong
                │                  → Trở về idle.gif
                │
                └─→ Dừng nói → idle.gif
```

## Các GIF/Hình ảnh cần thiết

| Trạng thái | File | Mô tả |
|-----------|------|-------|
| Idle | `/Mascot NLM 2907.png` | Avatar đang chờ (mặc định) |
| Listening | `/listening.gif` | Avatar lắng nghe người dùng nói |
| Speaking | `/speaking.gif` | Avatar Gemini đang trả lời |
| FAQ | `/cute.mp4` | Video/GIF minh hoạ cho FAQ (hiển thị cạnh avatar) |

## Dev Mode - Phím tắt để Test

**Kích hoạt:** Đặt `DEV_MODE = true` trong `script.js`

| Phím | Hành động | Mô tả |
|------|-----------|-------|
| **L** | Listening | Mô phỏng người dùng bắt đầu nói |
| **K** | Stop | Mô phỏng dừng nói |
| **S** | Speaking | Mô phỏng Gemini nói trong 3 giây |
| **G** | FAQ | Toggle hiển thị/ẩn FAQ panel |

### Ví dụ test quy trình:
1. Nhấn "Nhấn vào đây để bắt đầu trò chuyện"
2. Nhấn **L** → avatar chuyển sang listening.gif
3. Nhấn **K** → avatar quay về idle.gif
4. Nhấn **S** → avatar chuyển sang speaking.gif
5. Nhấn **G** (khi speaking) → hiển thị FAQ GIF cạnh avatar
6. Đợi 3 giây → avatar tự động quay về idle.gif và ẩn FAQ

## Các hàm chính

### `setAvatarState(state)`
Thay đổi trạng thái avatar
- `state`: 'idle' | 'listening' | 'speaking'
- Cập nhật hình ảnh, âm thanh chỉ dẫn, và CSS animation

### `detectUserSpeaking()`
Phát hiện khi người dùng bắt đầu nói
- Gọi khi volume micro vượt ngưỡng
- Chuyển sang trạng thái 'listening'

### `stopUserSpeaking()`
Phát hiện khi người dùng dừng nói
- Gọi khi không có âm thanh trong 500ms
- Quay về 'idle' (nếu Gemini không nói)

### `simulateGeminiSpeaking(duration)`
Mô phỏng Gemini nói (dùng cho dev/test)
- `duration`: thời gian nói (ms), mặc định 3000ms
- Chuyển sang 'speaking'
- Hiển thị FAQ nếu được bật

### `applyFaqState(show)`
Hiển thị/ẩn FAQ panel
- Thu nhỏ avatar về góc trên trái
- Hiển thị FAQ video/GIF ở giữa

## Xử lý WebSocket thực tế

Khi tích hợp Gemini Live API thực, cần:

1. **Khi nhận audio từ Gemini:**
   ```javascript
   setAvatarState('speaking');
   if (isFaqVisible) applyFaqState(true);
   ```

2. **Khi Gemini nói xong:**
   ```javascript
   setAvatarState('idle');
   ```

3. **Khi người dùng nói (phát hiện từ WebSocket):**
   ```javascript
   detectUserSpeaking();
   ```

## Liên kết WebSocket

```
┌─────────────────────────────────────────────────────────────┐
│              Ứng dụng Web (Frontend)                        │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Avatar Frame (GIF - idle/listening/speaking)          │  │
│  │ + FAQ Minh hoạ (GIF - khi có FAQ)                     │  │
│  │ + Micro & Loa                                          │  │
│  └───────────────────────────────────────────────────────┘  │
└────────────────────┬────────────────────────────────────────┘
                     │ WebSocket 2 chiều
                     │ (Audio & Data)
                     ▼
        [Google Gemini Live API]
```

## Ghi chú

- **FAQ tự động ẩn:** Khi quay về idle, FAQ panel tự động ẩn
- **Micro detection:** Sử dụng Web Audio API để phát hiện volume
- **Responsive:** Layout thay đổi dựa trên kích thước avatar frame
- **Mobile-friendly:** Hỗ trợ cảm ứng và responsive design

## Tính năng tương lai

- [ ] Tích hợp Gemini Live API thực
- [ ] Tích hợp Simli Avatar WebRTC
- [ ] Xác nhận FAQ GIF từ Gemini (thông qua response metadata)
- [ ] Phát hiện khi nào Gemini bắt đầu/kết thúc nói
- [ ] Cải thiện UI/UX cho mobile
