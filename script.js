/* ====== CẤU HÌNH ====== */

// ⚠️ CHẾ ĐỘ PHÁT TRIỂN: bật để bypass quyền micro và test giao diện
const DEV_MODE = true;

// Nếu DEV_MODE = true, dùng response text cứng thay vì gọi Gemini API
const SIMULATE_GEMINI_RESPONSE = false;

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
	// 🔴 CẤU HÌNH GEMINI LIVE API
	// Lấy từ: https://ai.google.dev/
	// API key được load từ env-config.js
	// ⚠️ CẢNH BÁO BẢO MẬT: key này chạy ở client nên bất kỳ ai mở DevTools
	// cũng lấy được. Với môi trường production nên đổi sang ephemeral token
	// (Gemini Live hỗ trợ) hoặc proxy WebSocket qua backend của bạn.
	apiKey: window.GEMINI_API_KEY,
	
	// gemini-3.6-flash hỗ trợ WebSocket bidirectional
	model: 'gemini-3.6-flash',
	temperature: 0.7
};

// Cấu hình kết nối lại (reconnect) khi WebSocket rớt mạng
const WS_RECONNECT_CONFIG = {
	maxAttempts: 5,
	baseDelayMs: 1000,   // độ trễ lần thử đầu tiên
	maxDelayMs: 15000,   // trần độ trễ giữa các lần thử
	connectTimeoutMs: 10000 // tối đa chờ WebSocket mở trước khi coi là timeout
};

// Bật để in log chi tiết (volume, message payload...). Tắt khi lên production
// để console đỡ rác.
const VERBOSE_LOGGING = false;
function vlog(...args) {
	if (VERBOSE_LOGGING) console.log(...args);
}

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
let speakingIndicator;
let faqPanel;
let transcriptText;

let localMicStream = null;
let isFaqVisible = false;
let isMicOn = true;
let currentAvatarState = 'idle'; // 'idle' | 'listening' | 'speaking'
let isGeminiSpeaking = false; // Track khi Gemini đang nói

// Gemini Live Chat & Audio
let isUserSpeakingActive = false; // Track nếu đang gửi audio
let ws = null; // WebSocket connection
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let wsIsClosingIntentionally = false; // true khi người dùng chủ động ngắt (endBtn)
let audioContext = null;

// FAQ Data
let faqData = [];
let isAvatarInCornerMode = false;
let startListeningBtn;
let fullscreenBtn;

/* ====== TIỆN ÍCH ====== */
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

/* ====== AVATAR STATE ====== */
function setAvatarState(state) {
	if (currentAvatarState === state) return; // Không thay đổi nếu trạng thái giống nhau
	
	currentAvatarState = state;
	console.log(`🎬 Chuyển sang trạng thái avatar: ${state}`);
	
	let label = '';
	
	if (state === 'listening') {
		label = 'Đang nghe bạn nói...';
		avatarVideo.play();
	} else if (state === 'speaking') {
		label = 'Gemini đang nói...';
		isGeminiSpeaking = true;
		speakingIndicator.hidden = false;
		avatarVideo.play();
	} else if (state === 'idle') {
		label = 'Sẵn sàng lắng nghe';
		isGeminiSpeaking = false;
		speakingIndicator.hidden = true;
		// Video vẫn chạy (loop) nhưng state CSS sẽ thay đổi visual
		avatarVideo.play();
		// Tự động ẩn FAQ khi quay về idle
		if (isFaqVisible) {
			isFaqVisible = false;
			applyFaqState(false);
		}
		// 🔴 FIX: Reset volume detection để có thể listening lại
		if (localMicStream && !DEV_MODE) {
			resetMicVolumeDetection();
		}
	}
	
	transcriptText.textContent = label;
	
	// Cập nhật data-state attribute cho CSS animation
	avatarVideo.parentElement.setAttribute('data-state', state);
	
	console.log(`  → Avatar state: ${state}, label: ${label}`);
}

