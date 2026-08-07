let ws = null;
let audioInputContext = null;
let audioOutputContext = null;
let mediaStream = null;
let scriptProcessor = null;
let isStreamingLocalAudio = false;
let alreadyRecordedOnce = false;
let nextStartTime = 0;
let activeAudioSources = [];
let pendingAudioQueue = []; // Hàng chờ chứa các audio chunk mới
let audioQueue = [];
let isPlayingQueue = false;
let currentSourceNode = null;

const CORE_MODEL_NAME = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const CORE_WS_BASE = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

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
	if (!audioOutputContext) {
		audioOutputContext = new (window.AudioContext || window.webkitAudioContext)({
			sampleRate: 24000
		});
		console.log('initLiveSession: created audioOutputContext, state=', audioOutputContext.state);
		// Attempt resume (may require user gesture); helps autoplay policies
		if (audioOutputContext.state === 'suspended') {
			try {
				audioOutputContext.resume().then(() => console.log('initLiveSession: audioOutputContext.resume() succeeded'))
				.catch(e => console.warn('initLiveSession: resume promise rejected', e));
			} catch (e) {
				console.warn('initLiveSession: resume failed', e);
			}
		}
	}
	const apiKey = window.GEMINI_API_KEY;
	if (!apiKey) throw new Error('Missing GEMINI_API_KEY');
	const wsUrl = `${CORE_WS_BASE}?key=${apiKey}`;
	ws = new WebSocket(wsUrl);
	ws.onopen = () => {
		// console.log('CORE WS onopen, readyState=', ws.readyState);
		sendSetupMessage();
	};
	ws.onmessage = async (event) => {
		try {
			let raw = event.data;
			// console.log('CORE WS onmessage: raw type=', typeof raw, 'instanceof Blob=', raw instanceof Blob, 'instanceof ArrayBuffer=', raw instanceof ArrayBuffer);
			if (raw instanceof Blob) raw = await raw.text();
			if (raw instanceof ArrayBuffer) raw = new TextDecoder('utf-8').decode(raw);
			// console.log('CORE WS onmessage: payload=', raw.slice ? raw.slice(0,200) : raw);
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
		if (localMicStream) mediaStream = localMicStream;
		else mediaStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
		
		audioInputContext = new(window.AudioContext || window.webkitAudioContext)({
			sampleRate: 16000
		});
		const source = audioInputContext.createMediaStreamSource(mediaStream);
		const highpass = audioInputContext.createBiquadFilter();
		highpass.type = 'highpass';
		highpass.frequency.value = 80;

		scriptProcessor = audioInputContext.createScriptProcessor(2048, 1, 1);

		scriptProcessor.onaudioprocess = (e) => {
			if (!ws || ws.readyState !== WebSocket.OPEN) return;
			// CHỈ GỬI AUDIO KHI NGƯỜI DÙNG ĐANG TRONG LƯỢT NÓI
			if (!isUserSpeakingActive) return;

			const inputData = e.inputBuffer.getChannelData(0);
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
			try {
				ws.send(JSON.stringify(payload));
			} catch (e) {
				console.warn('CORE ws.send failed', e);
			}
		};

		source.connect(highpass);
		highpass.connect(scriptProcessor);
		const silentGain = audioInputContext.createGain();
		silentGain.gain.value = 0;
		scriptProcessor.connect(silentGain);
		silentGain.connect(audioInputContext.destination);
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
                        parts: [
                            { text: finalUserTranscript || "Tôi vừa nói xong, hãy phản hồi lại tôi." }
                        ]
                    }],
                    turnComplete: true
                }
            }));
            console.log('✅ Đã gửi turnComplete kèm transcript:', finalUserTranscript);
        } catch (e) {
            console.error('CORE send turnComplete failed', e);
        }
    }
}

