/* ====== CẤU HÌNH ====== */

// Production: fetch-only mode (no dev-mode or WebSocket)

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
    // 🔴 CẤU HÌNH GEMINI LIVE API
    apiKey: window.GEMINI_API_KEY,
    // Use the requested realtime model
    model: 'models/gemini-3.1-flash-tts-preview',
    temperature: 0.7
};

// Only fetch pipeline used; no realtime model fallbacks required here
let CURRENT_RESPONSE_MODALITIES = ["AUDIO"];

// Debug helper: call ModelService.ListModels to see which models this API key can access
// NOTE: client-side ModelService.ListModels helper removed for security.
// Model discovery should be performed server-side. Kept intentionally blank.

// No WebSocket reconnect configuration needed in fetch-only mode

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
// Using fetch-only approach: WebSocket/Simli logic removed from this file
let audioContext = null;

// Speech Recognition (Web Speech API)
let recognition = null; // Web Speech API recognition instance
let userTranscript = ''; // Lưu text từ user nói (interim + final)
let finalUserTranscript = ''; // Lưu final transcript để hiển thị
let lastInterimTranscript = ''; // Store the last interim transcript for fallback
let listenStartTime = null; // timestamp when we started listening (performance.now())

// FAQ Data
let faqData = [];
let isAvatarInCornerMode = false;
let startListeningBtn;
let fullscreenBtn;

let totalSeconds = 0;