function applyFaqState(show) {
	stage.classList.toggle('stage--faq', show);
	stage.classList.toggle('stage--default', !show);
	faqPanel.style.display = show ? 'flex' : 'none';
	toggleFaqBtn.textContent = show ? 'Ẩn FAQ minh hoạ' : 'Hiện FAQ minh hoạ';
	isAvatarInCornerMode = show;
}

/* ====== FULLSCREEN ====== */
function toggleFullscreen() {
	const elem = document.documentElement;
	const isCurrentlyFullscreen = document.fullscreenElement !== null || 
	                               document.webkitFullscreenElement !== null;
	
	if (!isCurrentlyFullscreen) {
		// Enter fullscreen
		if (elem.requestFullscreen) {
			elem.requestFullscreen().catch(err => {
				console.error('❌ Lỗi vào fullscreen:', err);
			});
		} else if (elem.webkitRequestFullscreen) {
			elem.webkitRequestFullscreen();
		}
	} else {
		// Exit fullscreen
		if (document.exitFullscreen) {
			document.exitFullscreen();
		} else if (document.webkitExitFullscreen) {
			document.webkitExitFullscreen();
		}
	}
}

function updateFullscreenButtonState() {
	const isFullscreen = document.fullscreenElement !== null || 
	                     document.webkitFullscreenElement !== null;
	
	if (fullscreenBtn) {
		fullscreenBtn.classList.toggle('fullscreen-active', isFullscreen);
		fullscreenBtn.title = isFullscreen ? 'Thoát toàn màn hình' : 'Toàn màn hình';
	}
}

/* ====== GIF FAQ ====== */
async function playGifSequence(gifList) {
	console.log('📺 Phát chuỗi GIF FAQ:', gifList);
	
	if (!gifList || gifList.length === 0) {
		console.log('ℹ️ Không có GIF nào để phát');
		return;
	}
	
	// Hiển thị FAQ panel & thu nhỏ avatar
	isFaqVisible = true;
	applyFaqState(true);
	
	const faqGifWrap = document.querySelector('.faq-gif-wrap');
	
	// Phát từng GIF trong danh sách
	for (const gifFile of gifList) {
		console.log('🎬 Phát GIF:', gifFile);
		
		// Tạo/cập nhật thẻ img hoặc video
		let mediaElement = faqGifWrap.querySelector('img') || faqGifWrap.querySelector('video');
		
		if (!mediaElement) {
			// Nếu là video, tạo video element
			if (gifFile.endsWith('.mp4') || gifFile.endsWith('.webm')) {
				mediaElement = document.createElement('video');
				mediaElement.className = 'faq-gif';
				mediaElement.autoplay = true;
				mediaElement.loop = false;
				mediaElement.muted = true;
				mediaElement.playsinline = true;
			} else {
				// Nếu là GIF/PNG, tạo img element
				mediaElement = document.createElement('img');
				mediaElement.className = 'faq-gif';
			}
			faqGifWrap.innerHTML = '';
			faqGifWrap.appendChild(mediaElement);
		}
		
		// Cập nhật source
		if (mediaElement.tagName === 'VIDEO') {
			mediaElement.innerHTML = `<source src="assets/faq_media/${gifFile}" type="video/mp4">`;
		} else {
			mediaElement.src = `assets/faq_media/${gifFile}`;
		}
		
		// Phát 4 giây cho mỗi GIF
		await new Promise(resolve => setTimeout(resolve, 4000));
	}
	
	console.log('✓ Phát xong chuỗi GIF FAQ');
	
	// Giữ FAQ panel mở trong 2 giây nữa rồi đóng
	setTimeout(() => {
		if (!isGeminiSpeaking) {
			isFaqVisible = false;
			applyFaqState(false);
		}
	}, 2000);
}

/* ====== USER SPEAKING DETECTION ====== */
function detectUserSpeaking() {
	// Khi người dùng bắt đầu nói (có audio input)
	// Chuyển sang trạng thái "listening"
	if (currentAvatarState !== 'listening' && !isGeminiSpeaking) {
		setAvatarState('listening');
		console.log('🎤 Người dùng bắt đầu nói');
		
		// 🔴 BẮT ĐẦU GỬI AUDIO SANG GEMINI
		startSendingAudio();
	}
}

