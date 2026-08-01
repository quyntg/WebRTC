# 🎭 Simulate Mode - Test Luồng Không Cần Gemini API

## ⚙️ Cấu hình

**Tại đầu `script.js`:**

```javascript
// Bật simulate mode
const DEV_MODE = true;
const SIMULATE_GEMINI_RESPONSE = true;  // 🎭 Dùng response text cứng
```

## 🎯 Luồng Test

### Mode 1: Simulate + Text cứng (Hiện tại)
```
DEV_MODE = true
SIMULATE_GEMINI_RESPONSE = true

→ Bypass micro
→ Bypass Gemini API
→ Dùng response text mặc định
→ Bỏ qua Text-to-Speech
→ Test nhanh (~4s/vòng)
```

### Mode 2: Real micro + Simulate response
```
DEV_MODE = true
SIMULATE_GEMINI_RESPONSE = true
// Xin quyền micro (không bypass)

→ Capture voice từ micro
→ Phát hiện "listening" khi nói
→ Phát hiện "stop" khi dừng
→ Gửi response text cứng
→ Bypass TTS
```

### Mode 3: Real micro + Real Gemini API
```
DEV_MODE = false
SIMULATE_GEMINI_RESPONSE = false

→ Xin quyền micro
→ Gửi tới Gemini API thực
→ Phát Text-to-Speech thực
→ Production mode
```

## 🎮 Phím Tắt Dev Mode

| Phím | Hành động | Kết quả |
|------|-----------|--------|
| **L** | Listening | Avatar → listening.gif |
| **K** | Stop + gửi message | Avatar → speaking → idle |
| **M** | Gửi message test | Avatar → speaking → idle (text cứng) |
| **S** | Simulate speaking | Avatar → speaking (3s) → idle |
| **G** | Toggle FAQ | FAQ panel show/hide |

## 📊 Quy Trình Test Nhanh

### Scenario 1: Test luồng cơ bản (< 30s)

```
1. F12 → Console → xem logs
2. Nhấn "Bắt đầu"
3. Xem logs: 🎭 [SIMULATE MODE] 
4. Nhấn L → avatar listening
   → Logs: 🎤 Người dùng bắt đầu nói
5. Nhấn K → avatar speaking + text → idle
   → Logs: 🤐 Người dùng dừng nói
           📤 Gửi message cho Gemini...
           🎭 [SIMULATE] Dùng response text cứng
           📥 Response (Simulated): ...
6. Xem avatar quay về idle
   → Logs: ✓ Simulation kết thúc, quay về idle
```

### Scenario 2: Kiểm tra response text cứng

Các response sẽ random từ danh sách:
1. "Xin chào! Tôi là trợ lý AI của bạn. Có thể tôi giúp gì cho bạn?"
2. "Đây là một bản test luồng. Avatar đang ở trạng thái speaking."
3. "Hệ thống hoạt động bình thường. Luồng: listening → speaking → idle."
4. "Thử nói gì đó với tôi xem sao!"
5. "Luồng đã được cập nhật. Avatar sẽ tự chuyển trạng thái."

Nhấn M nhiều lần để thấy các response khác nhau.

## 📝 Logs Cần Kiểm Tra

### Khởi động
```
1️⃣ Bắt đầu quá trình bật ứng dụng...
🎭 [SIMULATE MODE] - Sẽ dùng response text cứng
2️⃣ 🔧 Dev mode: bypass quyền micro
3️⃣ Chuyển sang màn hình ứng dụng...
4️⃣ Bắt đầu kết nối Gemini Live...
  → connectGeminiLiveSocket bắt đầu...
🎭 [SIMULATE MODE] Bỏ qua khởi tạo Gemini API
✓ Kết nối Gemini Live thành công
5️⃣ 🔧 Dev mode: sử dụng phím tắt để test
```

### Khi nhấn K
```
🎤 Người dùng bắt đầu nói
📤 Bắt đầu gửi audio stream...

🤐 Người dùng dừng nói
📤 Dừng gửi audio stream
⏱️ Gửi message cho Gemini...
🎬 Chuyển sang trạng thái avatar: speaking
📤 Gửi message sang Gemini: Xin chào
🎭 [SIMULATE] Dùng response text cứng
📥 Response (Simulated): [text ngẫu nhiên]
🔊 [SIMULATE] Bỏ qua Text-to-Speech, đã hiển thị text
✓ Simulation kết thúc, quay về idle
🎬 Chuyển sang trạng thái avatar: idle
```

## 🔄 Chuyển Sang Mode Khác

### Test với Real Micro (giữ simulate response)
```javascript
const DEV_MODE = false;  // Xin quyền micro
const SIMULATE_GEMINI_RESPONSE = true;  // Vẫn dùng response cứng
```

### Test Real Gemini API
```javascript
const DEV_MODE = false;
const SIMULATE_GEMINI_RESPONSE = false;
// Cần cập nhật GEMINI_LIVE_CONFIG.apiKey
```

## ✅ Checklist Test

- [ ] Avatar idle → listening (nhấn L)
- [ ] Avatar listening → speaking (nhấn K)
- [ ] Text response hiển thị đúng
- [ ] Avatar speaking → idle (tự động)
- [ ] FAQ toggle hoạt động (nhấn G)
- [ ] Phím M gửi message trực tiếp
- [ ] Các logs hiển thị đúng thứ tự
- [ ] Avatar image thay đổi theo state
- [ ] Connection status đúng

## 🚨 Troubleshooting

| Vấn đề | Giải pháp |
|--------|-----------|
| Avatar không thay đổi | Check logs, tìm error |
| Text không hiển thị | DevTools → check `transcriptText` element |
| Luôn ở listening | Kiểm tra `stopUserSpeaking()` được gọi |
| Không có response | Kiểm tra `SIMULATE_GEMINI_RESPONSE = true` |
| TTS vẫn phát | Kiểm tra `DEV_MODE = true` |

## 💡 Tips

- **Giữ DevTools mở** (F12) để xem logs real-time
- **Filter logs**: Search `🎭` để xem simulate logs
- **Speed up test**: Nhấn phím nhanh để test multiple scenarios
- **Screenshot states**: Capture avatar ở các state khác nhau

## 🎬 Sau Khi Confirm Luồng OK

```javascript
// Đổi sang production
const DEV_MODE = false;
const SIMULATE_GEMINI_RESPONSE = false;
```

Lúc này sẽ:
- ✅ Xin quyền micro thực
- ✅ Phát hiện voice real
- ✅ Gửi tới Gemini API
- ✅ Phát TTS real
