/* ====== CORE RUNTIME (WebSocket + Audio) ====== */
// Core runtime inlined here (moved from separate module)

// CORE: internal state
let ws = null;
let audioInputContext = null;
let audioOutputContext = null;
let mediaStream = null;
let scriptProcessor = null;
let isStreamingLocalAudio = false;
let alreadyRecordedOnce = false;
let nextStartTime = 0;
let activeAudioSources = [];

const CORE_MODEL_NAME = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const CORE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';
/* ====== CONFIG & GLOBALS ====== */

// ⚠️ CHẾ ĐỘ PHÁT TRIỂN: bật để bypass quyền micro và test giao diện
const DEV_MODE = false;

// Nếu DEV_MODE = true, dùng response text cứng thay vì gọi Gemini API
const SIMULATE_GEMINI_RESPONSE = false;

// Bật để in ra chi tiết flow xử lý (debug)
const DEBUG_FLOW = true;

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
	// GEMINI Live config placeholder - runtime handled by `script chuẩn.js`
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
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;
let wsIsClosingIntentionally = false; // true khi người dùng chủ động ngắt (endBtn)
let audioContext = null;

// Speech Recognition (Web Speech API)
let recognition = null; // Web Speech API recognition instance
let userTranscript = ''; // Lưu text từ user nói (interim + final)
let finalUserTranscript = ''; // Lưu final transcript để hiển thị

// FAQ Data
let faqData = [];
let isAvatarInCornerMode = false;
let startListeningBtn;
let fullscreenBtn;


function sendSetupMessage() {
	if (!ws) return;
	const setupPayload = {
		setup: {
			model: CORE_MODEL_NAME,
			generationConfig: {
				responseModalities: ['AUDIO']
			},
			systemInstruction: {
				parts: [{
					text: 'Bạn là Trợ lý Lễ tân AI thông minh, thân thiện. Hãy nói chuyện ngắn gọn, tự nhiên và với giọng nữ bằng tiếng Việt.'
				}]
			}
		}
	};
	try {
		ws && ws.send(JSON.stringify(setupPayload));
	} catch (e) {
		console.error('CORE sendSetup failed', e);
	}
}

async function initLiveSession() {
	if (!audioOutputContext) audioOutputContext = new(window.AudioContext || window.webkitAudioContext)({
		sampleRate: 24000
	});
	const apiKey = window.GEMINI_API_KEY || document.getElementById('hiddenInput')?.value;
	if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
	const wsUrl = `${CORE_WS_BASE}?key=${apiKey}`;
	ws = new WebSocket(wsUrl);
	ws.onopen = () => {
		sendSetupMessage();
	};
	ws.onmessage = async (event) => {
		try {
			let raw = event.data;
			if (raw instanceof Blob) raw = await raw.text();
			if (raw instanceof ArrayBuffer) raw = new TextDecoder('utf-8').decode(raw);
			const response = JSON.parse(raw);
			if (response.setupComplete) {
				await startMicrophoneStream();
				return;
			}
			await handleServerResponse(response);
		} catch (err) {
			console.error('CORE onmessage error', err);
		}
	};
	ws.onerror = (err) => console.error('CORE WS error', err);
	ws.onclose = () => {
		stopMicrophoneStream();
		isStreamingLocalAudio = false;
		setTimeout(() => initLiveSession(), 3000);
	};
}

async function startMicrophoneStream() {
	try {
		// Reuse UI-acquired `localMicStream` if available
		if (localMicStream) mediaStream = localMicStream;
		else mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				sampleRate: 16000,
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			}
		});
		audioInputContext = new(window.AudioContext || window.webkitAudioContext)({
			sampleRate: 16000
		});
		const source = audioInputContext.createMediaStreamSource(mediaStream);
		scriptProcessor = audioInputContext.createScriptProcessor(4096, 1, 1);
		scriptProcessor.onaudioprocess = (e) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			const inputData = e.inputBuffer.getChannelData(0);
			let maxAmp = 0;
			for (let i = 0; i < inputData.length; i++)
				if (Math.abs(inputData[i]) > maxAmp) maxAmp = Math.abs(inputData[i]);
			if (maxAmp > 0.01) {
				const pcm = convertFloat32ToInt16(inputData);
				const base64 = arrayBufferToBase64(pcm);
				const payload = {
					realtimeInput: {
						mediaChunks: [{
							mimeType: 'audio/pcm;rate=16000',
							data: base64
						}]
					}
				};
				ws.send(JSON.stringify(payload));
			}
		};
		source.connect(scriptProcessor);
		scriptProcessor.connect(audioInputContext.destination);
	} catch (err) {
		console.error('CORE startMicrophoneStream failed', err);
	}
}