function stopUserSpeaking() {
	// Khi người dùng dừng nói
	// Nếu Gemini không nói, quay về idle
	if (!isGeminiSpeaking && currentAvatarState === 'listening') {
		console.log('🤐 Người dùng dừng nói');
		
		// 🔴 DỪNG GỬI AUDIO + GỬI MESSAGE SANG GEMINI NGAY LẬP TỨC
		stopSendingAudio();
		
		// Gửi message mặc định nếu người dùng vừa nói
		console.log('⏱️ Gửi message cho Gemini...');
		sendMessageToGemini('Xin chào');
	}
}

/* ====== SEND TO GEMINI ====== */
function startSendingAudio() {
	if (!localMicStream || isUserSpeakingActive) return;
	isUserSpeakingActive = true;
	console.log('📤 Bắt đầu gửi audio stream...');
}

function stopSendingAudio() {
	if (!isUserSpeakingActive) return;
	
	isUserSpeakingActive = false;
	console.log('📤 Dừng gửi audio stream');
	
	
	// 🔴 GỬI TEXT SANG GEMINI CHAT API
	// Sau khi dừng, gửi user input và nhận response từ Gemini
	sendMessageToGemini();
}

/* ====== MESSAGE & RESPONSE ====== */
async function sendMessageToGemini(userMessage = 'Xin chào') {
	if (!window.geminiChat) {
		console.error('❌ Gemini chat chưa khởi tạo');
		setTimeout(() => setAvatarState('idle'), 500);
		return;
	}
	
	try {
		console.log('📤 Gửi message sang Gemini:', userMessage);
		setAvatarState('speaking');
		
		await sendMessageViaFetchAPI(userMessage);
		
	} catch (err) {
		console.error('❌ Lỗi gửi message:', err);
		transcriptText.textContent = 'Lỗi: ' + err.message;
		setTimeout(() => setAvatarState('idle'), 2000);
	}
}

/* ====== FETCH API ====== */
async function sendMessageViaFetchAPI(userMessage) {
	try {
		console.log('📡 Gửi request tới Gemini API (Fetch fallback)...');
		
		// Setup timeout 10s
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);
		
		// 🔴 BUILD SYSTEM INSTRUCTION WITH TOOL CALLING SUPPORT
		const faqContext = faqData.map(faq => 
			`Q: ${faq.question}\nA: ${faq.answer}\nGIF Sequence: [${faq.gif_sequence.join(', ')}]`
		).join('\n\n');
		
		const systemInstruction = `Bạn là Trợ lý Lễ tân ảo giúp đỡ khách hàng.

DỮ LIỆU FAQ CHÍNH THỨC:
${faqContext}

QUY TẮC:
1. Trả lời các câu hỏi dựa trên FAQ data cung cấp.
2. QUAN TRỌNG: Nếu câu hỏi của người dùng trùng khớp với một Q&A FAQ nào, hãy:
   - Trả lời câu hỏi đó
   - GỌI HÀM trigger_faq_gif_sequence với danh sách GIF tương ứng
3. Nếu câu hỏi ngoài FAQ, hãy từ chối lịch sự mà không gọi hàm.
4. Luôn trả lời bằng Tiếng Việt.`;
		
		const response = await fetch(
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=' + 
			GEMINI_LIVE_CONFIG.apiKey,
			{
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					systemInstruction: {
						parts: [{ text: systemInstruction }]
					},
					contents: [{
						parts: [{
							text: userMessage
						}]
					}],
					tools: [{
						functionDeclarations: [{
							name: "trigger_faq_gif_sequence",
							description: "Bật chuỗi GIF minh hoạ FAQ lên màn hình",
							parameters: {
								type: "OBJECT",
								properties: {
									gif_list: {
										type: "ARRAY",
										items: { type: "STRING" },
										description: "Danh sách tên file GIF cần phát"
									}
								},
								required: ["gif_list"]
							}
						}]
					}]
				}),
				signal: controller.signal
			}
		);
		
		clearTimeout(timeoutId);
		
		if (!response.ok) {
			const errorData = await response.text();
			console.error('❌ API response error:', response.status, response.statusText);
			console.error('📝 Error details:', errorData);
			throw new Error('API response: ' + response.status);
		}
		
		const data = await response.json();
		const responseText = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Xin lỗi, tôi không hiểu.';
		
		console.log('📥 Response từ Gemini (Fetch):', responseText);
		transcriptText.textContent = responseText;
		
		// 🔴 KIỂM TRA TOOL CALLING từ response
		if (data?.candidates?.[0]?.content?.parts) {
			for (const part of data.candidates[0].content.parts) {
				if (part.functionCall) {
					console.log('🔧 Tool Calling detected:', part.functionCall.name);
					if (part.functionCall.name === 'trigger_faq_gif_sequence' && part.functionCall.args.gif_list) {
						playGifSequence(part.functionCall.args.gif_list);
					}
				}
			}
		}
		
		// Phát audio (Fallback: dùng TTS)
		speakText(responseText);
		
		// Quay về idle sau 3s
		setTimeout(() => {
			if (!isAvatarInCornerMode) {
				setAvatarState('idle');
			}
		}, 3000);
		
	} catch (err) {
		console.error('❌ Lỗi Fetch API:', err);
		transcriptText.textContent = 'Lỗi kết nối: ' + err.message;
		setTimeout(() => {
			setAvatarState('idle');
		}, 2000);
	}
}

