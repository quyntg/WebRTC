/* ==================================================================
   CẤU HÌNH
================================================================== */

// ⚠️ CHẾ ĐỘ PHÁT TRIỂN: bật để bypass quyền micro và test giao diện
const DEV_MODE = false;

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
let remoteAudio;
let speakingIndicator;
let faqPanel;
let transcriptText;

let localMicStream = null;
let isFaqVisible = false;
let isMicOn = true;
let currentAvatarState = 'idle'; // 'idle' | 'listening' | 'speaking'
let isGeminiSpeaking = false; // Track khi Gemini đang nói

// Gemini Live Chat & Audio
let audioProcessor = null;
let isUserSpeakingActive = false; // Track nếu đang gửi audio
let ws = null; // WebSocket connection
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let wsIsClosingIntentionally = false; // true khi người dùng chủ động ngắt (endBtn)
let audioContext = null;
let audioBuffer = []; // Buffer audio chunks từ Gemini

// FAQ Data
let faqData = [];
let isAvatarInCornerMode = false;
let startListeningBtn;

/* ==================================================================
   TIỆN ÍCH
================================================================== */
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Load Gemini SDK dynamically if not already loaded
function loadGeminiSDK() {
	return new Promise((resolve, reject) => {
		if (window.GoogleGenerativeAI) {
			console.log('✓ Gemini SDK đã có sẵn');
			resolve();
			return;
		}
		
		console.log('⏳ Load Gemini SDK từ CDN...');
		const script = document.createElement('script');
		script.src = 'https://cdn.jsdelivr.net/npm/@google/generative-ai@0.11.4/dist/generative-ai.umd.js';
		script.async = true;
		script.onload = () => {
			console.log('✓ Gemini SDK loaded thành công');
			resolve();
		};
		script.onerror = () => {
			console.error('❌ Lỗi load Gemini SDK');
			reject(new Error('Failed to load Gemini SDK'));
		};
		document.head.appendChild(script);
	});
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

/* ==================================================================
   QUẢN LÝ TRẠNG THÁI AVATAR (idle, listening, speaking)
================================================================== */
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

/* ==================================================================
   PHÁT SEQUENCE GIF FAQ (Chuỗi hình ảnh minh hoạ)
================================================================== */
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
	const faqImg = document.querySelector('.faq-gif') || faqGifWrap.querySelector('img');
	
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

/* ==================================================================
   PHÁT HIỆN ÂM THANH NGƯỜI DÙNG (Micro Activity Detection)
================================================================== */
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

/* ==================================================================
   GỬI AUDIO/TEXT SANG GEMINI LIVE API
================================================================== */
function startSendingAudio() {
	if (!localMicStream || isUserSpeakingActive) return;
	
	isUserSpeakingActive = true;
	console.log('📤 Bắt đầu gửi audio stream...');
	
	// ⚠️ LƯU Ý: Để xử lý audio thực, cần tích hợp Web Speech API
	// Bây giờ chúng ta sẽ capture text transcript từ audio
	// và gửi sang Gemini Chat API
	
	// TODO: Tích hợp Web Speech API để chuyển audio → text
	// Hoặc gửi audio binary nếu Gemini API hỗ trợ
	
	console.log('ℹ️ Audio streaming có thể yêu cầu backend proxy cho gRPC');
}

function stopSendingAudio() {
	if (!isUserSpeakingActive) return;
	
	isUserSpeakingActive = false;
	console.log('📤 Dừng gửi audio stream');
	
	if (audioProcessor) {
		audioProcessor.disconnect();
		audioProcessor = null;
	}
	
	// 🔴 GỬI TEXT SANG GEMINI CHAT API
	// Sau khi dừng, gửi user input và nhận response từ Gemini
	sendMessageToGemini();
}

/* ==================================================================
   GỬI MESSAGE SANG GEMINI VÀ NHẬN RESPONSE
================================================================== */
async function sendMessageToGemini(userMessage = 'Xin chào') {
	if (!window.geminiChat) {
		console.error('❌ Gemini chat chưa khởi tạo');
		// Ngay lập tức quay về idle thay vì chờ
		setTimeout(() => setAvatarState('idle'), 500);
		return;
	}
	
	try {
		console.log('📤 Gửi message sang Gemini:', userMessage);
		// Chuyển sang speaking state ngay
		setAvatarState('speaking');
		
		// 🔴 KIỂM TRA SIMULATE MODE (DEV_MODE + SIMULATE_GEMINI_RESPONSE)
		if (SIMULATE_GEMINI_RESPONSE) {
			console.log('🎭 [SIMULATE] Dùng response text cứng thay vì gọi API');
			
			// Danh sách responses mặc định
			const simulatedResponses = [
				'Xin chào! Tôi là trợ lý AI của bạn. Có thể tôi giúp gì cho bạn?',
				'Đây là một bản test luồng. Avatar đang ở trạng thái speaking.',
				'Hệ thống hoạt động bình thường. Luồng: listening → speaking → idle.',
				'Thử nói gì đó với tôi xem sao!',
				'Luồng đã được cập nhật. Avatar sẽ tự chuyển trạng thái.'
			];
			
			// Chọn response random
			const responseText = simulatedResponses[Math.floor(Math.random() * simulatedResponses.length)];
			
			console.log('📥 Response (Simulated):', responseText);
			transcriptText.textContent = responseText;
			
			// 🔴 PHÁT ÂM THANH RESPONSE
			speakText(responseText);
			
			// 🎯 MOCK TOOL CALLING - Ngẫu nhiên trigger FAQ GIF
			if (Math.random() > 0.5 && faqData.length > 0) {
				const randomFaq = faqData[Math.floor(Math.random() * faqData.length)];
				if (randomFaq.gif_sequence && randomFaq.gif_sequence.length > 0) {
					console.log('🔧 [MOCK] Tool Calling: trigger_faq_gif_sequence');
					setTimeout(() => playGifSequence(randomFaq.gif_sequence), 1000);
				}
			}
			
			// Sau khi nói xong, quay về idle (chờ hello.mp3 phát xong ~3s + buffer)
			setTimeout(() => {
				console.log('✓ Simulation kết thúc, quay về idle');
				if (!isAvatarInCornerMode) {
					setAvatarState('idle');
				}
			}, 5000);
			
			return; // ⭐ Kết thúc nếu là simulation
		}
		
		// 🔴 KIỂM TRA SỬ DỤNG SDK HAY WEBSOCKET FALLBACK
		if (window.geminiChat.method === 'websocket') {
			// Dùng WebSocket
			console.log('📡 Dùng WebSocket');
			sendMessageViaWebSocket(userMessage);
			return;
		}
		
		if (window.geminiChat.method === 'fetch') {
			// Fallback: dùng REST API trực tiếp
			console.log('📡 Dùng fetch API (SDK chưa load)');
			await sendMessageViaFetchAPI(userMessage);
			return;
		}
		
		// Gửi message qua SDK
		console.log('Gửi qua SDK');
		const result = await window.geminiChat.sendMessage(userMessage);
		const response = await result.response;
		const responseText = response.text();
		
		console.log('📥 Response từ Gemini:', responseText);
		transcriptText.textContent = responseText;
		
		// 🔴 KIỂM TRA TOOL CALLING (Nếu Gemini gọi hàm trigger_faq_gif_sequence)
		if (response.functionCalls && response.functionCalls.length > 0) {
			const faqCall = response.functionCalls.find(c => c.name === 'trigger_faq_gif_sequence');
			if (faqCall && faqCall.args.gif_list) {
				console.log('🔧 Tool Calling detected: trigger_faq_gif_sequence');
				playGifSequence(faqCall.args.gif_list);
			}
		}
		
		// 🔴 PHÁT ÂM THANH RESPONSE (cần Text-to-Speech)
		speakText(responseText);
		
		// Sau khi nói xong, quay về idle
		setTimeout(() => {
			if (!isAvatarInCornerMode) {
				setAvatarState('idle');
			}
		}, 3000);
		
	} catch (err) {
		console.error('❌ Lỗi gửi message:', err);
		transcriptText.textContent = 'Lỗi: ' + err.message;
		// Quay về idle sau 2s
		setTimeout(() => {
			setAvatarState('idle');
		}, 2000);
	}
}

/* ==================================================================
   GEMINI LIVE WebSocket: GỬI MESSAGE & NHẬN AUDIO RESPONSE
================================================================== */
function buildGeminiWebSocketUrl() {
	const apiKey = GEMINI_LIVE_CONFIG.apiKey;
	if (!apiKey) {
		throw new Error('Thiếu GEMINI_API_KEY (kiểm tra env-config.js)');
	}
	// Live API chỉ chạy qua wss:// (không có biến thể ws:// cho localhost),
	// nên không cần nhánh chọn protocol theo location.protocol.
	return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
}

function sendSetupMessage(socket) {
	const faqContext = faqData.map(faq => ({
		question: faq.question,
		answer: faq.answer,
		gif_sequence: faq.gif_sequence
	}));

	const setupMsg = {
		setup: {
			model: "models/gemini-3.6-flash",
			generationConfig: {
				responseModalities: ["AUDIO"]
			},
			systemInstruction: {
				parts: [{
					text: `Bạn là Trợ lý Lễ tân ảo. Dưới đây là dữ liệu FAQ chính thức:\n${JSON.stringify(faqContext)}\n\nQUY TẮC:\n1. Trả lời khéo léo dựa trên FAQ.\n2. Nếu câu hỏi của người dùng trùng khớp FAQ nào có 'gif_sequence', BẮT BUỘC gọi hàm trigger_faq_gif_sequence cùng lúc trả lời.\n3. Nếu câu hỏi ngoài FAQ, hãy từ chối lịch sự và KHÔNG gọi hàm.\n4. Luôn trả lời bằng Tiếng Việt.`
				}]
			}
		}
	};

	vlog('📤 Gửi setup message:', setupMsg);
	socket.send(JSON.stringify(setupMsg));
}

function handleGeminiSocketMessage(event) {
	vlog('📨 Nhận message từ WebSocket:', event.data.substring(0, 200));
	let data;
	try {
		data = JSON.parse(event.data);
	} catch (err) {
		console.error('❌ Không parse được message từ WebSocket:', err);
		return;
	}

	// 🔴 NHẬN AUDIO CHUNK TỪ GEMINI
	if (data.serverContent?.modelTurn?.parts) {
		setAvatarState('speaking');

		for (const part of data.serverContent.modelTurn.parts) {
			if (part.inlineData?.mimeType?.includes('audio')) {
				playAudioChunk(part.inlineData.data);
			}
			if (part.text) {
				transcriptText.textContent = part.text;
			}
		}
	}

	// 🔴 NHẬN TÍN HIỆU GỌI HÀM TOOL CALLING
	if (data.toolCall) {
		const call = data.toolCall.functionCalls?.find(c => c.name === "trigger_faq_gif_sequence");
		if (call && call.args?.gif_list) {
			console.log('📺 Trigger FAQ GIF:', call.args.gif_list);
			playGifSequence(call.args.gif_list);
		}
	}

	// 🔴 KHI AI KẾT THÚC CÂU NÓI
	if (data.serverContent?.turnComplete) {
		setTimeout(() => {
			if (!isAvatarInCornerMode) {
				setAvatarState('idle');
			}
		}, 1000);
	}
}

// Đóng WebSocket một cách chủ động (người dùng bấm "Kết thúc cuộc gọi",
// hoặc khi ta muốn mở lại kết nối mới). Đặt cờ này để onclose không
// tự động reconnect.
function closeGeminiLiveWebSocket() {
	wsIsClosingIntentionally = true;
	clearTimeout(wsReconnectTimer);
	wsReconnectTimer = null;
	wsReconnectAttempts = 0;
	if (ws) {
		ws.onopen = null;
		ws.onmessage = null;
		ws.onerror = null;
		ws.onclose = null;
		if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
			ws.close();
		}
		ws = null;
	}
}