function stopMicrophoneStream() {
	try {
		if (scriptProcessor) {
			scriptProcessor.disconnect();
			scriptProcessor = null;
		}
		if (mediaStream && mediaStream !== localMicStream) {
			mediaStream.getTracks().forEach(t => t.stop());
			mediaStream = null;
		}
		if (audioInputContext) {
			audioInputContext.close();
			audioInputContext = null;
		}
	} catch (e) {
		console.warn('CORE stopMicrophoneStream cleanup error', e);
	}
}

function stopMicrophoneAndSendTurn() {
	stopMicrophoneStream();
	if (ws && ws.readyState === WebSocket.OPEN) {
		try {
			ws.send(JSON.stringify({
				clientContent: {
					turns: [{
						role: 'user',
						parts: []
					}],
					turnComplete: true
				}
			}));
		} catch (e) {
			console.error('CORE send turnComplete failed', e);
		}
	}
}

async function sendLocalAudioFile(url) {
	if (isStreamingLocalAudio) return;
	stopMicrophoneStream();
	try {
		isStreamingLocalAudio = true;
		const resp = await fetch(url);
		if (!resp.ok) throw new Error('Local audio not found');
		const arrayBuffer = await resp.arrayBuffer();
		const decodeCtx = new(window.AudioContext || window.webkitAudioContext)();
		const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
		try {
			await decodeCtx.close();
		} catch (e) {}
		const targetRate = 16000;
		const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
		const source = offline.createBufferSource();
		source.buffer = decoded;
		source.connect(offline.destination);
		source.start(0);
		const rendered = await offline.startRendering();
		const float32 = rendered.getChannelData(0);
		const chunkSize = 3200;
		const chunkDurationMs = 200;
		for (let i = 0; i < float32.length; i += chunkSize) {
			if (!ws || ws.readyState !== WebSocket.OPEN) break;
			const slice = float32.subarray(i, Math.min(i + chunkSize, float32.length));
			const pcmUint8 = convertFloat32ToInt16(slice);
			const base64 = arrayBufferToBase64(pcmUint8);
			ws.send(JSON.stringify({
				realtimeInput: {
					mediaChunks: [{
						mimeType: 'audio/pcm;rate=16000',
						data: base64
					}]
				}
			}));
			await new Promise(r => setTimeout(r, chunkDurationMs));
		}
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
			clientContent: {
				turns: [{
					role: 'user',
					parts: []
				}],
				turnComplete: true
			}
		}));
	} catch (err) {
		console.error('CORE sendLocalAudioFile failed', err);
		throw err;
	} finally {
		isStreamingLocalAudio = false;
	}
}

async function handleServerResponse(response) {
	if (response.error) {
		console.error('CORE server error', response.error);
		return;
	}
	if (response.serverContent?.interrupted) {
		stopAllAudioOutputs();
		return;
	}
	const parts = response.serverContent?.modelTurn?.parts;
	if (parts) {
		for (const part of parts) {
			if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.startsWith('audio/pcm')) {
				await playAudioChunk(part.inlineData.data);
			} else if (part.text) {
				console.log('CORE server text:', part.text);
				// UI may display text elsewhere
			}
		}
	}
}

async function playAudioChunk(base64Audio) {
	if (!audioOutputContext) return;
	if (audioOutputContext.state === 'suspended') await audioOutputContext.resume();
	const arrayBuffer = base64ToArrayBuffer(base64Audio);
	const pcm16Data = new Int16Array(arrayBuffer);
	const audioBuffer = createAudioBufferFromPCM16(pcm16Data, audioOutputContext, 24000);
	const source = audioOutputContext.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(audioOutputContext.destination);
	const currentTime = audioOutputContext.currentTime;
	if (nextStartTime < currentTime) nextStartTime = currentTime;
	source.start(nextStartTime);
	nextStartTime += audioBuffer.duration;
	activeAudioSources.push(source);
	source.onended = () => {
		activeAudioSources = activeAudioSources.filter(s => s !== source);
	};
}