/* ====== PLAY AUDIO ====== */
function playHelloAudio() {
	console.log('🎵 Phát hello.mp3...');
	
	// Tạo hoặc tái sử dụng audio element
	let audioElement = window.helloAudioElement;
	if (!audioElement) {
		audioElement = new Audio('assets/audio/hello.mp3');
		window.helloAudioElement = audioElement;
	}
	
	// Reset và phát
	audioElement.currentTime = 0;
	audioElement.play().catch(err => {
		console.error('❌ Lỗi phát hello.mp3:', err);
	});
	
	audioElement.onended = () => {
		console.log('✓ Phát hello.mp3 xong');
	};
}

/* ====== TEXT-TO-SPEECH ====== */
function speakText(text) {
	// 🔴 SIMULATE MODE: Phát hello.mp3 thay vì TTS
	if (SIMULATE_GEMINI_RESPONSE) {
		console.log('🔊 [SIMULATE] Phát hello.mp3 thay vì Text-to-Speech');
		playHelloAudio();
		return;
	}
	
	if (!('speechSynthesis' in window)) {
		console.error('❌ Browser không hỗ trợ Text-to-Speech');
		return;
	}
	
	// Cancel any previous speech
	window.speechSynthesis.cancel();
	
	const utterance = new SpeechSynthesisUtterance(text);
	utterance.lang = 'vi-VN'; // Tiếng Việt
	utterance.rate = 1.0;
	utterance.pitch = 1.0;
	utterance.volume = 1.0;
	
	utterance.onstart = () => {
		console.log('🔊 Bắt đầu phát âm thanh...');
	};
	
	utterance.onend = () => {
		console.log('✓ Phát âm thanh xong');
		isGeminiSpeaking = false; // 🔴 FIX: Reset flag khi TTS phát xong
		setAvatarState('idle');
		if (!isAvatarInCornerMode) {
			// Resume volume detection để listening lại
			setupMicVolumeDetection();
		}
	};
	
	utterance.onerror = (event) => {
		console.error('❌ Lỗi Text-to-Speech:', event.error);
		isGeminiSpeaking = false; // 🔴 FIX: Reset flag kể cả khi lỗi
	};
	
	window.speechSynthesis.speak(utterance);
}