// Thử kết nối lại với backoff tăng dần (1s, 2s, 4s... tối đa maxDelayMs)
function scheduleGeminiReconnect() {
	if (wsIsClosingIntentionally) return;
	if (wsReconnectAttempts >= WS_RECONNECT_CONFIG.maxAttempts) {
		console.error('❌ Đã thử reconnect quá số lần cho phép, dừng lại');
		setConnectionState('error', 'Mất kết nối, vui lòng thử lại');
		return;
	}

	wsReconnectAttempts += 1;
	const delay = Math.min(
		WS_RECONNECT_CONFIG.baseDelayMs * 2 ** (wsReconnectAttempts - 1),
		WS_RECONNECT_CONFIG.maxDelayMs
	);

	console.warn(`⚠️ WebSocket rớt, thử kết nối lại lần ${wsReconnectAttempts}/${WS_RECONNECT_CONFIG.maxAttempts} sau ${delay}ms`);
	setConnectionState('connecting', 'Mất kết nối, đang thử lại...');

	wsReconnectTimer = setTimeout(() => {
		initGeminiLiveWebSocket();
	}, delay);
}

function initGeminiLiveWebSocket() {
	try {
		console.log('📡 Khởi tạo Gemini Live WebSocket...');
		wsIsClosingIntentionally = false;

		const wsUrl = buildGeminiWebSocketUrl();
		const socket = new WebSocket(wsUrl);
		ws = socket;

		socket.onopen = () => {
			// Kết nối thành công → reset bộ đếm reconnect
			wsReconnectAttempts = 0;
			console.log('✓ WebSocket kết nối thành công');
			setConnectionState('connected', 'Đã kết nối');
			sendSetupMessage(socket);
		};

		socket.onmessage = handleGeminiSocketMessage;

		socket.onerror = (err) => {
			console.error('❌ WebSocket error:', err);
			transcriptText.textContent = 'Lỗi kết nối WebSocket, đang thử kết nối lại...';
			// Không set ws = null hay reconnect ở đây: sự kiện onclose sẽ
			// luôn được trình duyệt gọi ngay sau onerror, ta xử lý reconnect ở đó.
		};

		// Đặt tên tham số rõ ràng (event), tránh phụ thuộc biến window.event
		// toàn cục vốn không đáng tin cậy và có thể undefined.
		socket.onclose = (event) => {
			console.log(`⚠️ WebSocket đóng (code: ${event.code}, reason: ${event.reason || 'không rõ'})`);
			ws = null;
			setAvatarState('idle');

			if (!wsIsClosingIntentionally) {
				setConnectionState('error', 'Mất kết nối');
				scheduleGeminiReconnect();
			}
		};

		return true;
	} catch (err) {
		console.error('❌ Lỗi init WebSocket:', err);
		return false;
	}
}