function stopAllAudioOutputs() {
	activeAudioSources.forEach(source => {
		try {
			source.stop();
		} catch (e) {}
	});
	activeAudioSources = [];
	if (audioOutputContext) nextStartTime = audioOutputContext.currentTime;
}

function convertFloat32ToInt16(float32Array) {
	const buffer = new ArrayBuffer(float32Array.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < float32Array.length; i++) {
		let sample = float32Array[i] * 1.5;
		sample = Math.max(-1, Math.min(1, sample));
		const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
		view.setInt16(i * 2, int16, true);
	}
	return new Uint8Array(buffer);
}

function arrayBufferToBase64(buffer) {
	let binary = '';
	const bytes = new Uint8Array(buffer);
	const len = bytes.byteLength;
	for (let i = 0; i < len; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return window.btoa(binary);
}

function createAudioBufferFromPCM16(int16Array, audioCtx, sampleRate) {
	const buffer = audioCtx.createBuffer(1, int16Array.length, sampleRate);
	const channelData = buffer.getChannelData(0);
	for (let i = 0; i < int16Array.length; i++) channelData[i] = int16Array[i] / 32768.0;
	return buffer;
}

function base64ToArrayBuffer(base64) {
	const binaryString = window.atob(base64);
	const len = binaryString.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
	return bytes.buffer;
}

async function recordAndSend(seconds = 5) {
	if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket chưa kết nối');
	const durationMs = seconds * 1000;
	const sampleRate = 16000;
	const targetSamples = Math.ceil(seconds * sampleRate);
	try {
		mediaStream = await navigator.mediaDevices.getUserMedia({
			audio: {
				channelCount: 1,
				sampleRate
			}
		});
		audioInputContext = new(window.AudioContext || window.webkitAudioContext)({
			sampleRate
		});
		const source = audioInputContext.createMediaStreamSource(mediaStream);
		const buffers = [];
		let recorded = 0;
		let finished = false;
		let localScriptProc = null;
		const finish = async () => {
			if (finished) return;
			finished = true;
			try {
				if (localScriptProc) localScriptProc.disconnect();
			} catch (e) {}
			try {
				source.disconnect();
			} catch (e) {}
			try {
				mediaStream.getTracks().forEach(t => t.stop());
			} catch (e) {}
			const full = new Float32Array(recorded);
			let offset = 0;
			for (const b of buffers) {
				full.set(b, offset);
				offset += b.length;
			}
			const finalSamples = full.subarray(0, Math.min(full.length, targetSamples));
			const chunkSize = 3200;
			const chunkDurationMs = 200;
			const total = finalSamples.length;
			for (let i = 0; i < total; i += chunkSize) {
				if (!ws || ws.readyState !== WebSocket.OPEN) break;
				const slice = finalSamples.subarray(i, Math.min(i + chunkSize, total));
				const pcmUint8 = convertFloat32ToInt16(slice);
				const base64 = arrayBufferToBase64(pcmUint8);
				ws.send(JSON.stringify({
					realtimeInput: {
						mediaChunks: [{
							mimeType: 'audio/pcm;rate=16000',
							data: base64
						}]
					}
				}));
				await new Promise(r => setTimeout(r, chunkDurationMs));
			}
			if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({
				clientContent: {
					turns: [{
						role: 'user',
						parts: []
					}],
					turnComplete: true
				}
			}));
			alreadyRecordedOnce = true;
			try {
				await audioInputContext.close();
			} catch (e) {}
			audioInputContext = null;
			localScriptProc = null;
			mediaStream = null;
		};
		try {
			await audioInputContext.audioWorklet.addModule('recorder-processor.js');
			localScriptProc = new AudioWorkletNode(audioInputContext, 'recorder-processor', {
				numberOfInputs: 1,
				numberOfOutputs: 1,
				outputChannelCount: [1]
			});
			localScriptProc.port.onmessage = (e) => {
				const input = e.data;
				const copy = new Float32Array(input.length);
				copy.set(input);
				buffers.push(copy);
				recorded += copy.length;
				if (recorded >= targetSamples) setTimeout(() => {
					finish();
				}, 0);
			};
			source.connect(localScriptProc);
			localScriptProc.connect(audioInputContext.destination);
		} catch (err) {
			localScriptProc = audioInputContext.createScriptProcessor(4096, 1, 1);
			localScriptProc.onaudioprocess = (e) => {
				const input = e.inputBuffer.getChannelData(0);
				const copy = new Float32Array(input.length);
				copy.set(input);
				buffers.push(copy);
				recorded += copy.length;
				if (recorded >= targetSamples) setTimeout(() => {
					finish();
				}, 0);
			};
			source.connect(localScriptProc);
			localScriptProc.connect(audioInputContext.destination);
		}
		await new Promise(r => setTimeout(r, durationMs + 100));
		if (recorded < targetSamples) await new Promise(r => setTimeout(r, 50));
		await finish();
	} catch (err) {
		try {
			if (scriptProcessor) {
				scriptProcessor.disconnect();
				scriptProcessor = null;
			}
		} catch (e) {}
		try {
			if (mediaStream) {
				mediaStream.getTracks().forEach(t => t.stop());
				mediaStream = null;
			}
		} catch (e) {}
		try {
			if (audioInputContext) {
				await audioInputContext.close();
				audioInputContext = null;
			}
		} catch (e) {}
		throw err;
	}
}

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
		// 🔴 NOTE: Volume detection sẽ được setup lại khi audio phát xong (playAudioChunk.onended)
		// Không setup lại ở đây để tránh duplicate setup
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
		if (DEBUG_FLOW) console.log('🎤 [FLOW] DETECTED USER SPEAKING - Changing avatar state to listening');

		// ⏹️ Stop audio ngay lập tức nếu Gemini đang phát
		stopCurrentAudio();

		setAvatarState('listening');

		// 🔴 BẮT ĐẦU GỬI AUDIO SANG GEMINI
		startSendingAudio();
	}
}