/* ====== CONNECT GEMINI ====== */
async function connectGeminiLiveSocket() {
	console.log('  → connectGeminiLiveSocket bắt đầu...');
	const delay = DEV_MODE ? 300 : 600;
	await wait(delay);
	
	// Tải dữ liệu FAQ
	try {
		const faqResponse = await fetch('./data/faq.json');
		faqData = await faqResponse.json();
		console.log('✓ FAQ data đã load:', faqData.length, 'items');
	} catch (err) {
		console.warn('⚠️ Lỗi load FAQ:', err.message);
		faqData = [];
	}
	
	// Trong DEV_MODE hoặc SIMULATE_MODE: dùng fetch API (không cần API key)
	if (DEV_MODE || SIMULATE_GEMINI_RESPONSE) {
		console.log('🔧 Dev/Simulate mode: dùng Fetch API');
		window.geminiChat = { method: 'fetch' };
	} else {
		// Production: kiểm tra API key
		if (!window.GEMINI_API_KEY) {
			throw new Error('API key not found in window.GEMINI_API_KEY');
		}
		console.log('✓ API key đã load');
		window.geminiChat = { method: 'fetch', apiKey: GEMINI_LIVE_CONFIG.apiKey };
	}
	
	console.log('✓ Sẵn sàng dùng Fetch API');
	setAvatarState('idle');
	transcriptText.textContent = 'Kết nối thành công. Bạn có thể bắt đầu nói.';
}

