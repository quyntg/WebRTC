/* ==================================================================
   CẤU HÌNH
================================================================== */

// ⚠️ CHẾ ĐỘ PHÁT TRIỂN: bật để bypass quyền micro và test giao diện
const DEV_MODE = true;

// Cấu hình Micro chuẩn để tránh tiếng ồn / tiếng vọng khi gửi âm
// thanh người dùng sang Gemini Live API.
const audioConstraints = {
	audio: {
		echoCancellation: true, // Khử tiếng vọng
		noiseSuppression: true, // Lọc tiếng ồn
		autoGainControl: true // Cân bằng độ to nhỏ
	}
};

const GEMINI_LIVE_CONFIG = {
	// websocketUrl: "wss://your-gemini-live-endpoint",
	// apiKey: "YOUR_GEMINI_API_KEY",
};

// Biến toàn cục
let welcomeScreen;
let appScreen;
let startBtn;
let permissionError;
let stage;
let toggleFaqBtn;
let micBtn;
let micLabel;
let endBtn;
let connectionDot;
let connectionLabel;
let avatarVideo;
let avatarPlaceholder;
let remoteAudio;
let speakingIndicator;
let faqPanel;
let transcriptText;

let localMicStream = null;
let isFaqVisible = false;
let isMicOn = true;

/* ==================================================================
   TIỆN ÍCH
================================================================== */
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function setConnectionState(state, label) {
	console.log(`🔄 setConnectionState('${state}', '${label}')`);
	console.log('  → connectionDot hiện tại:', connectionDot);
	console.log('  → connectionLabel hiện tại:', connectionLabel);
	connectionDot.className = 'status-dot';
	if (state === 'connecting') connectionDot.classList.add('is-connecting');
	if (state === 'connected') connectionDot.classList.add('is-connected');
	if (state === 'error') connectionDot.classList.add('is-error');
	connectionLabel.textContent = label;
	console.log('  → connectionDot.className sau thay đổi:', connectionDot.className);
	console.log('  → connectionLabel.textContent sau thay đổi:', connectionLabel.textContent);
}

function applyFaqState(show) {
	stage.classList.toggle('stage--faq', show);
	stage.classList.toggle('stage--default', !show);
	faqPanel.style.display = show ? 'flex' : 'none';
	
	// Force image reload by clearing src first
	const newSrc = show ? '/ava.jpg' : '/ava doc.jpg';
	avatarVideo.src = '';
	avatarVideo.src = newSrc;
	
	toggleFaqBtn.textContent = show ? 'Ẩn FAQ minh hoạ' : 'Hiện FAQ minh hoạ';
}

/* ==================================================================
   TÍCH HỢP GEMINI LIVE API (WebSocket streaming)
================================================================== */
async function connectGeminiLiveSocket() {
	console.log('  → connectGeminiLiveSocket bắt đầu...');
	const delay = DEV_MODE ? 300 : 600;
	await wait(delay);
	console.log('  → connectGeminiLiveSocket hoàn tát');
	console.log('  → Cập nhật transcript text...');
	console.log('  → transcriptText hiện tại:', transcriptText);
	console.log('  → transcriptText.textContent cũ:', transcriptText.textContent);
	transcriptText.textContent = 'Kết nối thành công. Bạn có thể bắt đầu nói.';
	console.log('  → transcriptText.textContent mới:', transcriptText.textContent);
}

/* ==================================================================
   XỬ LÝ NÚT "BẮT ĐẦU"
================================================================== */
async function handleStartClick() {
	startBtn.disabled = true;
	startBtn.textContent = DEV_MODE ? 'Đang vào chế độ dev...' : 'Đang xin quyền micro...';
	permissionError.style.display = 'none';

	try {
		console.log('1️⃣ Bắt đầu quá trình bật ứng dụng...');

		// 1. Xin quyền mở Micro (hoặc skip nếu dev mode)
		if (!DEV_MODE) {
			console.log('2️⃣ Yêu cầu quyền micro...');
			localMicStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
			console.log('✓ Đã cấp quyền micro thành công');
		} else {
			console.log('2️⃣ 🔧 Dev mode: bypass quyền micro');
			localMicStream = null;
		}

		console.log('3️⃣ Chuyển sang màn hình ứng dụng...');
		welcomeScreen.style.display = 'none';
		appScreen.style.display = 'flex';
		applyFaqState(false);
		setConnectionState('connecting', 'Đang kết nối...');

		console.log('4️⃣ Bắt đầu kết nối Gemini Live...');
		try {
			await connectGeminiLiveSocket();
			avatarPlaceholder.style.display = 'none';
			console.log('✓ Kết nối Gemini Live thành công');
			setConnectionState('connected', 'Đã kết nối');
		} catch (connectionErr) {
			console.error('✗ Lỗi kết nối:', connectionErr);
			welcomeScreen.style.display = 'flex';
			appScreen.style.display = 'none';
			throw connectionErr;
		}
	} catch (err) {
		console.error('❌ Lỗi chung:', err);
		startBtn.disabled = false;
		startBtn.textContent = 'Nhấn vào đây để bắt đầu trò chuyện';
		permissionError.style.display = 'block';

		if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
			permissionError.textContent = 'Bạn cần cho phép quyền truy cập Micro để tiếp tục. Hãy kiểm tra biểu tượng khoá trên thanh địa chỉ.';
		} else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
			permissionError.textContent = 'Trang web cần chạy trên HTTPS hoặc localhost để có thể sử dụng Micro và WebRTC.';
		} else {
			permissionError.textContent = 'Không thể kết nối. Vui lòng thử lại. (' + (err.message || 'Lỗi không xác định') + ')';
		}

		if (localMicStream) {
			localMicStream.getTracks().forEach(track => track.stop());
			localMicStream = null;
		}
	}
}

