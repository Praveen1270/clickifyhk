interface SettingsPayload {
  cartesia: string;
  openrouter: string;
  gemini: string;
  llmProvider: string;
}

interface SettingsAPI {
  get: () => Promise<SettingsPayload>;
  save: (data: SettingsPayload) => Promise<{ ok: boolean }>;
  setMicrophone?: (deviceId: string) => void;
}

const settingsApi = (window as unknown as { clickifySettings: SettingsAPI }).clickifySettings;

function el<T extends HTMLElement>(id: string): T {
  const n = document.getElementById(id);
  if (!n) throw new Error(`#${id}`); return n as T;
}

const LLM_COPY: Record<string, string> = {
  openrouter:
    'Uses Google Gemini 2.5 Flash via OpenRouter. Enter your OpenRouter API key in the field below.',
  gemini:
    'Uses Google Gemini 2.0 Flash for vision. Enter your Gemini API key in the field below.',
};

function setLlmUi(provider: 'openrouter' | 'gemini') {
  el<HTMLInputElement>('llmProvider').value = provider;
  el<HTMLButtonElement>('btn-llm-openrouter').classList.toggle('active', provider === 'openrouter');
  el<HTMLButtonElement>('btn-llm-gemini').classList.toggle('active', provider === 'gemini');
  el<HTMLElement>('panel-openrouter').hidden = provider !== 'openrouter';
  el<HTMLElement>('panel-gemini').hidden = provider !== 'gemini';
  el<HTMLParagraphElement>('llm-desc').textContent = LLM_COPY[provider];
}

async function load() {
  const s = await settingsApi.get();
  el<HTMLInputElement>('cartesia').value = s.cartesia;
  el<HTMLInputElement>('openrouter').value = s.openrouter;
  el<HTMLInputElement>('gemini').value = s.gemini;
  const p = s.llmProvider === 'gemini' ? 'gemini' : 'openrouter';
  setLlmUi(p);
}

el<HTMLButtonElement>('btn-llm-openrouter').addEventListener('click', () => setLlmUi('openrouter'));
el<HTMLButtonElement>('btn-llm-gemini').addEventListener('click', () => setLlmUi('gemini'));

document.querySelectorAll<HTMLButtonElement>('.toggle-vis').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-target');
    if (!id) return;
    const input = el<HTMLInputElement>(id);
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });
});

function validate(): string | null {
  const cartesia = el<HTMLInputElement>('cartesia').value.trim();
  const openrouter = el<HTMLInputElement>('openrouter').value.trim();
  const gemini = el<HTMLInputElement>('gemini').value.trim();
  const llm = el<HTMLInputElement>('llmProvider').value;
  if (!cartesia) return 'Cartesia API key is required for speech.';
  if (llm === 'openrouter' && !openrouter) return 'OpenRouter API key is required when OpenRouter is selected.';
  if (llm === 'gemini' && !gemini) return 'Gemini API key is required when Gemini is selected.';
  return null;
}

el<HTMLFormElement>('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = el<HTMLDivElement>('msg');
  const err = validate();
  if (err) { msg.textContent = err; msg.className = 'err'; return; }
  msg.textContent = '';
  await settingsApi.save({
    cartesia: el<HTMLInputElement>('cartesia').value.trim(),
    openrouter: el<HTMLInputElement>('openrouter').value.trim(),
    gemini: el<HTMLInputElement>('gemini').value.trim(),
    llmProvider: el<HTMLInputElement>('llmProvider').value,
  });
  msg.textContent = 'Saved. You can close this window.';
  msg.className = 'ok';
});

// ─── Microphone handling & Live Meter ─────────────────────────────────────────

let meterStream: MediaStream | null = null;
let meterAudioCtx: AudioContext | null = null;
let meterAnimFrame: number | null = null;