async function handleServerResponse(response) {
    if (response.error) {
        console.error('CORE server error', response.error);
        return;
    }

    // Nếu không muốn AI bị ngắt khi server báo interrupted, comment hoặc bỏ lệnh stopCurrentAudio ở đây
    if (response.serverContent?.interrupted) {
        console.log('Server báo interrupted nhưng client vẫn giữ luồng phát');
        return;
    }

    const parts = response.serverContent?.modelTurn?.parts;
    if (parts) {
        for (const part of parts) {
            if (part.inlineData && part.inlineData.mimeType && part.inlineData.mimeType.includes('audio')) {
                // Đẩy vào queue phát âm thanh
				enqueueAudioChunk(part.inlineData.data, part.inlineData.mimeType);
            }
        }
    }
	// Update turnComplete flag
	if (response.serverContent?.turnComplete) {
		turnCompleteReceived = true;
		console.log('Gemini đã gửi xong toàn bộ dữ liệu lượt nói mới (turnComplete)');
	} else {
		// more may come
		turnCompleteReceived = false;
	}
}

async function flushPendingResponses() {
	while (pendingResponses.length > 0) {
		const resp = pendingResponses.shift();
		try {
			await handleServerResponse(resp);
		} catch (e) {
			console.error('Error flushing pending response', e);
		}
	}
}

async function enqueueAudioChunk(base64Audio, mimeType) {
    // Đẩy chunk vào danh sách chờ
	pendingAudioQueue.push({ base64Audio, mimeType });
	// Schedule immediately (will convert and schedule up to lookahead)
	scheduleAudioFromPending();
}

async function scheduleAudioFromPending() {
	if (pendingAudioQueue.length === 0) return;
	if (!audioOutputContext) audioOutputContext = new (window.AudioContext || window.webkitAudioContext)();
	if (audioOutputContext.state === 'suspended') {
		audioOutputContext.resume().catch(e => console.warn('resume failed', e));
	}

	const now = audioOutputContext.currentTime;
	const LOOKAHEAD = 0.6; // seconds to pre-schedule
	const MIN_BUFFER_MS = 180; // combine into ~180ms buffers to reduce overhead

	while (pendingAudioQueue.length > 0) {
		if (nextStartTime - now >= LOOKAHEAD) break;

		// accumulate multiple small chunks into one combined buffer
		let collected = [];
		let collectedSamples = 0;
		let rate = null;

		while (pendingAudioQueue.length > 0 && (collectedSamples / (rate || 24000) * 1000) < MIN_BUFFER_MS) {
			const item = pendingAudioQueue.shift();
			try {
				const arr = base64ToArrayBuffer(item.base64Audio);
				const pcm16 = new Int16Array(arr);
				if (!rate) {
					const m = /rate=(\d+)/.exec(item.mimeType || '');
					rate = m ? parseInt(m[1], 10) : 24000;
				}
				collected.push(pcm16);
				collectedSamples += pcm16.length;
			} catch (e) {
				console.warn('scheduleAudioFromPending: failed to decode pending chunk', e);
			}
			// safety: prevent infinite loop
			if (collected.length > 50) break;
		}

		if (collected.length === 0) break;

		// concat Int16 arrays
		let combined = new Int16Array(collectedSamples);
		let offset = 0;
		for (const a of collected) {
			combined.set(a, offset);
			offset += a.length;
		}

		try {
			// If sample rate differs from audioOutputContext.sampleRate, resample via OfflineAudioContext
			let finalBuffer = null;
			if (rate && Math.abs(rate - audioOutputContext.sampleRate) > 1) {
				// Convert Int16 -> Float32
				const float32 = new Float32Array(combined.length);
				for (let i = 0; i < combined.length; i++) float32[i] = combined[i] / 32768.0;

				const offline = new OfflineAudioContext(1, Math.ceil(float32.length * audioOutputContext.sampleRate / rate), audioOutputContext.sampleRate);
				const buf = offline.createBuffer(1, float32.length, rate);
				buf.copyToChannel(float32, 0, 0);
				const src = offline.createBufferSource();
				src.buffer = buf;
				src.connect(offline.destination);
				src.start(0);
				finalBuffer = await offline.startRendering();
			} else {
				// create buffer directly at target rate
				finalBuffer = createAudioBufferFromPCM16(combined, audioOutputContext, rate || audioOutputContext.sampleRate);
			}

			const source = audioOutputContext.createBufferSource();
			source.buffer = finalBuffer;
			source.connect(audioOutputContext.destination);

			if (nextStartTime < now) nextStartTime = now + 0.02;
			console.log('scheduleAudioFromPending: scheduling combined start=', nextStartTime.toFixed(3), 'dur=', finalBuffer.duration.toFixed(3), 'rate=', rate);
			source.start(nextStartTime);
			nextStartTime += finalBuffer.duration;

			activeAudioSources.push(source);
			isGeminiSpeaking = true;
			setAvatarState('speaking');

			source.onended = async () => {
				activeAudioSources = activeAudioSources.filter(s => s !== source);
				if (activeAudioSources.length === 0 && pendingAudioQueue.length === 0) {
					if (turnCompleteReceived) {
						isGeminiSpeaking = false;
						setAvatarState('idle');
						await flushPendingResponses();
					} else {
						setTimeout(() => scheduleAudioFromPending(), 50);
					}
				} else {
					scheduleAudioFromPending();
				}
			};
		} catch (e) {
			console.warn('scheduleAudioFromPending: failed to schedule combined chunk', e);
		}
	}
}