/* ====== START BUTTON ====== */
async function handleStartClick() {
	startBtn.disabled = true;
	startBtn.textContent = DEV_MODE ? 'Đang vào chế độ dev...' : 'Đang xin quyền micro...';
	permissionError.style.display = 'none';

	try {
		console.log('1️⃣ Bắt đầu quá trình bật ứng dụng...');
		
		// 🔴 IN RA MODE HIỆN TẠI
		if (SIMULATE_GEMINI_RESPONSE) {
			console.log('🎭 [SIMULATE MODE] - Sẽ dùng response text cứng');
		} else if (DEV_MODE) {
			console.log('🔧 [DEV MODE] - Bypass micro');
		} else {
			console.log('📱 [PRODUCTION MODE] - Sẽ xin quyền micro thực');
		}

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
			
			// 5. Thiết lập phát hiện micro input (nếu có micro stream)
			if (localMicStream && !DEV_MODE) {
				console.log('5️⃣ Thiết lập phát hiện âm thanh micro...');
				setupMicVolumeDetection();
			} else {
				// DEV_MODE hoặc không có micro → dùng phím tắt
				console.log('5️⃣ Dev mode hoặc không có micro: sử dụng phím tắt để test');
				console.log('   Nhấn phím "L" để test listening');
				console.log('   Nhấn phím "K" để test stop & gửi message');
				console.log('   Nhấn phím "M" để gửi message trực tiếp');
				console.log('   Nhấn phím "S" để test speaking');
				console.log('   Nhấn phím "G" để toggle FAQ');
				setupDevModeShortcuts();
			}
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

/* ====== VOLUME DETECTION ====== */
let silenceTimeout = null;
let volumeDetectionAnimationId = null;
let maxListeningTimeout = null;
const SILENCE_THRESHOLD = 2000; // ms - chờ 2 giây im lặng mới gửi
const MAX_LISTENING_DURATION = 30000; // 30 giây - nếu nghe quá lâu sẽ tự động gửi

function setupMicVolumeDetection() {
	if (!localMicStream) return;
	
	const audioContext = new (window.AudioContext || window.webkitAudioContext)();
	const analyser = audioContext.createAnalyser();
	const microphone = audioContext.createMediaStreamSource(localMicStream);
	
	microphone.connect(analyser);
	analyser.fftSize = 256;
	
	
	const dataArray = new Uint8Array(analyser.frequencyBinCount);
	const VOLUME_THRESHOLD = 80; // 🔴 Tăng từ 30 lên 80 - threshold cao hơn để tránh ambient noise
	let lastSpokeTime = Date.now();
	
	// 🔴 SET MAX LISTENING TIMEOUT (30 giây)
	maxListeningTimeout = setTimeout(() => {
		if (currentAvatarState === 'listening') {
			console.log('⏱️ Timeout: Nghe quá lâu (>30s), tự động gửi message');
			stopUserSpeaking();
		}
	}, MAX_LISTENING_DURATION);
	
	function checkVolume() {
		analyser.getByteFrequencyData(dataArray);
		const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
		
		// 🔴 DEBUG: In ra volume hiện tại mỗi 1 giây
		if (Math.random() < 0.05) { // ~5% chance để không spam log
			vlog(`📊 Volume: ${average.toFixed(1)} (threshold: ${VOLUME_THRESHOLD})`);
		}
		
		if (average > VOLUME_THRESHOLD) {
			// Có âm thanh - người dùng đang nói
			lastSpokeTime = Date.now();
			clearTimeout(silenceTimeout);
			if (currentAvatarState !== 'listening') {
				console.log(`🎤 Phát hiện âm thanh (volume: ${average.toFixed(1)}), bắt đầu listening`);
				detectUserSpeaking();
			}
		} else {
			// Không có âm thanh - chờ xem có tiếp tục nói không
			clearTimeout(silenceTimeout);
			silenceTimeout = setTimeout(() => {
				console.log('🤐 Im lặng quá 2 giây, gửi message...');
				stopUserSpeaking();
			}, SILENCE_THRESHOLD);
		}
		
		volumeDetectionAnimationId = requestAnimationFrame(checkVolume);
	}
	
	checkVolume();
	console.log('✓ Volume detection đã bắt đầu (threshold:', VOLUME_THRESHOLD, 'silence wait:', SILENCE_THRESHOLD, 'ms)');
}

function stopVolumeDetection() {
	if (volumeDetectionAnimationId) {
		cancelAnimationFrame(volumeDetectionAnimationId);
		volumeDetectionAnimationId = null;
	}
	if (silenceTimeout) {
		clearTimeout(silenceTimeout);
		silenceTimeout = null;
	}
	if (maxListeningTimeout) {
		clearTimeout(maxListeningTimeout);
		maxListeningTimeout = null;
	}
	console.log('✓ Volume detection đã dừng');
}

// 🔴 FIX: Reset volume detection khi quay về idle
function resetMicVolumeDetection() {
	stopVolumeDetection();
	if (localMicStream) {
		console.log('🔄 Reset volume detection để listening lại');
		setupMicVolumeDetection();
	}
}

/* ====== DEV MODE SHORTCUTS ====== */
function setupDevModeShortcuts() {
	document.addEventListener('keydown', (e) => {
		// L: mô phỏng người dùng nói
		if (e.key === 'l' || e.key === 'L') {
			console.log('🔑 [DEV] Phím L: listening state');
			detectUserSpeaking();
		}
		
		// K: dừng nói + gửi message
		if (e.key === 'k' || e.key === 'K') {
			console.log('🔑 [DEV] Phím K: stop + send message');
			stopUserSpeaking();
		}
		
		// G: toggle FAQ
		if (e.key === 'g' || e.key === 'G') {
			console.log('🔑 [DEV] Phím G: toggle FAQ');
			isFaqVisible = !isFaqVisible;
			applyFaqState(isFaqVisible);
		}
		
		// M: gửi message test
		if (e.key === 'm' || e.key === 'M') {
			console.log('🔑 [DEV] Phím M: send test message');
			if (window.geminiChat) {
				sendMessageToGemini('Cho tôi biết đây là gì?');
			}
		}
	});
}

/* ====== EVENT LISTENERS ====== */
function attachEventListeners() {
	console.log('✓ Gắn event listeners...');

	// NÚT "BẮT ĐẦU TRÒ CHUYỆN"
	startBtn.addEventListener('click', handleStartClick);

	// NÚT FULLSCREEN
	fullscreenBtn.addEventListener('click', toggleFullscreen);

	// NÚT "BẮTĐẦU LẮNG NGHE" (trong app screen)
	startListeningBtn.addEventListener('click', () => {
		console.log('🔑 Nhấn nút "Bắt đầu trò chuyện"');
		if (!isGeminiSpeaking && currentAvatarState === 'idle') {
			detectUserSpeaking();
		} else {
			console.log('ℹ️ Không thể bắt đầu: Avatar đang nói hoặc đang listening');
		}
	});

	// CHUYỂN ĐỔI FAQ
	// Khi nhấn nút FAQ: hiển thị/ẩn FAQ panel
	// Nếu Gemini đang nói → hiển thị FAQ GIF
	toggleFaqBtn.addEventListener('click', () => {
		isFaqVisible = !isFaqVisible;
		applyFaqState(isFaqVisible);
		
		if (isFaqVisible && isGeminiSpeaking) {
			console.log('📺 Hiển thị FAQ GIF (Gemini đang nói)');
		} else if (isFaqVisible && !isGeminiSpeaking) {
			console.log('📋 Hiển thị FAQ minh hoạ (chờ Gemini nói)');
		}
	});

	// BẬT / TẮT MICRO
	// Khi micro bật → cho phép phát hiện người dùng nói
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
		console.log(isMicOn ? '🎤 Micro bật' : '🔇 Micro tắt');
	});

	// KẾT THÚC CUỘC GỌI
	endBtn.addEventListener('click', () => {
		stopSendingAudio();
		
		// Dừng Text-to-Speech
		if (window.speechSynthesis) {
			window.speechSynthesis.cancel();
		}
		
		// Dừng micro
		if (localMicStream) {
			localMicStream.getTracks().forEach(track => track.stop());
		}
		
		// Reset state
		localMicStream = null;
		avatarPlaceholder.style.display = 'flex';
		applyFaqState(false);
		setConnectionState('idle', 'Đã ngắt kết nối');
		currentAvatarState = 'idle';
		isGeminiSpeaking = false;
		isFaqVisible = false;
		isUserSpeakingActive = false;
		window.geminiChat = null;

		appScreen.style.display = 'none';
		welcomeScreen.style.display = 'flex';
		startBtn.disabled = false;
		startBtn.textContent = 'Nhấn vào đây để bắt đầu trò chuyện';
		
		console.log('✓ Kết thúc cuộc gọi');
	});
}