/* ====== TIỆN ÍCH ====== */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setConnectionState(state, label) {
    // console.log(`🔄 setConnectionState('${state}', '${label}')`);
    // console.log('  → connectionDot hiện tại:', connectionDot);
    // console.log('  → connectionLabel hiện tại:', connectionLabel);
    connectionDot.className = 'status-dot';
    if (state === 'connecting') connectionDot.classList.add('is-connecting');
    if (state === 'connected') connectionDot.classList.add('is-connected');
    if (state === 'error') connectionDot.classList.add('is-error');
    connectionLabel.textContent = label;
    // console.log('  → connectionDot.className sau thay đổi:', connectionDot.className);
    // console.log('  → connectionLabel.textContent sau thay đổi:', connectionLabel.textContent);
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

        // Prefer final transcript, then last interim, otherwise do not send a default greeting
        let messageForGemini = finalUserTranscript;
        if (!messageForGemini && lastInterimTranscript) messageForGemini = lastInterimTranscript.trim();
        if (!messageForGemini) {
            console.warn('⚠️ No transcript captured; aborting send');
            transcriptText.textContent = 'Không nhận được nội dung, vui lòng thử nói lại.';
            // Reset states
            isUserSpeakingActive = false;
            userTranscript = '';
            finalUserTranscript = '';
            lastInterimTranscript = '';
            setAvatarState('idle');
            return;
        }
        if (DEBUG_FLOW) {
            console.log('📨 SENDING MESSAGE TO GEMINI:', messageForGemini);
            console.log('📊 Connection method:', window.geminiChat ? window.geminiChat.method : 'unknown');
        }

        // 🔴 Hiển thị user transcript lên màn hình
        if (finalUserTranscript) {
            transcriptText.textContent = '🎤 Bạn: ' + finalUserTranscript;
            if (DEBUG_FLOW) console.log('💬 User transcript displayed:', finalUserTranscript);
        }

        sendMessageToGemini(messageForGemini);
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
    // Record listen start time for roundtrip timing
    listenStartTime = performance.now();
    if (DEBUG_FLOW) console.log(`⏱️ Listening started at ${listenStartTime.toFixed(0)}ms`);

    if (DEBUG_FLOW) console.log('🎤 [FLOW] USER STARTED SPEAKING - Initializing speech recognition...');

    // Bắt đầu speech recognition để capture text từ user nói
    userTranscript = '';
    lastInterimTranscript = '';
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

/* ====== GEMINI LIVE WEBSOCKET CONNECTION REMOVED ====== */
// All WebSocket / Simli related logic removed from this file.
// Communication now uses fetch calls via `sendMessageViaFetchAPI()`.
let messageHistory = [];

async function sendMessageViaFetchAPI(userMessage) {
    const t0 = performance.now();
    console.log(`📊 [TIMING START] sendMessageViaFetchAPI at ${t0.toFixed(0)}ms`);
    console.log(`📨 User message: "${userMessage}"`);

    stopVolumeDetection();

    const controller = new AbortController();
    const timeoutMs = 60000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const systemInstruction = `Bạn là Trợ lý Lễ tân ảo giúp đỡ khách hàng.\n\nQUY TẮC:\n1. Trả lời câu hỏi của khách hàng một cách thân thiện và hữu ích.\n2. Luôn trả lời bằng Tiếng Việt.\n3. Trả lời ngắn gọn, tự nhiên.`;

    // Helper: forward the original message to Gemini 2.5 and return its text reply (if any)
    async function sendToGemini36(message) {
        try {
            const url36 = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_LIVE_CONFIG.apiKey}`;
            const body36 = {
                systemInstruction: { parts: [{ text: systemInstruction }] },
                generationConfig: { responseModalities: ["TEXT"] },
                contents: [{ parts: [{ text: message }] }]
            };

            if (DEBUG_FLOW) console.log('📡 [FORWARD->2.5] Sending to Gemini 2.5:', message.substring(0,120));

            const resp36 = await fetch(url36, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body36)
            });

            if (!resp36.ok) {
                const errText = await resp36.text();
                console.warn('⚠️ Gemini 2.5 responded with error', resp36.status, errText.substring(0,200));
                return null;
            }

            const data36 = await resp36.json();
            const text36 = data36?.candidates?.[0]?.content?.parts?.[0]?.text || null;
            if (text36) {
                if (DEBUG_FLOW) console.log('✅ [2.5] Text received:', text36.substring(0,120));
                return text36;
            }
            return null;
        } catch (err) {
            console.error('❌ sendToGemini36 error:', err);
            return null;
        }
    }

    // First, attempt to forward the user's raw message to Gemini 2.5 and use its text reply
    try {
        const forwarded = await sendToGemini36(userMessage);
        if (forwarded) {
            console.log('🔁 Using Gemini 2.5 response as input for Gemini 3.1');
            userMessage = forwarded;
        }
    } catch (e) {
        console.warn('⚠️ Forward to Gemini 2.5 failed, proceeding with original message');
    }

    const payload = {
        generationConfig: {
            responseModalities: CURRENT_RESPONSE_MODALITIES,
            speechConfig: {
                voiceConfig: {
                    prebuiltVoiceConfig: {
                        voiceName: "Kore"
                    }
                }
            }
		},
        contents: [{
            parts: [{
                text: userMessage
            }]
        }]
    };

    const url = `https://generativelanguage.googleapis.com/v1beta/${GEMINI_LIVE_CONFIG.model}:generateContent?key=${GEMINI_LIVE_CONFIG.apiKey}`;

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!resp.ok) {
            const errText = await resp.text();
            throw new Error(`API ${resp.status}: ${errText}`);
        }

        const contentType = resp.headers.get('Content-Type') || '';

        // Helper to handle a parsed response object
        function handleResponseObject(data) {
            try {
                const parts = data?.candidates?.[0]?.content?.parts || [];
                if (parts.length > 0) {
                    setAvatarState('speaking');
                }
                for (const part of parts) {
                    if (part.inlineData?.mimeType?.includes('audio')) {
                        if (DEBUG_FLOW) console.log('🔊 Received audio chunk via fetch');
                        playAudioChunk(part.inlineData.data);
                    } else if (part.text) {
                        if (DEBUG_FLOW) console.log('💬 Received text via fetch:', part.text);
                        transcriptText.textContent = part.text;
                        // If there's no inline audio for this part, use browser TTS as fallback
                        if (!parts.some(p => p.inlineData && p.inlineData.mimeType && p.inlineData.mimeType.includes('audio'))) {
                            speakText(part.text);
                        }
                    }
                }

                // Function calling support (best-effort logging)
                const functionCall = data?.candidates?.[0]?.content?.functionCall || data?.function_call;
                if (functionCall) {
                    console.log('🔧 Function call from model:', functionCall);
                    transcriptText.textContent = '[Function call received] ' + (functionCall.name || '');
                }

                // turnComplete / end signal
                if (data?.candidates?.[0]?.content?.turnComplete || data?.serverContent?.turnComplete) {
                    setTimeout(() => {
                        if (!isAvatarInCornerMode) setAvatarState('idle');
                    }, 800);
                }
            } catch (err) {
                console.error('❌ handleResponseObject error:', err);
            }
        }

        // If streaming-ish response (text/event-stream or readable body), try to stream
        // if (contentType.includes('text/event-stream') || resp.body && typeof resp.body.getReader === 'function') {
        //     // Read as stream and parse newline-delimited JSON if present
        //     const reader = resp.body.getReader();
        //     const decoder = new TextDecoder();
        //     let buf = '';
        //     while (true) {
        //         const {
        //             done,
        //             value
        //         } = await reader.read();
        //         if (done) break;
        //         buf += decoder.decode(value, {
        //             stream: true
        //         });
        //         const lines = buf.split('\n');
        //         buf = lines.pop(); // remainder
        //         for (const line of lines) {
        //             const trimmed = line.trim();
        //             if (!trimmed) continue;
        //             try {
        //                 const obj = JSON.parse(trimmed);
        //                 handleResponseObject(obj);
        //             } catch (e) {
        //                 // Not JSON — skip
        //                 // if (DEBUG_FLOW) console.warn('⚠️ Non-JSON chunk in stream:', trimmed.substring(0, 200));
        //             }
        //         }
        //     }
        //     // attempt to parse remainder
		// 	console.log('📊 [TIMING END] Finished reading stream, attempting to parse remainder', buf);
        //     if (buf.trim()) {
        //         try {
        //             handleResponseObject(JSON.parse(buf));
        //         } catch (e) {
        //             /* ignore */ }
        //     }
        // } else {
        //     // Non-streaming JSON response
        //     const data = await resp.json();
        //     handleResponseObject(data);
        // }
		const data = await resp.json();
		handleResponseObject(data);

        // Re-enable volume detection after processing
        if (localMicStream) setTimeout(() => setupMicVolumeDetection(), 300);

    } catch (err) {
        console.error('❌ sendMessageViaFetchAPI error:', err);
        transcriptText.textContent = '❌ Lỗi: Không thể lấy phản hồi từ API. Vui lòng thử lại.';
        isUserSpeakingActive = false;
        isGeminiSpeaking = false;
        finalUserTranscript = '';
        setAvatarState('idle');
        if (localMicStream) setTimeout(() => setupMicVolumeDetection(), 500);
    }
}