// 🔴 PHÁT AUDIO CHUNK TỪ GEMINI (base64 → AudioContext)
function playAudioChunk(base64Audio) {
	try {
		if (!audioContext) {
			audioContext = new (window.AudioContext || window.webkitAudioContext)();
		}
		
		// Decode base64 thành binary
		const binaryString = atob(base64Audio);
		const bytes = new Uint8Array(binaryString.length);
		for (let i = 0; i < binaryString.length; i++) {
			bytes[i] = binaryString.charCodeAt(i);
		}
		
		// Decode WAV/MP3 audio
		audioContext.decodeAudioData(
			bytes.buffer,
			(decodedData) => {
				const source = audioContext.createBufferSource();
				source.buffer = decodedData;
				source.connect(audioContext.destination);
				source.start();
				console.log('🔊 Phát audio chunk');
			},
			(err) => {
				console.error('❌ Decode audio error:', err);
			}
		);
	} catch (err) {
		console.error('❌ Play audio chunk error:', err);
	}
}

// 🔴 GỬI MESSAGE SANG GEMINI LIVE QUA WebSocket
function sendMessageViaWebSocket(userMessage) {
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		console.error('❌ WebSocket chưa kết nối');
		setAvatarState('idle');
		return;
	}
	
	try {
		const clientMsg = {
			clientContent: {
				turns: [{
					parts: [{
						text: userMessage
					}]
				}],
				turnComplete: true
			}
		};
		
		console.log('📤 Gửi message via WebSocket:', userMessage);
		ws.send(JSON.stringify(clientMsg));
	} catch (err) {
		console.error('❌ Lỗi gửi message via WebSocket:', err);
		setAvatarState('idle');
	}
}

