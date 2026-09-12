// ─── API Bridge ───────────────────────────────────────────────────────────────

interface Step {
  speak: string;
}

interface ClickifyAPI {
  captureScreenshot: () => Promise<string | null>;
  transcribeAudio:   (buf: ArrayBuffer) => Promise<{ transcript: string; language: string } | null>;
  askAI:             (transcript: string, screenshot: string, language: string) => Promise<Step[] | null>;
  textToSpeech:      (text: string, language: string) => Promise<string | null>;
  setSessionState:   (active: boolean) => void;
  onPTT:             (cb: () => void) => void;
  onAudioResume:     (cb: () => void) => void;
  onMicChanged?:     (cb: (deviceId: string) => void) => void;
  setMicrophone?:    (deviceId: string) => void;
}

const api = (window as unknown as { clickify: ClickifyAPI }).clickify;

// ─── State ────────────────────────────────────────────────────────────────────

type AppState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
let state: AppState = 'idle';
const orb = document.getElementById('orb') as HTMLDivElement;

function setState(next: AppState) {
  state = next;
  orb.className = next;
  api.setSessionState(next !== 'idle');
}

// ─── Stop-command detection ───────────────────────────────────────────────────

const STOP_PHRASES = [
  'stop', 'stop it', 'cancel', 'quit', 'enough', 'shut up', 'be quiet', 'silence',
  'రుకో', 'రుక జాఓ', 'ఆపు', 'ఆపండి', 'చాలు', 'మాట్లాడకు',
  'रुको', 'रुक जाओ', 'बंद करो', 'चुप', 'बस',
];