/* ====== INITIALIZATION ====== */
document.addEventListener('DOMContentLoaded', () => {
	console.log('📄 DOMContentLoaded: Bắt đầu khởi tạo...');

	// Lấy tham chiếu DOM
	welcomeScreen = document.getElementById('welcomeScreen');
	appScreen = document.getElementById('appScreen');
	startBtn = document.getElementById('startBtn');
	permissionError = document.getElementById('permissionError');

	stage = document.getElementById('stage');
	toggleFaqBtn = document.getElementById('toggleFaqBtn');
	startListeningBtn = document.getElementById('startListeningBtn');
	micBtn = document.getElementById('micBtn');
	micLabel = document.getElementById('micLabel');
	endBtn = document.getElementById('endBtn');

	connectionDot = document.getElementById('connectionDot');
	connectionLabel = document.getElementById('connectionLabel');

	avatarVideo = document.getElementById('avatarVideo');
	avatarPlaceholder = document.getElementById('avatarPlaceholder');
	speakingIndicator = document.getElementById('speakingIndicator');
	faqPanel = document.getElementById('faqPanel');
	transcriptText = document.getElementById('transcriptText');
	fullscreenBtn = document.getElementById('fullscreenBtn');

	// Kiểm tra xem tất cả elements đã load
	const elements = {
		welcomeScreen, appScreen, startBtn, transcriptText, stage, 
		toggleFaqBtn, micBtn, micLabel, endBtn, connectionDot, 
		connectionLabel, avatarVideo, avatarPlaceholder,
		speakingIndicator, faqPanel, permissionError, fullscreenBtn
	};

	for (const [key, el] of Object.entries(elements)) {
		if (!el) console.error(`❌ ${key} không tìm thấy`);
	}

	console.log('✓ Tất cả DOM elements đã được tải');

	// Gắn event listeners
	attachEventListeners();
	
	// Fullscreen event listeners
	document.addEventListener('fullscreenchange', updateFullscreenButtonState);
	document.addEventListener('webkitfullscreenchange', updateFullscreenButtonState);
	document.addEventListener('mozfullscreenchange', updateFullscreenButtonState);
	document.addEventListener('MSFullscreenChange', updateFullscreenButtonState);
	
	console.log('✓ Khởi tạo hoàn tát');
});

/* ====== ENVIRONMENT NOTES ====== */
if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
	console.warn('Cảnh báo: trang này cần chạy trên HTTPS hoặc localhost để Micro và WebRTC hoạt động.');
}