function stopUserSpeaking() {
	// Khi người dùng dừng nói
	// Nếu Gemini không nói, quay về idle
	if (DEBUG_FLOW) {
		console.log('🤐 [FLOW] stopUserSpeaking() called');
		console.log('   - isGeminiSpeaking:', isGeminiSpeaking);
		console.log('   - currentAvatarState:', currentAvatarState);
	}

	if (!isGeminiSpeaking && currentAvatarState === 'listening') {
		if (DEBUG_FLOW) console.log('🤐 USER STOPPED SPEAKING - Processing message...');

		// 🔴 DỪNG GỬI AUDIO + GỬI MESSAGE SANG GEMINI NGAY LẬP TỨC
		stopSendingAudio();

		// Dừng speech recognition
		if (recognition) {
			if (DEBUG_FLOW) console.log('🎙️ [FLOW] Calling recognition.stop()');
			recognition.stop();
		}

		// 🔴 LƯU final transcript để hiển thị
		finalUserTranscript = userTranscript.trim();

		// Gửi message từ user transcript (text mà user nói)
		// Hiển thị user transcript lên màn hình
		if (finalUserTranscript) {
			transcriptText.textContent = '🎤 Bạn: ' + finalUserTranscript;
			if (DEBUG_FLOW) console.log('💬 User transcript displayed:', finalUserTranscript);
		}

		// Delegate sending/stopping to core implementation (record/send turn)
		try {
			stopMicrophoneAndSendTurn();
			if (DEBUG_FLOW) console.log('📨 Delegated turnComplete to core');
		} catch (err) {
			console.error('❌ Lỗi khi gọi core stop/send:', err);
		}
		userTranscript = '';
	} else {
		if (DEBUG_FLOW) console.log('   ❌ Condition not met, skipping message send');
	}
}

/* ====== SEND TO GEMINI ====== */
function startSendingAudio() {
	if (!localMicStream || isUserSpeakingActive) {
		if (DEBUG_FLOW && isUserSpeakingActive) console.warn('⚠️ [FLOW] startSendingAudio skipped - already speaking!');
		return;
	}

	// Reset flags để tránh confusion với lần nói trước
	isGeminiSpeaking = false;

	// Mark that user is now speaking so recognition will start
	isUserSpeakingActive = true;

	if (DEBUG_FLOW) console.log('🎤 [FLOW] USER STARTED SPEAKING - Initializing speech recognition...');

	// Bắt đầu speech recognition để capture text từ user nói
	userTranscript = '';
	if (recognition) {
		// Stop previous recognition nếu còn chạy
		try {
			recognition.stop();
		} catch (e) {}

		// Delay nhỏ trước khi start lại
		setTimeout(() => {
			if (recognition && isUserSpeakingActive) {
				recognition.start();
				if (DEBUG_FLOW) console.log('🎙️ [FLOW] Speech recognition started');
			}
		}, 50);
	}
}