async function processNextAudioChunk() {
    if (pendingAudioQueue.length === 0) {
        // Hết hàng chờ -> AI dừng nói hoàn toàn
        isGeminiSpeaking = false;
        setAvatarState('idle');
        return;
    }

    const { base64Audio, mimeType } = pendingAudioQueue.shift();

    if (!isGeminiSpeaking) {
        isGeminiSpeaking = true;
        setAvatarState('speaking');
    }

    await playAudioChunk(base64Audio, mimeType);
}

// 1. Nhận chunk từ WS và đẩy vào hàng chờ (giữ thông tin sampleRate)
function playAudioChunk(base64Audio, mimeType) {
	// Simpler flow: push into pending queue and let scheduler pre-schedule
	pendingAudioQueue.push({ base64Audio, mimeType });
	scheduleAudioFromPending();
}

// 2. Hàm xử lý phát nối tiếp mượt mà
async function playNextInQueue() {
	// Nếu hết hàng chờ, chờ thêm 300ms để xem server có gửi thêm (tránh ngắt khi server tạm dừng)
	if (audioQueue.length === 0 && pendingAudioQueue.length === 0) {
		if (turnCompleteReceived) {
			isPlayingQueue = false;
			isGeminiSpeaking = false;
			setAvatarState('idle');
			return;
		}
		// wait briefly for more chunks
		if (waitingForMoreTimer) clearTimeout(waitingForMoreTimer);
		waitingForMoreTimer = setTimeout(() => {
			waitingForMoreTimer = null;
			// if still empty and turnComplete not received, mark idle conservatively
			if (audioQueue.length === 0 && pendingAudioQueue.length === 0) {
				isPlayingQueue = false;
				isGeminiSpeaking = false;
				setAvatarState('idle');
			}
		}, 300);
		return;
	}

	if (!audioOutputContext) {
		audioOutputContext = new (window.AudioContext || window.webkitAudioContext)();
	}

	if (audioOutputContext.state === 'suspended') {
		await audioOutputContext.resume();
	}

	// Ensure we have an item in audioQueue; if not, try move one from pendingAudioQueue
	if (audioQueue.length === 0 && pendingAudioQueue.length > 0) {
		// move one pending into audioQueue
		const next = pendingAudioQueue.shift();
		try {
			const arr = base64ToArrayBuffer(next.base64Audio);
			const pcm16 = new Int16Array(arr);
			let rate = 24000;
			try {
				const m = /rate=(\d+)/.exec(next.mimeType || '');
				if (m) rate = parseInt(m[1], 10);
			} catch (e) {}
			audioQueue.push({ pcm16Data: pcm16, sampleRate: rate });
		} catch (e) {
			console.warn('playNextInQueue: failed to convert pending chunk', e);
		}
	}

	// Lấy chunk đầu tiên ra khỏi hàng chờ
	const item = audioQueue.shift();
	if (!item) {
		// Nothing to play
		isPlayingQueue = false;
		isGeminiSpeaking = false;
		setAvatarState('idle');
		return;
	}
	const { pcm16Data, sampleRate } = item;
	console.log('playNextInQueue: chunk sampleRate=', sampleRate, 'queueLength=', audioQueue.length, 'pendingQueue=', pendingAudioQueue.length, 'nextStartTime=', nextStartTime.toFixed(3));
	const audioBuffer = createAudioBufferFromPCM16(pcm16Data, audioOutputContext, sampleRate);
	console.log('playNextInQueue: audioBuffer.duration=', audioBuffer.duration.toFixed(3));

	const source = audioOutputContext.createBufferSource();
	source.buffer = audioBuffer;
	source.connect(audioOutputContext.destination);

	currentSourceNode = source;

	// Schedule playback to avoid overlap/gaps
	const now = audioOutputContext.currentTime;
	if (nextStartTime < now) nextStartTime = now + 0.02; // small safety offset
	source.start(nextStartTime);

	// Update nextStartTime to append this buffer
	nextStartTime += audioBuffer.duration;

	// Khi chunk này phát xong TỰ ĐỘNG gọi chunk tiếp theo
	source.onended = () => {
		playNextInQueue();
	};
}