/* (WebSocket send removed) */

/* ====== MESSAGE & RESPONSE ====== */
async function sendMessageToGemini(userMessage) {
    try {
        if (!userMessage || userMessage.trim() === '') {
            console.warn('⚠️ Message rỗng, không gửi');
            return;
        }

        console.log('📤 Gửi message sang Gemini:', userMessage);
        setAvatarState('speaking');

        // Default: use fetch-based pipeline
        await sendMessageViaFetchAPI(userMessage);

    } catch (err) {
        console.error('❌ Lỗi gửi message:', err);
        transcriptText.textContent = 'Lỗi: ' + err.message;
        setConnectionState('error', 'Lỗi kết nối');
        setTimeout(() => setAvatarState('idle'), 2000);
    }
}

/* ====== CONVERT PCM TO WAV ====== */
function pcmToWav(pcmData) {
    // PCM format: L16 (16-bit, mono), 24kHz
    const sampleRate = 24000;
    const channels = 1;
    const bytesPerSample = 2; // 16-bit = 2 bytes

    // WAV header (44 bytes)
    function createWavHeader(dataLength) {
        const header = new ArrayBuffer(44);
        const view = new DataView(header);

        // "RIFF" chunk descriptor
        const writeString = (offset, string) => {
            for (let i = 0; i < string.length; i++) {
                view.setUint8(offset + i, string.charCodeAt(i));
            }
        };

        writeString(0, 'RIFF');
        // File size - 8
        view.setUint32(4, dataLength + 36, true);
        writeString(8, 'WAVE');

        // "fmt " sub-chunk
        writeString(12, 'fmt ');
        view.setUint32(16, 16, true); // Sub-chunk size (16 for PCM)
        view.setUint16(20, 1, true); // Audio format (1 = PCM)
        view.setUint16(22, channels, true); // Num channels
        view.setUint32(24, sampleRate, true); // Sample rate
        // Byte rate = sample_rate * channels * bytes_per_sample
        view.setUint32(28, sampleRate * channels * bytesPerSample, true);
        // Block align = channels * bytes_per_sample
        view.setUint16(32, channels * bytesPerSample, true);
        // Bits per sample
        view.setUint16(34, 16, true);

        // "data" sub-chunk
        writeString(36, 'data');
        view.setUint32(40, dataLength, true); // Data length

        return new Uint8Array(header);
    }

    const wavHeader = createWavHeader(pcmData.length);
    const wavData = new Uint8Array(wavHeader.length + pcmData.length);
    wavData.set(wavHeader, 0);
    wavData.set(pcmData, wavHeader.length);

    return wavData;
}