function stopSendingAudio() {
	if (!isUserSpeakingActive) return;

	isUserSpeakingActive = false;
	console.log('📤 Dừng gửi audio stream');


	// 🔴 GỬI TEXT SANG GEMINI CHAT API
	// Sau khi dừng, gửi user input và nhận response từ Gemini
}

/* ====== GEMINI LIVE WEBSOCKET CONNECTION ====== */
let geminiLiveSession = null;
let messageHistory = [];
// The low-level WebSocket / API communication and audio streaming is handled
// by the core module (script chuẩn.js). Provide light UI-facing wrappers
// that delegate to the core functions where appropriate.

function buildGeminiWebSocketUrl() {
	console.warn('buildGeminiWebSocketUrl: delegated to core implementation');
	return null;
}

// function sendSetupMessage() {
// 	console.warn('sendSetupMessage: delegated to core implementation');
// }

function handleGeminiSocketMessage() {
	// Core handles server messages and playback; UI doesn't parse WS frames.
	console.warn('handleGeminiSocketMessage: delegated to core implementation');
}

function closeGeminiLiveWebSocket() {
	console.log('closeGeminiLiveWebSocket: delegating to core stop function');
	try {
		stopMicrophoneAndSendTurn();
	} catch (err) {
		console.error('❌ Error delegating close to core:', err);
	}
}

function scheduleGeminiReconnect() {
	console.warn('scheduleGeminiReconnect: delegated to core (no-op in UI)');
}

function initGeminiLiveWebSocket() {
	console.warn('initGeminiLiveWebSocket: delegated to core implementation');
}

async function initGeminiLiveConnection() {
	// Initialize core live session which manages WebSocket + mic streaming
	try {
		await initLiveSession();
		return;
	} catch (err) {
		console.error('❌ initGeminiLiveConnection failed (core):', err);
		throw err;
	}
}

async function sendMessageViaFetchAPI() {
	console.warn('sendMessageViaFetchAPI: fetch-based text path is not available in core. UI will not call it.');
}

function sendMessageViaWebSocket(userMessage) {
	console.warn('sendMessageViaWebSocket: direct send is delegated to core');
}

async function sendMessageToGemini(userMessage) {
	// UI-level helper: show message and hand off to core where possible.
	if (SIMULATE_GEMINI_RESPONSE) {
		const simulatedResponses = [
			'Xin chào! Tôi là trợ lý AI của bạn. Có thể tôi giúp gì cho bạn?',
			'Đây là một bản test luồng. Avatar đang ở trạng thái speaking.',
			'Hệ thống hoạt động bình thường. Luồng: listening → speaking → idle.',
			'Thử nói gì đó với tôi xem sao!',
			'Luồng đã được cập nhật. Avatar sẽ tự chuyển trạng thái.'
		];
		const responseText = simulatedResponses[Math.floor(Math.random() * simulatedResponses.length)];
		transcriptText.textContent = responseText;
		speakText(responseText);
		setTimeout(() => {
			if (!isAvatarInCornerMode) setAvatarState('idle');
		}, 5000);
		return;
	}

	// In the new structure, text-based sends are not handled here; prefer audio streaming.
	console.log('sendMessageToGemini: UI received message, delegating to core audio path if available');
	transcriptText.textContent = userMessage;
}

