import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  screen,
  ipcMain,
  desktopCapturer,
  session,
  globalShortcut,
} from 'electron';
import * as https from 'https';
import * as zlib  from 'zlib';
import * as fs   from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { parse as parseEnv } from 'dotenv';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function userEnvPath(): string {
  return path.join(app.getPath('userData'), 'clickify.env');
}

/** Dev `.env` then `%AppData%/Clickify/clickify.env` (override). */
function loadEnvFiles(): void {
  if (!app.isPackaged) {
    const devPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(devPath)) dotenv.config({ path: devPath });
  }
  if (fs.existsSync(userEnvPath())) dotenv.config({ path: userEnvPath(), override: true });
}

function readMergedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!app.isPackaged) {
    const devPath = path.join(__dirname, '../../.env');
    if (fs.existsSync(devPath)) Object.assign(out, parseEnv(fs.readFileSync(devPath)));
  }
  if (fs.existsSync(userEnvPath())) Object.assign(out, parseEnv(fs.readFileSync(userEnvPath())));
  return out;
}

function missingRequiredApiKeys(): boolean {
  const m = readMergedEnv();
  if (!m.CARTESIA_API_KEY?.trim()) return true;
  const prov = (m.LLM_PROVIDER ?? 'openrouter').toLowerCase();
  if (prov === 'openrouter' && !m.OPENROUTER_API_KEY?.trim()) return true;
  if (prov === 'gemini' && !m.GEMINI_API_KEY?.trim()) return true;
  return false;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Step {
  speak: string;
}

interface HistoryEntry {
  userText:      string;
  assistantText: string;
  ts:            number;
}

// ─── Conversation history (last 3 turns, 5-min expiry) ───────────────────────

const history: HistoryEntry[] = [];
const MAX_HISTORY    = 3;
const HISTORY_EXPIRY = 5 * 60 * 1000;

function recentHistory(): HistoryEntry[] {
  const now = Date.now();
  while (history.length && now - history[0].ts > HISTORY_EXPIRY) history.shift();
  return history.slice(-MAX_HISTORY);
}

function pushHistory(userText: string, assistantText: string) {
  history.push({ userText, assistantText, ts: Date.now() });
  if (history.length > MAX_HISTORY) history.shift();
}

// ─── Native HTTPS helper ──────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 20_000;

function nodePost(url: string, headers: Record<string, string>, body: Buffer) {
  return new Promise<{ status: number; text: string; buffer: Buffer }>((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port:     Number(u.port) || 443,
        path:     u.pathname + u.search,
        method:   'POST',
        headers:  { ...headers, 'Content-Length': body.length },
        timeout:  REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data',  (c: Buffer) => chunks.push(c));
        res.on('error', reject);
        res.on('end',   () => {
          const buffer = Buffer.concat(chunks);
          resolve({ status: res.statusCode ?? 0, buffer, text: buffer.toString('utf8') });
        });
      }
    );
    req.on('error',   reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timed out: ${url}`)); });
    req.write(body);
    req.end();
  });
}

function buildMultipart(
  fields: Record<string, string>,
  fileField: string, fileName: string, fileData: Buffer, fileType: string
): { contentType: string; body: Buffer } {
  const boundary = 'ClickifyBoundary' + Date.now();
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${fileType}\r\n\r\n`));
  parts.push(fileData);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(parts) };
}

// ─── LLM: OpenRouter ─────────────────────────────────────────────────────────

async function callOpenRouter(systemPrompt: string, transcript: string, screenshotUrl?: string | null): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set in .env');

  const ctx = recentHistory();
  const hasValidImage = Boolean(screenshotUrl && screenshotUrl.length > 100 && screenshotUrl.startsWith('data:image/'));

  const userContent: object[] = [];
  if (hasValidImage && screenshotUrl) {
    userContent.push({ type: 'image_url', image_url: { url: screenshotUrl } });
  }
  userContent.push({ type: 'text', text: transcript });

  const messages: object[] = [
    { role: 'system', content: systemPrompt },
    ...ctx.flatMap(h => [
      { role: 'user',      content: h.userText },
      { role: 'assistant', content: h.assistantText },
    ]),
    {
      role: 'user',
      content: userContent,
    },
  ];

  const body = Buffer.from(JSON.stringify({
    model: 'google/gemini-2.5-flash',
    response_format: { type: 'json_object' },
    max_tokens: 600,
    temperature: 0.1,
    messages,
  }));

  const doPost = () => nodePost(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://clickify.app',
      'X-Title': 'Clickify',
    },
    body
  );

  let res = await doPost();
  if (res.status === 429) { await delay(8000); res = await doPost(); }
  if (res.status >= 400) throw new Error(`OpenRouter ${res.status}: ${res.text}`);

  try {
    const data = JSON.parse(res.text) as { choices?: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '{}';
  } catch {
    throw new Error(`OpenRouter returned non-JSON: ${res.text.slice(0, 200)}`);
  }
}