/* ====== PLAY AUDIO CHUNK FROM GEMINI ====== */
function playAudioChunk(base64Audio) {
    try {
        if (!base64Audio) {
            console.error('❌ Audio data trống');
            return;
        }

        // Convert base64 thành Uint8Array
        const binaryString = atob(base64Audio);
        const pcmBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            pcmBytes[i] = binaryString.charCodeAt(i);
        }

        if (DEBUG_FLOW) console.log('📥 PCM audio data received, size:', pcmBytes.length, 'bytes');

        // Convert raw PCM (L16) thành WAV format
        const wavData = pcmToWav(pcmBytes);

        // Tạo Blob từ WAV data
        const blob = new Blob([wavData], {
            type: 'audio/wav'
        });
        const blobUrl = URL.createObjectURL(blob);

        // Tạo Audio element và phát
        const audioElement = new Audio();
        audioElement.src = blobUrl;

        // Lưu reference để có thể stop nếu cần
        currentAudioElement = audioElement;

        audioElement.onended = () => {
            URL.revokeObjectURL(blobUrl);
            currentAudioElement = null;

            if (DEBUG_FLOW) console.log('✅ Audio phát xong, reset flags');

            // Log roundtrip time from when listening started to audio end
            if (listenStartTime) {
                const tEnd = performance.now();
                const elapsed = tEnd - listenStartTime;
                console.log(`⏱️ Roundtrip time (listen → audio end): ${elapsed.toFixed(0)} ms`);
                listenStartTime = null;
            }

            // 🔴 NGAY LẬP TỨC: Reset flags để có thể nói lại
            isUserSpeakingActive = false;
            isGeminiSpeaking = false;
            finalUserTranscript = ''; // 🔴 Reset transcript

            // Quay về idle sau khi audio phát xong
            if (!isAvatarInCornerMode) {
                setAvatarState('idle');
            }

            // 🔴 Re-enable volume detection NGAY để user có thể nói lại
            if (localMicStream) {
                if (DEBUG_FLOW) console.log('🎤 [AUDIO END] Re-enabling volume detection');
                setupMicVolumeDetection();
            }
        };

        audioElement.onerror = (err) => {
            console.error('❌ Lỗi phát audio:', err);
            URL.revokeObjectURL(blobUrl);
            currentAudioElement = null;

            // 🔴 RESET FLAGS ngay lập tức nếu lỗi
            isUserSpeakingActive = false;
            isGeminiSpeaking = false;
            finalUserTranscript = ''; // 🔴 Reset transcript
            // clear listen timer on error
            listenStartTime = null;
            setAvatarState('idle');
        };

        if (DEBUG_FLOW) console.log('🔊 Phát audio WAV từ Blob URL');
        audioElement.play().catch(err => {
            console.error('❌ Lỗi play audio:', err);
            URL.revokeObjectURL(blobUrl);
            currentAudioElement = null;

            // 🔴 RESET FLAGS nếu play fail
            isUserSpeakingActive = false;
            isGeminiSpeaking = false;
            finalUserTranscript = ''; // 🔴 Reset transcript
            setAvatarState('idle');
        });

    } catch (err) {
        console.error('❌ Play audio chunk error:', err);
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
        // Log roundtrip time if we started listening earlier
        if (listenStartTime) {
            const tEnd = performance.now();
            const elapsed = tEnd - listenStartTime;
            console.log(`⏱️ Roundtrip time (listen → browser TTS end): ${elapsed.toFixed(0)} ms`);
            listenStartTime = null;
        }
        if (!isAvatarInCornerMode) {
            setupMicVolumeDetection();
        }
    };

    utterance.onerror = (event) => {
        console.error('❌ Lỗi Browser TTS:', event.error);
        isGeminiSpeaking = false;
        listenStartTime = null;
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
                vlog('~ Interim:', interim);
            }
        }

        // Hiển thị interim result lên giao diện
        if (interim) {
            transcriptText.textContent = interim;
            lastInterimTranscript = interim;
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

/* ====== CONFIGURE GEMINI (FETCH) ====== */
function configureGeminiFetch() {
    faqData = [];
    console.log('✓ FAQ data disabled');
    if (!window.GEMINI_API_KEY) {
        throw new Error('API key not found in window.GEMINI_API_KEY');
    }
    window.geminiChat = {
        method: 'fetch',
        apiKey: GEMINI_LIVE_CONFIG.apiKey
    };
    console.log('✓ Gemini configured for fetch-only mode');
    setAvatarState('idle');
    transcriptText.textContent = 'Sẵn sàng. Bạn có thể bắt đầu nói.';
}

/* ====== START BUTTON ====== */
async function handleStartClick() {
    startBtn.disabled = true;
    startBtn.textContent = 'Đang xin quyền micro...';
    permissionError.style.display = 'none';

    try {
        console.log('1️⃣ Bắt đầu quá trình bật ứng dụng...');

        // 1. Xin quyền mở Micro
        console.log('2️⃣ Yêu cầu quyền micro...');
        localMicStream = await navigator.mediaDevices.getUserMedia(audioConstraints);
        console.log('✓ Đã cấp quyền micro thành công');

        console.log('3️⃣ Chuyển sang màn hình ứng dụng...');
        welcomeScreen.style.display = 'none';
        appScreen.style.display = 'flex';
        applyFaqState(false);
        setConnectionState('connecting', 'Đang kết nối...');

        // Khởi tạo Speech Recognition
        if (!recognition) {
            console.log('3️⃣.5️⃣ Khởi tạo Speech Recognition...');
            initSpeechRecognition();
        }

        // Configure fetch-only Gemini
        configureGeminiFetch();
        avatarPlaceholder.style.display = 'none';
        setConnectionState('connected', 'Đã kết nối');

        // Thiết lập phát hiện micro input
        if (localMicStream) {
            console.log('5️⃣ Thiết lập phát hiện âm thanh micro...');
            setupMicVolumeDetection();
        } else {
            console.log('⚠️ Không có micro stream, một số chức năng sẽ bị giới hạn');
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
        if (Math.random() < 0.05) { // ~5% chance để không spam log
            vlog(`📊 Volume: ${average.toFixed(1)} (threshold: ${VOLUME_THRESHOLD})`);
        }

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
/* Dev shortcuts removed */

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
            console.log('ℹ️ Không có stream micro để bật/tắt');
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

        // WebSocket logic removed (fetch-only mode)
        // (no-op: previously closed WS connection here)
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