/* ====== CONVERT PCM TO WAV ====== */
// PCM->WAV conversion handled by core; UI does not convert audio data.
function pcmToWav() {
	console.warn('pcmToWav: conversion delegated to core; this UI stub should not be used');
	return null;
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

/* ====== TEXT-TO-SPEECH: BROWSER ====== */
function speakText(text) {
	if (!('speechSynthesis' in window)) {
		console.error('❌ Browser không hỗ trợ Text-to-Speech');
		return;
	}

	window.speechSynthesis.cancel();

	const utterance = new SpeechSynthesisUtterance(text);
	utterance.lang = 'vi-VN';
	utterance.rate = 1.0;
	utterance.pitch = 1.0;
	utterance.volume = 1.0;

	utterance.onstart = () => {
		if (DEBUG_FLOW) console.log('🔊 [FLOW] Browser TTS started');
	};

	utterance.onend = () => {
		if (DEBUG_FLOW) console.log('✅ [FLOW] Browser TTS finished');
		isGeminiSpeaking = false;
		setAvatarState('idle');
		if (!isAvatarInCornerMode) {
			setupMicVolumeDetection();
		}
	};

	utterance.onerror = (event) => {
		console.error('❌ Lỗi Browser TTS:', event.error);
		isGeminiSpeaking = false;
	};

	window.speechSynthesis.speak(utterance);
}




/* ====== SPEECH RECOGNITION SETUP ====== */
function initSpeechRecognition() {
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

	if (!SpeechRecognition) {
		console.warn('⚠️ Browser không hỗ trợ Web Speech API');
		return;
	}

	recognition = new SpeechRecognition();
	recognition.lang = 'vi-VN'; // Tiếng Việt
	recognition.continuous = true;
	recognition.interimResults = true;

	recognition.onstart = () => {
		console.log('🎤 Speech recognition started');
	};

	recognition.onresult = (event) => {
		let interim = '';
		for (let i = event.resultIndex; i < event.results.length; i++) {
			const transcript = event.results[i][0].transcript;

			if (event.results[i].isFinal) {
				userTranscript += transcript + ' ';
				if (DEBUG_FLOW) console.log('✅ FINAL TRANSCRIPT CAPTURED:', transcript);
			} else {
				interim += transcript;
				console.log('~ Interim:', interim);
			}
		}

		// Hiển thị interim result lên giao diện
		if (interim) {
			transcriptText.textContent = interim;
		} else if (userTranscript) {
			transcriptText.textContent = userTranscript;
		}
	};

	recognition.onerror = (event) => {
		console.error('❌ Speech recognition error:', event.error);
	};

	recognition.onend = () => {
		if (DEBUG_FLOW) console.log('🎤 [FLOW] Speech recognition ENDED event');

		// 🔴 AUTO-TRIGGER stopUserSpeaking when speech recognition ends
		// (người dùng đã dừng nói, không còn audio input)
		if (DEBUG_FLOW) console.log('🎤 [FLOW] Auto-triggering stopUserSpeaking() because speech recognition ended');
		stopUserSpeaking();
	};

	console.log('✓ Speech recognition initialized (Tiếng Việt)');
}

// Stop audio playback khi user bắt đầu nói (interrupt Gemini)
let currentAudioElement = null;

function stopCurrentAudio() {
	if (currentAudioElement && !currentAudioElement.paused) {
		if (DEBUG_FLOW) console.log('⏹️ [INTERRUPT] Dừng audio phát hiện người dùng nói');
		currentAudioElement.pause();
		currentAudioElement = null;
	}
}

/* ====== CONNECT GEMINI ====== */
async function connectGeminiLiveSocket() {
	console.log('  → connectGeminiLiveSocket bắt đầu...');
	const delay = DEV_MODE ? 100 : 0; // Giảm delay từ 600ms xuống 0
	if (delay > 0) await wait(delay);

	// Tải dữ liệu FAQ
	// 🔴 DISABLE: Bỏ qua FAQ để test
	/*
	try {
		const faqResponse = await fetch('./data/faq.json');
		faqData = await faqResponse.json();
		console.log('✓ FAQ data đã load:', faqData.length, 'items');
	} catch (err) {
		console.warn('⚠️ Lỗi load FAQ:', err.message);
		faqData = [];
	}
	*/
	faqData = [];
	console.log('✓ FAQ data DISABLED (test mode)');

	// Setup window.geminiChat cho message routing
	if (!window.GEMINI_API_KEY) {
		throw new Error('API key not found in window.GEMINI_API_KEY');
	}
	console.log('✓ API key đã load');
	// 🔴 Initialize core live session (WebSocket + mic streaming)
	try {
		await initLiveSession();
		window.geminiChat = {
			method: 'websocket',
			apiKey: GEMINI_LIVE_CONFIG.apiKey
		};
		console.log('✓ Core live session initialized');
	} catch (err) {
		console.warn('⚠️ Core initLiveSession failed:', err);
		// Fallback: still expose API key for other flows
		window.geminiChat = {
			method: 'fetch',
			apiKey: GEMINI_LIVE_CONFIG.apiKey
		};
	}

	console.log('✓ Sẵn sàng. Bạn có thể bắt đầu nói.');
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

		// 🔴 Khởi tạo Speech Recognition trước khi kết nối Gemini
		if (!recognition) {
			console.log('3️⃣.5️⃣ Khởi tạo Speech Recognition...');
			initSpeechRecognition();
		}

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
const SILENCE_THRESHOLD = 1000; // ms - chờ 1 giây im lặng mới gửi (từ 800ms)
let isVolumeDetectionActive = false; // Track nếu detection đang chạy

function setupMicVolumeDetection() {
	if (!localMicStream) return;
	if (isVolumeDetectionActive) {
		if (DEBUG_FLOW) console.log('⚠️ Volume detection already active, skipping');
		return;
	}

	const audioContext = new(window.AudioContext || window.webkitAudioContext)();
	const analyser = audioContext.createAnalyser();
	const microphone = audioContext.createMediaStreamSource(localMicStream);

	microphone.connect(analyser);
	analyser.fftSize = 256;


	const dataArray = new Uint8Array(analyser.frequencyBinCount);
	const VOLUME_THRESHOLD = 80;
	let lastSpokeTime = Date.now();

	isVolumeDetectionActive = true; // 🔴 Mark as active

	function checkVolume() {
		analyser.getByteFrequencyData(dataArray);
		const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

		// 🔴 DEBUG: In ra volume hiện tại mỗi 1 giây
		// if (Math.random() < 0.05) { // ~5% chance để không spam log
		// 	console.log(`📊 Volume: ${average.toFixed(1)} (threshold: ${VOLUME_THRESHOLD})`);
		// }

		if (average > VOLUME_THRESHOLD) {
			// Có âm thanh - người dùng đang nói
			lastSpokeTime = Date.now();
			clearTimeout(silenceTimeout);
			if (currentAvatarState !== 'listening') {
				if (DEBUG_FLOW) console.log(`🎤 [FLOW] AUDIO DETECTED (volume: ${average.toFixed(1)}), calling detectUserSpeaking`);
				detectUserSpeaking();
			}
		} else {
			// Không có âm thanh - chờ xem có tiếp tục nói không
			clearTimeout(silenceTimeout);
			silenceTimeout = setTimeout(() => {
				if (DEBUG_FLOW) console.log('⏱️ [FLOW] SILENCE TIMEOUT - Stopping user speaking');
				stopUserSpeaking();
			}, SILENCE_THRESHOLD);
		}

		// 🔴 Chỉ tiếp tục nếu detection vẫn active
		if (isVolumeDetectionActive) {
			volumeDetectionAnimationId = requestAnimationFrame(checkVolume);
		}
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
	isVolumeDetectionActive = false; // 🔴 Mark as inactive
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
			// if (window.geminiChat) {
			sendMessageToGemini('Cho tôi biết đây là gì?');
			// }
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

		// Dừng volume detection
		stopVolumeDetection();

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
		finalUserTranscript = ''; // 🔴 Reset transcript

		// 🔴 Đóng WebSocket connection chủ động
		closeGeminiLiveWebSocket();
		messageHistory = [];
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
		welcomeScreen,
		appScreen,
		startBtn,
		transcriptText,
		stage,
		toggleFaqBtn,
		micBtn,
		micLabel,
		endBtn,
		connectionDot,
		connectionLabel,
		avatarVideo,
		avatarPlaceholder,
		speakingIndicator,
		faqPanel,
		permissionError,
		fullscreenBtn
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

function core_closeWebSocket() {
	try {
		if (core_ws) {
			core_ws.onopen = null;
			core_ws.onmessage = null;
			core_ws.onerror = null;
			core_ws.onclose = null;
			if (core_ws.readyState === WebSocket.OPEN || core_ws.readyState === WebSocket.CONNECTING) core_ws.close();
			core_ws = null;
		}
	} catch (e) {
		console.warn('core_closeWebSocket error', e);
	}
}