/* ==================================================================
   FALLBACK: GỬI MESSAGE QUA FETCH API TRỰC TIẾP
================================================================== */
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
			'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash-latest:generateContent?key=' + 
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

/* ==================================================================
   PHÁT ÂM THANH AUDIO FILE (hello.mp3)
================================================================== */
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

/* ==================================================================
   TEXT-TO-SPEECH: PHÁT NÓI TỪ TEXT
================================================================== */
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
	};
	
	utterance.onerror = (event) => {
		console.error('❌ Lỗi Text-to-Speech:', event.error);
	};
	
	window.speechSynthesis.speak(utterance);
}

/* ==================================================================
   HELPER: CHUYỂN ĐỔI AUDIO DATA SANG PCM 16-BIT
   ⚠️ Dành cho tương lai khi tích hợp WebSocket/gRPC audio streaming
================================================================== */
function convertToPCM16(audioData) {
	const pcm16 = new Int16Array(audioData.length);
	for (let i = 0; i < audioData.length; i++) {
		pcm16[i] = Math.max(-1, Math.min(1, audioData[i])) * 0x7FFF;
	}
	return pcm16.buffer;
}

/* ==================================================================
   PHÁT ÂM THANH (dùng Text-to-Speech hoặc Web Audio API)
================================================================== */
function playAudioBuffer(audioBuffer) {
	// Nếu có audio buffer real từ Gemini
	// Phát nó qua Web Audio API
	
	try {
		const audioContext = new (window.AudioContext || window.webkitAudioContext)();
		audioContext.decodeAudioData(audioBuffer, (decodedData) => {
			const source = audioContext.createBufferSource();
			source.buffer = decodedData;
			source.connect(audioContext.destination);
			source.start();
		}, (err) => {
			console.error('Lỗi decode audio:', err);
		});
	} catch (err) {
		console.error('Lỗi phát audio:', err);
	}
}