/* ==================================================================
   GẮN EVENT LISTENERS
================================================================== */
function attachEventListeners() {
	console.log('✓ Gắn event listeners...');

	// NÚT "BẮT ĐẦU TRÒ CHUYỆN"
	startBtn.addEventListener('click', handleStartClick);

	// CHUYỂN ĐỔI FAQ
	toggleFaqBtn.addEventListener('click', () => {
		isFaqVisible = !isFaqVisible;
		applyFaqState(isFaqVisible);
	});

	// BẬT / TẮT MICRO
	micBtn.addEventListener('click', () => {
		if (!localMicStream) {
			console.log('ℹ️ Dev mode: không có stream micro để bật/tắt');
			return;
		}
		isMicOn = !isMicOn;
		localMicStream.getAudioTracks().forEach(track => {
			track.enabled = isMicOn;
		});
		micBtn.setAttribute('aria-pressed', String(isMicOn));
		micLabel.textContent = isMicOn ? 'Micro bật' : 'Micro tắt';
	});

	// KẾT THÚC CUỘC GỌI
	endBtn.addEventListener('click', () => {
		if (localMicStream) {
			localMicStream.getTracks().forEach(track => track.stop());
		}
		localMicStream = null;
		avatarVideo.srcObject = null;
		remoteAudio.srcObject = null;
		avatarPlaceholder.style.display = 'flex';
		applyFaqState(false);
		setConnectionState('idle', 'Đã ngắt kết nối');

		appScreen.style.display = 'none';
		welcomeScreen.style.display = 'flex';
		startBtn.disabled = false;
		startBtn.textContent = 'Nhấn vào đây để bắt đầu trò chuyện';
	});
}

/* ==================================================================
   KHỞI TẠO KHI DOM LOAD XONG
================================================================== */
document.addEventListener('DOMContentLoaded', () => {
	console.log('📄 DOMContentLoaded: Bắt đầu khởi tạo...');

	// Lấy tham chiếu DOM
	welcomeScreen = document.getElementById('welcomeScreen');
	appScreen = document.getElementById('appScreen');
	startBtn = document.getElementById('startBtn');
	permissionError = document.getElementById('permissionError');

	stage = document.getElementById('stage');
	toggleFaqBtn = document.getElementById('toggleFaqBtn');
	micBtn = document.getElementById('micBtn');
	micLabel = document.getElementById('micLabel');
	endBtn = document.getElementById('endBtn');

	connectionDot = document.getElementById('connectionDot');
	connectionLabel = document.getElementById('connectionLabel');

	avatarVideo = document.getElementById('avatarVideo');
	avatarPlaceholder = document.getElementById('avatarPlaceholder');
	remoteAudio = document.getElementById('remoteAudio');
	speakingIndicator = document.getElementById('speakingIndicator');
	faqPanel = document.getElementById('faqPanel');
	transcriptText = document.getElementById('transcriptText');

	// Kiểm tra xem tất cả elements đã load
	const elements = {
		welcomeScreen, appScreen, startBtn, transcriptText, stage, 
		toggleFaqBtn, micBtn, micLabel, endBtn, connectionDot, 
		connectionLabel, avatarVideo, avatarPlaceholder, remoteAudio,
		speakingIndicator, faqPanel, permissionError
	};

	for (const [key, el] of Object.entries(elements)) {
		if (!el) console.error(`❌ ${key} không tìm thấy`);
	}

	console.log('✓ Tất cả DOM elements đã được tải');

	// Gắn event listeners
	attachEventListeners();
	console.log('✓ Khởi tạo hoàn tát');
});

/* ==================================================================
   GHI CHÚ MÔI TRƯỜNG
================================================================== */
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
	console.warn('Cảnh báo: trang này cần chạy trên HTTPS hoặc localhost để Micro và WebRTC hoạt động.');
}