async function setupMicMeter(deviceId?: string) {
  if (meterAnimFrame) cancelAnimationFrame(meterAnimFrame);
  if (meterStream) {
    meterStream.getTracks().forEach(t => t.stop());
    meterStream = null;
  }
  if (meterAudioCtx) {
    try { await meterAudioCtx.close(); } catch {}
    meterAudioCtx = null;
  }

  const bar = el<HTMLDivElement>('micMeterBar');
  const val = el<HTMLSpanElement>('micMeterValue');
  const hint = el<HTMLParagraphElement>('micStatusHint');

  try {
    meterStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
    });

    meterAudioCtx = new AudioContext();
    const source = meterAudioCtx.createMediaStreamSource(meterStream);
    const analyser = meterAudioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    const floatData = new Float32Array(analyser.fftSize);

    function updateMeter() {
      if (!meterAudioCtx || meterAudioCtx.state !== 'running') {
        if (meterAudioCtx?.state === 'suspended') void meterAudioCtx.resume();
      }
      analyser.getFloatTimeDomainData(floatData);
      let sum = 0;
      for (let i = 0; i < floatData.length; i++) sum += floatData[i] * floatData[i];
      const rms = Math.sqrt(sum / floatData.length);

      // Scale RMS to percentage (0.001 - 0.20 -> 0% - 100%)
      const pct = Math.min(100, Math.round(rms * 500));
      bar.style.width = `${pct}%`;
      val.textContent = `${pct}%`;
      if (pct > 4) {
        hint.textContent = 'Microphone is picking up sound!';
        hint.style.color = '#4ade80';
      } else {
        hint.textContent = 'Speak now to test your microphone level.';
        hint.style.color = '#a1a1aa';
      }
      meterAnimFrame = requestAnimationFrame(updateMeter);
    }
    updateMeter();
  } catch (err) {
    console.error('Failed to setup mic meter:', err);
    bar.style.width = '0%';
    val.textContent = 'Off';
    hint.textContent = 'Could not access selected microphone.';
    hint.style.color = '#f87171';
  }
}

async function loadMicrophones() {
  const micSelect = el<HTMLSelectElement>('micSelect');
  try {
    // Request permission first to reveal labels
    const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    tempStream.getTracks().forEach(t => t.stop());

    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter(d => d.kind === 'audioinput');

    micSelect.innerHTML = '';
    const virtualNames = ['iriun', 'obs virtual', 'droidcam', 'camo', 'epoccam'];

    let saved = localStorage.getItem('clickify_mic_id') || '';
    let selectedId = '';

    mics.forEach((m, idx) => {
      const opt = document.createElement('option');
      opt.value = m.deviceId;
      const isVirtual = virtualNames.some(v => m.label.toLowerCase().includes(v));
      opt.textContent = (m.label || `Microphone ${idx + 1}`) + (isVirtual ? ' (Virtual - silent if disconnected)' : '');
      micSelect.appendChild(opt);
    });

    // Pick saved, or first non-virtual, non-default hardware mic
    if (saved && mics.some(m => m.deviceId === saved)) {
      selectedId = saved;
    } else {
      const real = mics.find(m =>
        !virtualNames.some(v => m.label.toLowerCase().includes(v)) &&
        m.deviceId !== 'default' && m.deviceId !== 'communications'
      );
      selectedId = real ? real.deviceId : (mics[0]?.deviceId || '');
      if (selectedId) {
        localStorage.setItem('clickify_mic_id', selectedId);
        settingsApi.setMicrophone?.(selectedId);
      }
    }

    micSelect.value = selectedId;
    void setupMicMeter(selectedId);

    micSelect.addEventListener('change', () => {
      const newId = micSelect.value;
      localStorage.setItem('clickify_mic_id', newId);
      settingsApi.setMicrophone?.(newId);
      void setupMicMeter(newId);
    });
  } catch (err) {
    console.error('Error loading microphones:', err);
    micSelect.innerHTML = '<option value="">Microphone permission denied</option>';
  }
}

void load();
void loadMicrophones();