// ─── LLM: Gemini ─────────────────────────────────────────────────────────────

async function callGemini(systemPrompt: string, transcript: string, screenshotUrl?: string | null): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set in .env');

  const ctx = recentHistory();
  const hasValidImage = Boolean(screenshotUrl && screenshotUrl.length > 100 && screenshotUrl.startsWith('data:image/'));

  const userParts: object[] = [];
  if (hasValidImage && screenshotUrl) {
    const base64Image = screenshotUrl.replace(/^data:image\/\w+;base64,/, '');
    userParts.push({ inline_data: { mime_type: 'image/png', data: base64Image } });
  }
  userParts.push({ text: transcript });

  const contents: object[] = [
    ...ctx.flatMap(h => [
      { role: 'user',  parts: [{ text: h.userText }] },
      { role: 'model', parts: [{ text: h.assistantText }] },
    ]),
    {
      role: 'user',
      parts: userParts,
    },
  ];

  const body = Buffer.from(JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generation_config: { response_mime_type: 'application/json', max_output_tokens: 600, temperature: 0.1 },
  }));

  const doPost = () => nodePost(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
    { 'Content-Type': 'application/json' },
    body
  );

  let res = await doPost();
  if (res.status === 429) { await delay(5000); res = await doPost(); }
  if (res.status >= 400) throw new Error(`Gemini ${res.status}: ${res.text}`);

  try {
    const data = JSON.parse(res.text) as { candidates?: Array<{ content: { parts: Array<{ text: string }> } }> };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '{}';
  } catch {
    throw new Error(`Gemini returned non-JSON: ${res.text.slice(0, 200)}`);
  }
}

// ─── Language maps ────────────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  'en-IN': 'English', 'hi-IN': 'Hindi', 'te-IN': 'Telugu',
};
const LANG_CARTESIA: Record<string, string> = {
  'en-IN': 'en', 'hi-IN': 'hi', 'te-IN': 'te',
};

// ─── Tray icon (generated in-memory, no file needed) ─────────────────────────

function makeTrayIcon(): Electron.NativeImage {
  const SIZE = 16;
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c;
  }
  function crc32(buf: Buffer): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function chunk(type: string, data: Buffer): Buffer {
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4), 0);
  // Right-pointing triangle (same style as overlay), tip ≈(13, 7), base (2,2)–(2,12)
  const ax = 13, ay = 7, bx = 2, by = 2, cx = 2, cy = 12;
  const sign = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) =>
    (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
  const inTri = (px: number, py: number) => {
    const d1 = sign(px, py, ax, ay, bx, by);
    const d2 = sign(px, py, bx, by, cx, cy);
    const d3 = sign(px, py, cx, cy, ax, ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  for (let y = 0; y < SIZE; y++) {
    raw[y * (1 + SIZE * 4)] = 0;
    for (let x = 0; x < SIZE; x++) {
      let a = 0;
      if (inTri(x + 0.5, y + 0.5)) a = 255;
      else {
        // Soft halo (match “glow” look on a tiny tray icon)
        for (let dy = -1; dy <= 1 && !a; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (inTri(x + 0.5 + dx * 0.45, y + 0.5 + dy * 0.45)) { a = 90; break; }
          }
        }
      }
      if (a > 0) {
        const o = y * (1 + SIZE * 4) + 1 + x * 4;
        raw[o] = 255; raw[o + 1] = 130; raw[o + 2] = 20; raw[o + 3] = a;
      }
    }
  }
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** Same orange triangle as `assets/icon.png` (generated by scripts/generate-icon.js). */
function appIconPath(): string {
  return path.join(__dirname, '../assets/icon.png');
}

function loadAppIcon(): Electron.NativeImage {
  const p = appIconPath();
  if (fs.existsSync(p)) {
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    } catch {
      /* use generated fallback */
    }
  }
  return makeTrayIcon();
}

// ─── Overlay window — follows the cursor ─────────────────────────────────────
//
// The SVG is a right-pointing triangle; its tip sits at ≈(40, 24) within the 48×48 window.
// Positioning the window at (cursor.x − 40, cursor.y − 24) aligns the tip with the OS cursor.

const CURSOR_TIP_X = 40;
const CURSOR_TIP_Y = 24;

let overlayWindow:   BrowserWindow | null = null;
let settingsWindow:  BrowserWindow | null = null;
let tray:            Tray | null = null;
let followInterval:  ReturnType<typeof setInterval> | null = null;

function startCursorFollow() {
  if (followInterval) clearInterval(followInterval);
  followInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    overlayWindow.setPosition(
      Math.round(pt.x - CURSOR_TIP_X),
      Math.round(pt.y - CURSOR_TIP_Y),
    );
  }, 16); // ~60 fps
}