function stopAllAudioOutputs() {
    // Xóa sạch hàng chờ audio
    audioQueue = [];
    isPlayingQueue = false;

    // Dừng source node hiện tại
    if (currentSourceNode) {
        try {
            currentSourceNode.stop();
        } catch (e) {}
        currentSourceNode = null;
    }

    activeAudioSources = [];
    isGeminiSpeaking = false;
}

function convertFloat32ToInt16(float32Array) {
	const buffer = new ArrayBuffer(float32Array.length * 2);
	const view = new DataView(buffer);
	for (let i = 0; i < float32Array.length; i++) {
		let sample = float32Array[i];
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

function createAudioBufferFromPCM16(int16Array, audioCtx, sampleRate = 24000) {
    const buffer = audioCtx.createBuffer(1, int16Array.length, sampleRate);
    const channelData = buffer.getChannelData(0);
    const len = int16Array.length;

    for (let i = 0; i < len; i++) {
        // Chuẩn hóa dải âm thanh [-1.0, 1.0]
        channelData[i] = int16Array[i] / 32768.0;
    }

	// Tùy chọn: Khử click/tạch nhẹ ở 2 mép biên chunk bằng fade ngắn (8-12ms)
	const fadeMs = 0.01; // 10ms fade
	const fadeSamples = Math.min(Math.floor(sampleRate * fadeMs), Math.floor(len / 2));
	if (fadeSamples > 0) {
		for (let i = 0; i < fadeSamples; i++) {
			const gain = i / fadeSamples;
			channelData[i] *= gain;
			channelData[len - 1 - i] *= gain;
		}
	}

    return buffer;
}

function base64ToArrayBuffer(base64) {
	const binaryString = window.atob(base64);
	const len = binaryString.length;
	const bytes = new Uint8Array(len);
	for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
	return bytes.buffer;
}

function pcm16Base64ToWavBlob(base64, sampleRate = 24000) {
	const pcmBuffer = base64ToArrayBuffer(base64);
	const pcm16 = new Int16Array(pcmBuffer);
	const bytesPerSample = 2;
	const blockAlign = bytesPerSample * 1;
	const byteRate = sampleRate * blockAlign;
	const dataSize = pcm16.length * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);
	// RIFF identifier
	writeString(view, 0, 'RIFF');
	view.setUint32(4, 36 + dataSize, true);
	writeString(view, 8, 'WAVE');
	// fmt chunk
	writeString(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // chunk size
	view.setUint16(20, 1, true); // PCM format
	view.setUint16(22, 1, true); // channels
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, 16, true); // bits per sample
	// data chunk
	writeString(view, 36, 'data');
	view.setUint32(40, dataSize, true);
	// PCM samples
	let offset = 44;
	for (let i = 0; i < pcm16.length; i++, offset += 2) {
		view.setInt16(offset, pcm16[i], true);
	}
	return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
	for (let i = 0; i < string.length; i++) {
		view.setUint8(offset + i, string.charCodeAt(i));
	}
}

async function playAudioViaAudioElement(base64Audio, sampleRate = 24000) {
	try {
		const wavBlob = pcm16Base64ToWavBlob(base64Audio, sampleRate);
		const url = URL.createObjectURL(wavBlob);
		const audio = new Audio(url);
		currentAudioElement = audio;
		audio.autoplay = true;
		audio.play().catch(err => console.error('Audio element play failed', err));
		audio.onended = () => {
			URL.revokeObjectURL(url);
			if (currentAudioElement === audio) currentAudioElement = null;
		};
		console.log('playAudioViaAudioElement: playing fallback audio element');
	} catch (e) {
		console.error('playAudioViaAudioElement error', e);
	}
}

/* ====== TIỆN ÍCH ====== */
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function setConnectionState(state, label) {
	connectionDot.className = 'status-dot';
	if (state === 'connecting') connectionDot.classList.add('is-connecting');
	if (state === 'connected') connectionDot.classList.add('is-connected');
	if (state === 'error') connectionDot.classList.add('is-error');
	connectionLabel.textContent = label;
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

function resetAudioOutputState() {
	resetAudioOutputState();
    activeAudioSources.forEach(source => {
        try { source.stop(); } catch (e) {}
    });
    activeAudioSources = [];
    if (typeof pendingAudioQueue !== 'undefined') {
        pendingAudioQueue = [];
    }
    if (audioOutputContext) {
        // Reset mốc thời gian nối chuỗi về hiện tại
        nextStartTime = audioOutputContext.currentTime;
    }
}

/* ====== USER SPEAKING DETECTION ====== */
function detectUserSpeaking() {
    // Vẫn ghi nhận thông tin & gửi lên WS, KHÔNG gọi stopCurrentAudio()
    if (!isUserSpeakingActive) {
        if (isGeminiSpeaking) {
            userInterruptedWhileSpeaking = true;
        }
        // Bắt đầu gửi âm thanh người dùng lên WS
        startSendingAudio();
    }
}

function stopUserSpeaking() {
	// Khi người dùng dừng nói
	// Nếu Gemini không nói, hoặc người dùng đã nói chồng lên AI, tiến hành gửi
	if ((currentAvatarState === 'listening') || userInterruptedWhileSpeaking) {
		// 🔴 DỪNG GỬI AUDIO + GỬI MESSAGE SANG GEMINI NGAY LẬP TỨC
		stopSendingAudio();

		// Dừng speech recognition
		if (recognition) {
			recognition.stop();
		}

		// 🔴 LƯU final transcript để hiển thị
		finalUserTranscript = userTranscript.trim();

		// Hiển thị user transcript lên màn hình
		if (finalUserTranscript) {
			transcriptText.textContent = '🎤 Bạn: ' + finalUserTranscript;
		}

		// Delegate sending/stopping to core implementation (record/send turn)
		try {
			stopMicrophoneAndSendTurn();
		} catch (err) {
			console.error('❌ Lỗi khi gọi core stop/send:', err);
		}
		userTranscript = '';
		userInterruptedWhileSpeaking = false;
	}
}

/* ====== SEND TO GEMINI ====== */
function startSendingAudio() {
	if (!localMicStream || isUserSpeakingActive) return;

	// Reset flags để tránh confusion với lần nói trước
	isGeminiSpeaking = false;

	// Mark that user is now speaking so recognition will start
	isUserSpeakingActive = true;

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
let messageHistory = [];
let pendingResponses = [];
let userInterruptedWhileSpeaking = false;
let turnCompleteReceived = false;
let waitingForMoreTimer = null;
// The low-level WebSocket / API communication and audio streaming is handled
// by the core module (script chuẩn.js). Provide light UI-facing wrappers
// that delegate to the core functions where appropriate.

function closeGeminiLiveWebSocket() {
	console.log('closeGeminiLiveWebSocket: delegating to core stop function');
	try {
		stopMicrophoneAndSendTurn();
	} catch (err) {
		console.error('❌ Error delegating close to core:', err);
	}
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
				
			} else {
				interim += transcript;
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
		if (isUserSpeakingActive && recognition) {
			try { recognition.start(); } catch(e) {}
		}
	};

	console.log('✓ Speech recognition initialized (Tiếng Việt)');
}

// Stop audio playback khi user bắt đầu nói (interrupt Gemini)
let currentAudioElement = null;

function stopCurrentAudio() {
	// Stop any active Audio element
	if (currentAudioElement && !currentAudioElement.paused) {
		try { currentAudioElement.pause(); } catch (e) {}
		currentAudioElement = null;
	}
	// Stop any AudioContext buffer sources
	stopAllAudioOutputs();
}

/* ====== CONNECT GEMINI ====== */
async function connectGeminiLiveSocket() {
	console.log('  → connectGeminiLiveSocket bắt đầu...');
	const delay = 0;
	if (delay > 0) await wait(delay);
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
	window.apiKey = document.getElementById('hiddenInput')?.value;
	window.GEMINI_API_KEY = window.apiKey;
	startBtn.disabled = true;
	startBtn.textContent = 'Đang xin quyền micro...';
	permissionError.style.display = 'none';

	try {
		console.log('1️⃣ Bắt đầu quá trình bật ứng dụng...');

		// 1. Yêu cầu quyền Micro
		console.log('2️⃣ Yêu cầu quyền micro...');
		localMicStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
		console.log('✓ Đã cấp quyền micro thành công');

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
			if (localMicStream) {
				console.log('5️⃣ Thiết lập phát hiện âm thanh micro...');
					// Resume audio output context (user gesture present) to ensure playback
					if (audioOutputContext && audioOutputContext.state === 'suspended') {
						try {
							await audioOutputContext.resume();
							console.log('✓ Resumed audioOutputContext after user gesture');
						} catch (e) {
							console.warn('Could not resume audioOutputContext', e);
						}
					}
					setupMicVolumeDetection();
			} else {
				console.log('5️⃣ Không có micro: không thiết lập volume detection');
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
const SILENCE_THRESHOLD = 600; // ms - chờ 0.6 giây im lặng mới gửi
const VOLUME_THRESHOLD = 0.02; // tuned: ignore light background noise
let isVolumeDetectionActive = false; // Track nếu detection đang chạy

function setupMicVolumeDetection() {
	if (!localMicStream) return;
	if (isVolumeDetectionActive) {
		return;
	}

	const audioContext = new(window.AudioContext || window.webkitAudioContext)();
	const analyser = audioContext.createAnalyser();
	const microphone = audioContext.createMediaStreamSource(localMicStream);

	microphone.connect(analyser);
	// Use time-domain data for RMS detection
	analyser.fftSize = 2048;

	const timeData = new Uint8Array(analyser.fftSize);
	const RMS_THRESHOLD = 0.02; // tuned: ignore light background noise
	let lastSpokeTime = Date.now();

	isVolumeDetectionActive = true; // 🔴 Mark as active

	function checkVolume() {
		analyser.getByteTimeDomainData(timeData);
		// convert to normalized -1..1 and compute RMS
		let sum = 0;
		for (let i = 0; i < timeData.length; i++) {
			const v = (timeData[i] - 128) / 128;
			sum += v * v;
		}
		const rms = Math.sqrt(sum / timeData.length);

		if (rms > RMS_THRESHOLD) {
			lastSpokeTime = Date.now();
			clearTimeout(silenceTimeout);
			if (currentAvatarState !== 'listening') {
				detectUserSpeaking();
			}
		} else {
			clearTimeout(silenceTimeout);
			silenceTimeout = setTimeout(() => {
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