function isStopCommand(text: string): boolean {
  const t = text.trim().toLowerCase();
  return STOP_PHRASES.some((p) => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
}

// ─── Microphone stream & device selection ─────────────────────────────────────

let micStream: MediaStream | null = null;
let currentDeviceId: string | undefined = undefined;

async function selectBestMicDeviceId(): Promise<string | undefined> {
  try {
    const saved = localStorage.getItem('clickify_mic_id');
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    console.log('[Clickify Renderer] Found', mics.length, 'audio input devices:');
    mics.forEach((m, i) => console.log(`  [${i}] ${m.label || '(unnamed)'} id: ${m.deviceId}`));

    if (saved && mics.some((m) => m.deviceId === saved)) {
      console.log('[Clickify Renderer] Using saved microphone:', saved);
      return saved;
    }

    // Filter out known silent or virtual webcam microphones (Iriun, OBS, DroidCam, etc.)
    const virtualNames = ['iriun', 'obs virtual', 'droidcam', 'camo', 'epoccam'];
    const realHardwareMics = mics.filter((m) => {
      const lower = m.label.toLowerCase();
      return (
        !virtualNames.some((v) => lower.includes(v)) &&
        m.deviceId !== 'default' &&
        m.deviceId !== 'communications'
      );
    });

    if (realHardwareMics.length > 0) {
      console.log('[Clickify Renderer] Auto-selected hardware microphone:', realHardwareMics[0].label);
      localStorage.setItem('clickify_mic_id', realHardwareMics[0].deviceId);
      return realHardwareMics[0].deviceId;
    }

    // Fallback: pick any non-virtual mic
    const nonVirtual = mics.filter((m) => !virtualNames.some((v) => m.label.toLowerCase().includes(v)));
    if (nonVirtual.length > 0) {
      console.log('[Clickify Renderer] Selected non-virtual microphone:', nonVirtual[0].label);
      return nonVirtual[0].deviceId;
    }

    return undefined;
  } catch (err) {
    console.warn('[Clickify Renderer] Could not enumerate microphones:', err);
    return undefined;
  }
}

async function setupMicrophone(deviceId?: string): Promise<boolean> {
  try {
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }

    currentDeviceId = deviceId ?? (await selectBestMicDeviceId());
    console.log('[Clickify Renderer] Connecting to mic deviceId:', currentDeviceId ?? 'system default');

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: currentDeviceId ? { exact: currentDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const track = micStream.getAudioTracks()[0];
    console.log('[Clickify Renderer] Microphone connected! Active device:', track?.label);
    return true;
  } catch (err) {
    console.error('[Clickify Renderer] Microphone connection failed:', err);
    return false;
  }
}

// ─── VAD Loop & Audio Processing ──────────────────────────────────────────────

let busy = false;
let currentAudio: HTMLAudioElement | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;

function calcFloatRMS(data: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
  return Math.sqrt(sum / data.length);
}

function startAudioProcessing() {
  if (audioCtx) {
    try { void audioCtx.close(); } catch {}
  }

  audioCtx = new AudioContext();
  const resumeAudio = () => {
    if (audioCtx && audioCtx.state !== 'running') {
      void audioCtx.resume().catch(() => {});
    }
  };
  resumeAudio();
  api.onAudioResume(resumeAudio);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeAudio();
  });

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.2;

  sourceNode = audioCtx.createMediaStreamSource(micStream!);
  sourceNode.connect(analyser);

  const floatData = new Float32Array(analyser.fftSize);
  let recording = false;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let silTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let noiseFloor = 0.003;
  let lastLog = 0;

  function tick() {
    if (busy) {
      setTimeout(tick, 200);
      return;
    }

    if (audioCtx?.state === 'suspended') {
      void audioCtx.resume().catch(() => {});
    }

    analyser!.getFloatTimeDomainData(floatData);
    const rms = calcFloatRMS(floatData);

    const now = Date.now();
    if (now - lastLog > 4000) {
      lastLog = now;
      console.log(`[Clickify Audio] RMS: ${rms.toFixed(5)} | NoiseFloor: ${noiseFloor.toFixed(5)} | Ctx: ${audioCtx?.state}`);
    }

    // Adaptive noise floor tracking during quiet idle periods
    if (!recording && !pttRecording) {
      noiseFloor = noiseFloor * 0.95 + rms * 0.05;
    }

    // Speech threshold: sensitive for desktop/laptop mics (minimum 0.010, or 1.8x noise floor)
    const voiceThresh = Math.max(0.010, Math.min(0.05, noiseFloor * 1.8));
    const isSpeaking = rms > voiceThresh;

    if (isSpeaking && !recording && !pttRecording) {
      console.log(`[Clickify Renderer] Voice detected (RMS: ${rms.toFixed(4)} vs thresh: ${voiceThresh.toFixed(4)}) - recording started`);
      recording = true;
      chunks = [];
      try {
        recorder = new MediaRecorder(micStream!, { mimeType: bestMime() });
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };
        recorder.start(100);
        setState('listening');

        // Safety timeout: max 12 seconds
        if (maxTimer) clearTimeout(maxTimer);
        maxTimer = setTimeout(() => {
          if (recording && recorder?.state === 'recording') {
            console.log('[Clickify Renderer] Max recording duration reached');
            finishRecording();
          }
        }, 12000);
      } catch (err) {
        console.error('[Clickify Renderer] Failed to start recorder:', err);
        recording = false;
      }

    } else if (isSpeaking && recording) {
      if (silTimer) {
        clearTimeout(silTimer);
        silTimer = null;
      }

    } else if (!isSpeaking && recording && !silTimer) {
      silTimer = setTimeout(() => {
        finishRecording();
      }, 1000); // 1.0 second silence before processing
    }

    function finishRecording() {
      if (!recorder || recorder.state !== 'recording') return;
      console.log('[Clickify Renderer] Silence detected, processing recording...');
      recording = false;
      busy = true;
      if (silTimer) { clearTimeout(silTimer); silTimer = null; }
      if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }

      recorder.onstop = async () => {
        setState('thinking');
        try {
          await runPipeline(chunks);
        } catch (err) {
          console.error('[Clickify Pipeline Error]', err);
          setState('error');
          await sleep(1500);
        }
        busy = false;
        silTimer = null;
        setState('idle');
        setTimeout(tick, 35);
      };
      recorder.stop();
    }

    if (!busy) setTimeout(tick, 35);
  }

  setTimeout(tick, 35);
}

// ─── Push-to-Talk handler ─────────────────────────────────────────────────────

let pttRecording = false;
let pttRecorder:  MediaRecorder | null = null;
let pttChunks:    Blob[] = [];
let pttTimeout:   ReturnType<typeof setTimeout> | null = null;

function handlePTT() {
  if (busy || !micStream) return;

  if (!pttRecording) {
    console.log('[Clickify Renderer] PTT recording started...');
    pttRecording = true;
    pttChunks = [];
    try {
      pttRecorder = new MediaRecorder(micStream!, { mimeType: bestMime() });
      pttRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) pttChunks.push(e.data);
      };
      pttRecorder.start(100);
      setState('listening');
    } catch (err) {
      console.error('[Clickify Renderer] PTT MediaRecorder error:', err);
      pttRecording = false;
      return;
    }

    // Safety timeout: 12 seconds max
    if (pttTimeout) clearTimeout(pttTimeout);
    pttTimeout = setTimeout(() => {
      if (pttRecording) {
        console.log('[Clickify Renderer] PTT timeout reached, stopping...');
        stopPTT();
      }
    }, 12000);

  } else {
    stopPTT();
  }
}