/* ==================================================================
   TÍCH HỢP GEMINI LIVE API (REST API Streaming)
================================================================== */
async function connectGeminiLiveSocket() {
	console.log('  → connectGeminiLiveSocket bắt đầu...');
	const delay = DEV_MODE ? 300 : 600;
	await wait(delay);
	console.log('  → connectGeminiLiveSocket hoàn tát');
	
	// 🔴 CHECK API KEY
	if (!window.GEMINI_API_KEY) {
		console.error('❌ API key không được set! Kiểm tra env-config.js');
		console.log('   window.GEMINI_API_KEY:', window.GEMINI_API_KEY);
		throw new Error('API key not found in window.GEMINI_API_KEY');
	}
	console.log('✓ API key đã load');
	
	// 🔴 TẢI DỮ LIỆU FAQ
	try {
		const faqResponse = await fetch('./data/faq.json');
		faqData = await faqResponse.json();
		console.log('✓ FAQ data đã load:', faqData.length, 'items');
	} catch (err) {
		console.warn('⚠️ Lỗi load FAQ:', err.message);
		faqData = [];
	}
	
	// 🔴 KIỂM TRA SIMULATE MODE
	if (SIMULATE_GEMINI_RESPONSE) {
		console.log('🎭 [SIMULATE MODE] Bỏ qua khởi tạo Gemini API');
		console.log('   Sẽ dùng response text cứng thay vì gọi API');
		window.geminiChat = { method: 'simulate' }; // Placeholder
		setAvatarState('idle');
		transcriptText.textContent = 'Kết nối thành công. Bạn có thể bắt đầu nói.';
		console.log('  → transcriptText.textContent mới:', transcriptText.textContent);
		return;
	}
	
	// 🔴 KHỞI TẠO GEMINI LIVE CLIENT (WebSocket)
	try {
		const wsSuccess = initGeminiLiveWebSocket();
		if (!wsSuccess) {
			throw new Error('Failed to init WebSocket');
		}

		// Chờ WebSocket mở, có timeout để không treo vô hạn nếu server
		// không phản hồi và cũng không bắn onerror.
		await new Promise((resolve, reject) => {
			const timeoutId = setTimeout(() => {
				reject(new Error('Timeout khi chờ WebSocket kết nối'));
			}, WS_RECONNECT_CONFIG.connectTimeoutMs);

			const checkReady = () => {
				if (ws && ws.readyState === WebSocket.OPEN) {
					clearTimeout(timeoutId);
					resolve();
				} else if (!ws) {
					// initGeminiLiveWebSocket đã tự đóng ws (lỗi/đóng sớm)
					clearTimeout(timeoutId);
					reject(new Error('WebSocket đóng trước khi kết nối xong'));
				} else {
					setTimeout(checkReady, 100);
				}
			};
			checkReady();
		});

		window.geminiChat = { method: 'websocket' };
		console.log('✓ Gemini Live WebSocket session khởi tạo thành công');
	} catch (err) {
		console.warn('⚠️ WebSocket init fail, dùng Fetch API fallback:', err.message);
		closeGeminiLiveWebSocket();
		window.geminiChat = { method: 'fetch', apiKey: GEMINI_LIVE_CONFIG.apiKey };
	}
	
	// Thiết lập trạng thái avatar mặc định là idle
	setAvatarState('idle');
	transcriptText.textContent = 'Kết nối thành công. Bạn có thể bắt đầu nói.';
	console.log('  → transcriptText.textContent mới:', transcriptText.textContent);
}