ipcMain.on('session-state',    (_e, active: boolean) => {
  if (active) console.log('[Clickify] Session active');
});

ipcMain.on('mic-selected', (_e, deviceId: string) => {
  console.log('[Clickify Main] Microphone selected:', deviceId);
  overlayWindow?.webContents.send('mic-changed', deviceId);
});

ipcMain.handle('settings:get', () => {
  const m = readMergedEnv();
  return {
    cartesia: m.CARTESIA_API_KEY ?? '',
    openrouter: m.OPENROUTER_API_KEY ?? '',
    gemini: m.GEMINI_API_KEY ?? '',
    llmProvider: (m.LLM_PROVIDER ?? 'openrouter').toLowerCase() === 'gemini' ? 'gemini' : 'openrouter',
  };
});

ipcMain.handle(
  'settings:save',
  async (_e, data: { cartesia: string; openrouter: string; gemini: string; llmProvider: string }) => {
    const llm = data.llmProvider === 'gemini' ? 'gemini' : 'openrouter';
    const body =
      `LLM_PROVIDER=${llm}\n` +
      `CARTESIA_API_KEY=${data.cartesia.trim()}\n` +
      `OPENROUTER_API_KEY=${data.openrouter.trim()}\n` +
      `GEMINI_API_KEY=${data.gemini.trim()}\n`;
    fs.mkdirSync(path.dirname(userEnvPath()), { recursive: true });
    fs.writeFileSync(userEnvPath(), body, 'utf8');
    loadEnvFiles();
    return { ok: true };
  }
);

// ─── Window creation ──────────────────────────────────────────────────────────

function createOverlay() {
  overlayWindow = new BrowserWindow({
    width: 48, height: 48,
    x: 100, y: 100,
    transparent: true, frame: false, alwaysOnTop: true,
    skipTaskbar: true, resizable: false, movable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Always ignore mouse events — the icon follows the cursor, clicks pass through
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.webContents.on('console-message', (_e, level, message) => {
    console.log('[Clickify Overlay]', message);
  });
  overlayWindow.webContents.on('did-finish-load', () => {
    console.log('[Clickify] Overlay window loaded');
  });
  overlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  overlayWindow.on('close', (e) => { e.preventDefault(); });
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, cb) => cb(true));
  startCursorFollow();
}

// ─── System Tray ─────────────────────────────────────────────────────────────

function rebuildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Clickify — AI Screen Assistant', enabled: false },
    { type: 'separator' },
    { label: '🎙️ Talk to Clickify (Ctrl+Shift+Space or F9)', click: () => overlayWindow?.webContents.send('ptt-toggle') },
    { label: 'Show cursor icon', click: () => overlayWindow?.show() },
    { label: 'Settings & Microphone…', click: () => createSettingsWindow() },
    { type: 'separator' },
    {
      label:   'Launch on startup',
      type:    'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); rebuildTrayMenu(); },
    },
    { type: 'separator' },
    { label: 'Quit Clickify', click: () => app.exit(0) },
  ]));
}