function stopPTT() {
  if (pttTimeout) { clearTimeout(pttTimeout); pttTimeout = null; }
  if (!pttRecorder || pttRecorder.state !== 'recording') {
    pttRecording = false;
    return;
  }
  console.log('[Clickify Renderer] PTT recording stopped, processing...');
  pttRecording = false;
  busy = true;

  pttRecorder.onstop = async () => {
    setState('thinking');
    try {
      await runPipeline(pttChunks);
    } catch (err) {
      console.error('[Clickify PTT Pipeline Error]', err);
      setState('error');
      await sleep(1500);
    }
    busy = false;
    setState('idle');
  };
  pttRecorder.stop();
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(chunks: Blob[]) {
  console.log('[Clickify Renderer] Starting pipeline with', chunks.length, 'audio chunks');
  const blob = new Blob(chunks, { type: chunks[0]?.type ?? 'audio/webm' });
  console.log('[Clickify Renderer] Total audio size:', blob.size, 'bytes');

  if (blob.size < 500) {
    throw new Error('Audio too short or empty.');
  }

  const [screenshot, stt] = await Promise.all([
    api.captureScreenshot(),
    blob.arrayBuffer().then((ab) => api.transcribeAudio(ab)),
  ]);

  if (!stt || !stt.transcript) {
    console.warn('[Clickify Renderer] No transcript returned from STT');
    throw new Error('Nothing heard — speak a bit louder.');
  }
  const { transcript, language } = stt;
  console.log('[Clickify Renderer] User said:', transcript, '(lang:', language, ')');

  if (isStopCommand(transcript)) {
    console.log('[Clickify Renderer] Stop command recognized');
    stopAudio();
    return;
  }

  console.log('[Clickify Renderer] Requesting AI steps...');
  const steps = await api.askAI(transcript, screenshot ?? '', language);
  if (!steps || steps.length === 0) {
    console.warn('[Clickify Renderer] No steps returned by AI');
    throw new Error('No AI response.');
  }

  console.log('[Clickify Renderer] Pre-generating speech for', steps.length, 'step(s)');
  const ttsJobs = steps.map((s) => api.textToSpeech(s.speak, language));

  setState('speaking');

  for (let i = 0; i < steps.length; i++) {
    const base64 = await ttsJobs[i];
    if (!base64) throw new Error(`TTS failed on step ${i + 1}.`);
    console.log('[Clickify Renderer] Speaking step', i + 1, ':', steps[i].speak);
    await playWav(base64);

    if (i < steps.length - 1) await sleep(800);
  }
}

// ─── Audio helpers ────────────────────────────────────────────────────────────

function stopAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
    currentAudio = null;
  }
}

function playWav(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stopAudio();
    const audio = new Audio(`data:audio/wav;base64,${base64}`);
    audio.volume = 1.0;
    currentAudio = audio;
    audio.onended = () => {
      currentAudio = null;
      resolve();
    };
    audio.onerror = (e) => {
      console.error('[Clickify Renderer] Audio playback error:', e);
      currentAudio = null;
      reject(new Error('Playback failed.'));
    };
    audio.play().catch((err) => {
      console.error('[Clickify Renderer] audio.play() rejected:', err);
      reject(err);
    });
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

function bestMime(): string {
  for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return 'audio/webm';
}

// ─── App Initialization ───────────────────────────────────────────────────────

async function init() {
  try {
    console.log('[Clickify Renderer] Initializing audio...');
    const ok = await setupMicrophone();
    if (!ok) throw new Error('Could not initialize microphone');

    setState('idle');

    // Register Push-to-Talk hotkey listener
    api.onPTT(() => handlePTT());

    // Listen for microphone changes from settings
    if (api.onMicChanged) {
      api.onMicChanged(async (deviceId: string) => {
        console.log('[Clickify Renderer] Microphone change requested:', deviceId);
        localStorage.setItem('clickify_mic_id', deviceId);
        const switched = await setupMicrophone(deviceId);
        if (switched) startAudioProcessing();
      });
    }

    startAudioProcessing();
  } catch (err) {
    console.error('[Clickify Renderer] Initialization failed:', err);
    setState('error');
  }
}

init();