/* ==================================================================
   MÔ PHỎNG: PHÁT HIỆN GEMINI NÓI (test visual state + phát audio)
================================================================== */
function simulateGeminiSpeaking(duration = 5000) {
	// Hàm này dùng để test visual state: mô phỏng avatar speaking
	// ⚠️ THAY ĐỔI VISUAL STATE + PHÁT AUDIO
	console.log('🔴 [DEV] Mô phỏng Gemini bắt đầu nói (visual + audio)...');
	setAvatarState('speaking');
	
	// Phát audio test
	const testMessage = 'Xin chào, đây là test phím S.';
	speakText(testMessage);
	
	// Nếu FAQ được bật, giữ FAQ panel mở
	if (isFaqVisible) {
		console.log('📺 Hiển thị FAQ GIF trong khi Gemini nói');
		applyFaqState(true);
	}
	
	// Sau khoảng thời gian, quay về idle
	setTimeout(() => {
		if (isGeminiSpeaking) {
			console.log('🔴 [DEV] Mô phỏng Gemini nói xong...');
			setAvatarState('idle');
		}
	}, duration);
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

/* ==================================================================
   PHÁT HIỆN ÂM THANH TỪ MICRO (Volume Detection)
================================================================== */
let silenceTimeout = null;
let volumeDetectionAnimationId = null;
let analyserNode = null;
let maxListeningTimeout = null;
const SILENCE_THRESHOLD = 2000; // ms - chờ 2 giây im lặng mới gửi
const MAX_LISTENING_DURATION = 5000; // 5 giây - nếu nghe quá lâu sẽ tự động gửi

function setupMicVolumeDetection() {
	if (!localMicStream) return;
	
	const audioContext = new (window.AudioContext || window.webkitAudioContext)();
	const analyser = audioContext.createAnalyser();
	const microphone = audioContext.createMediaStreamSource(localMicStream);
	
	microphone.connect(analyser);
	analyser.fftSize = 256;
	analyserNode = analyser;
	
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

/* ==================================================================
   PHÍM TẮT DEV MODE (Test simulation)
================================================================== */
function setupDevModeShortcuts() {
	document.addEventListener('keydown', (e) => {
		// L: mô phỏng người dùng nói
		if (e.key === 'l' || e.key === 'L') {
			console.log('🔑 [DEV] Phím L: mô phỏng listening (avatar only, no audio)');
			detectUserSpeaking();
		}
		
		// K: mô phỏng dừng nói + gửi message test
		if (e.key === 'k' || e.key === 'K') {
			console.log('🔑 [DEV] Phím K: mô phỏng stop + gửi message test (WITH AUDIO)');
			stopUserSpeaking();
		}
		
		// S: test visual speaking state + phát audio
		if (e.key === 's' || e.key === 'S') {
			console.log('🔑 [DEV] Phím S: test speaking visual (avatar + AUDIO)');
			simulateGeminiSpeaking(5000);
		}
		
		// G: toggle FAQ
		if (e.key === 'g' || e.key === 'G') {
			console.log('🔑 [DEV] Phím G: toggle FAQ');
			isFaqVisible = !isFaqVisible;
			applyFaqState(isFaqVisible);
		}
		
		// M: gửi message test trực tiếp (WITH AUDIO)
		if (e.key === 'm' || e.key === 'M') {
			console.log('🔑 [DEV] Phím M: gửi message test (WITH AUDIO)');
			if (window.geminiChat) {
				sendMessageToGemini('Cho tôi biết đây là gì?');
			}
		}
	});
}

/* ==================================================================
   GẮN EVENT LISTENERS
================================================================== */
function attachEventListeners() {
	console.log('✓ Gắn event listeners...');

	// NÚT "BẮT ĐẦU TRÒ CHUYỆN"
	startBtn.addEventListener('click', handleStartClick);

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
		// Dừng gửi audio
		stopSendingAudio();

		// Đóng WebSocket chủ động (không để onclose tự động reconnect)
		closeGeminiLiveWebSocket();
		
		// Dừng Text-to-Speech nếu đang phát
		if (window.speechSynthesis) {
			window.speechSynthesis.cancel();
		}
		
		// Dừng micro
		if (localMicStream) {
			localMicStream.getTracks().forEach(track => track.stop());
		}
		localMicStream = null;
		avatarVideo.srcObject = null;
		remoteAudio.srcObject = null;
		avatarPlaceholder.style.display = 'flex';
		applyFaqState(false);
		setConnectionState('idle', 'Đã ngắt kết nối');
		
		// Reset trạng thái
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
	startListeningBtn = document.getElementById('startListeningBtn');
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