function createTray() {
  tray = new Tray(loadAppIcon());
  tray.setToolTip('Clickify — AI Screen Assistant\nCtrl+Shift+Space or F9 to talk');
  tray.on('click', () => overlayWindow?.show());
  rebuildTrayMenu();
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width:  520,
    height: 600,
    minWidth: 480,
    minHeight: 440,
    title:  'Clickify — API keys',
    icon:   loadAppIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  settingsWindow.webContents.on('console-message', (_e, level, message) => {
    console.log('[Clickify Settings]', message);
  });
  settingsWindow.loadFile(path.join(__dirname, '../renderer/settings.html'));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

// ─── IPC: Screenshot ──────────────────────────────────────────────────────────

ipcMain.handle('capture-screenshot', async () => {
  const win = overlayWindow;
  if (!win || win.isDestroyed()) return null;

  // Never use hide(): it throttles/suspends the renderer and can freeze Web Audio,
  // which breaks voice (VAD) until restart. Opacity keeps the window "visible" for Chromium.
  let prevOpacity = 1;
  try {
    prevOpacity = win.getOpacity();
    win.setOpacity(0);
    await delay(80);
    const sources = await desktopCapturer.getSources({
      types: ['screen'], thumbnailSize: { width: 960, height: 540 },
    });
    const primaryId = screen.getPrimaryDisplay().id.toString();
    const primary   = sources.find((s) => s.display_id === primaryId) ?? sources[0];
    if (primary && !primary.thumbnail.isEmpty()) {
      const dataUrl = primary.thumbnail.toDataURL();
      if (dataUrl.length > 100) return dataUrl;
    }
    return null;
  } catch (err) {
    console.error('Screenshot failed:', err);
    return null;
  } finally {
    const w = overlayWindow;
    if (w && !w.isDestroyed()) {
      w.setOpacity(prevOpacity);
      w.show();
      w.webContents.send('audio-resume');
    }
  }
});

// ─── IPC: Transcribe Audio ────────────────────────────────────────────────────

ipcMain.handle('transcribe-audio', async (_e, audioBuffer: ArrayBuffer) => {
  try {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) throw new Error('CARTESIA_API_KEY not set');
    const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    console.log('[Clickify STT] Received audio buffer:', buf.length, 'bytes');
    if (buf.length < 500) {
      console.warn('[Clickify STT] Audio buffer too small, ignoring');
      return null;
    }
    const { contentType, body } = buildMultipart(
      { model: 'ink-whisper' },
      'file', 'audio.webm', buf, 'audio/webm'
    );
    const res = await nodePost(
      'https://api.cartesia.ai/stt',
      {
        'X-API-Key': key,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': contentType,
      },
      body
    );
    console.log('[Clickify STT] Response status:', res.status);
    if (res.status >= 400) throw new Error(`Cartesia STT ${res.status}: ${res.text}`);
    const data = JSON.parse(res.text) as { text?: string; language?: string };
    const transcript = data.text?.trim() ?? null;
    console.log('[Clickify STT] Transcript:', transcript, 'language:', data.language);
    if (!transcript) return null;
    return { transcript, language: data.language ?? 'en-IN' };
  } catch (err) {
    console.error('[Clickify STT] Transcription failed:', err);
    return null;
  }
});

// ─── IPC: Ask AI (with conversation history) ──────────────────────────────────

function buildSystemPrompt(langName: string): string {
  return `You are Clickify — a real-time AI screen assistant that guides users step-by-step.

RESPONSE FORMAT — return ONLY a valid JSON object, no markdown, no code fences:
{"steps":[{"speak":"instruction"},{"speak":"next instruction"}]}

Rules:
- "steps" is an ORDERED array of 1–5 sequential spoken instructions to complete the task.
- "speak": instruction in ${langName} (1–2 natural sentences, TTS-friendly, no symbols). Describe what to do on screen in words; do not output coordinates.
- Use conversation history for context if the user is following up.
- Guide the user through the COMPLETE task — each step leads to the next.
- Respond ONLY in ${langName}. Be direct. No filler words.`;
}

ipcMain.handle(
  'ask-ai',
  async (_e, { transcript, screenshot, language }:
    { transcript: string; screenshot: string; language: string }
  ): Promise<Step[] | null> => {
    try {
      console.log('[Clickify AI] Processing user query:', transcript);
      const prompt   = buildSystemPrompt(LANG_NAMES[language] ?? 'English');
      const provider = (process.env.LLM_PROVIDER ?? 'openrouter').toLowerCase();
      const raw      = provider === 'gemini'
        ? await callGemini(prompt, transcript, screenshot)
        : await callOpenRouter(prompt, transcript, screenshot);

      let cleanRaw = raw.trim();
      if (cleanRaw.startsWith('```')) {
        cleanRaw = cleanRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      }
      const parsed = JSON.parse(cleanRaw) as {
        steps?: Step[];
        speak?: string;
      };

      let steps: Step[] | null = null;
      if (Array.isArray(parsed.steps) && parsed.steps.length > 0) {
        steps = parsed.steps.map((s) => ({ speak: String(s.speak ?? '') })).filter((s) => s.speak.length);
      }
      if (!steps?.length && parsed.speak) steps = [{ speak: parsed.speak }];
      if (!steps?.length) steps = null;

      if (steps) {
        console.log('[Clickify AI] Returning', steps.length, 'step(s):', steps.map(s => s.speak).join(' | '));
        pushHistory(transcript, steps.map(s => s.speak).join(' '));
      } else {
        console.warn('[Clickify AI] Unexpected AI response shape — dropping');
      }

      return steps;
    } catch (err) {
      console.error('[Clickify AI] AI request failed:', err);
      return null;
    }
  }
);

// ─── IPC: Text-to-Speech ──────────────────────────────────────────────────────

ipcMain.handle('text-to-speech', async (_e, text: string, language = 'en-IN') => {
  try {
    const key = process.env.CARTESIA_API_KEY;
    if (!key) throw new Error('CARTESIA_API_KEY not set');
    const lang = LANG_CARTESIA[language] ?? 'en';
    const voiceId = process.env.CARTESIA_VOICE_ID || '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc';
    console.log('[Clickify TTS] Synthesizing speech:', text, `(lang: ${lang})`);
    const body = Buffer.from(JSON.stringify({
      model_id: 'sonic-3.6',
      transcript: text,
      voice: {
        mode: 'id',
        id: voiceId,
      },
      output_format: {
        container: 'wav',
        encoding: 'pcm_s16le',
        sample_rate: 22050,
      },
      language: lang,
    }));
    const res = await nodePost(
      'https://api.cartesia.ai/tts/bytes',
      {
        'X-API-Key': key,
        'Cartesia-Version': '2024-06-10',
        'Content-Type': 'application/json',
      },
      body
    );
    if (res.status >= 400) throw new Error(`Cartesia TTS ${res.status}: ${res.text}`);
    console.log('[Clickify TTS] Speech synthesized successfully, bytes:', res.buffer.length);
    return res.buffer.toString('base64');
  } catch (err) {
    console.error('[Clickify TTS] TTS failed:', err);
    return null;
  }
});

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // No File / Edit / View menu — keeps windows (e.g. API keys) minimal.
  Menu.setApplicationMenu(null);

  loadEnvFiles();

  const provider = (process.env.LLM_PROVIDER ?? 'openrouter').toLowerCase();
  if (provider === 'gemini'     && !process.env.GEMINI_API_KEY)     console.warn('[Clickify] GEMINI_API_KEY missing');
  if (provider === 'openrouter' && !process.env.OPENROUTER_API_KEY) console.warn('[Clickify] OPENROUTER_API_KEY missing');
  if (!process.env.CARTESIA_API_KEY) console.warn('[Clickify] CARTESIA_API_KEY missing');

  createOverlay();
  createTray();
  createSettingsWindow();

  console.log('[Clickify] App started successfully.');
  console.log('[Clickify] LLM Provider:', provider);
  console.log('[Clickify] Cartesia API Key configured:', Boolean(process.env.CARTESIA_API_KEY));
  console.log('[Clickify] OpenRouter API Key configured:', Boolean(process.env.OPENROUTER_API_KEY));
  console.log('[Clickify] Hotkeys: Press Ctrl+Shift+Space or F9 to talk.');

  // Push-to-talk toggles: Ctrl+Shift+Space and F9
  const regCtrl = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    console.log('[Clickify Hotkey] Ctrl+Shift+Space pressed');
    overlayWindow?.webContents.send('ptt-toggle');
  });
  const regF9 = globalShortcut.register('F9', () => {
    console.log('[Clickify Hotkey] F9 pressed');
    overlayWindow?.webContents.send('ptt-toggle');
  });
  console.log(`[Clickify] Hotkey registration: Ctrl+Shift+Space: ${regCtrl ? 'OK' : 'FAILED'}, F9: ${regF9 ? 'OK' : 'FAILED'}`);
});

app.on('window-all-closed', () => { /* tray keeps the app alive */ });
app.on('will-quit',         () => globalShortcut.unregisterAll());

// ─── Helpers ──────────────────────────────────────────────────────────────────

function delay(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
