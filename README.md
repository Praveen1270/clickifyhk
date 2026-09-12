# Clickify 🎯

> Real-time voice AI assistant that lives on your Windows screen and follows your mouse. Speak, ask questions about what's currently on your display, and receive spoken step-by-step guidance.

[![GitHub Release](https://img.shields.io/github/v/release/Praveen1270/clickifyhk?include_prereleases&style=flat-square)](https://github.com/Praveen1270/clickifyhk/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue.svg?style=flat-square)](https://github.com/Praveen1270/clickifyhk)

---

## ✨ Features

- **Screen-Aware Vision**: Captures your screen and analyzes the active window or region to answer contextual questions about what you're doing.
- **Natural Voice Interaction**: High-quality speech-to-text and low-latency voice responses powered by **Cartesia** (`ink-whisper` and `sonic-3.6`).
- **Advanced Multimodal Intelligence**: Vision reasoning with **OpenRouter** (`google/gemini-2.5-flash`) or direct **Google Gemini** (`gemini-2.0-flash`).
- **Interactive Cursor Companion**: Lightweight transparent overlay that follows your mouse cursor or docks unobtrusively.
- **Audio & Hardware Control**: Built-in microphone selector and live volume meter in settings to test and optimize your audio input.
- **Multilingual Support**: Supports Indian and global languages including English (`en-IN`), Hindi (`hi-IN`), and Telugu (`te-IN`).
- **Secure Key Storage**: API keys are stored locally on your device in `%APPDATA%\Clickify\clickify.env` — never sent to third-party servers.

---

## 🚀 Getting Started

### 1. Download & Install (Windows)

1. Head to the **[Latest Release](https://github.com/Praveen1270/clickifyhk/releases/latest)**.
2. Download and run **`Clickify Setup … .exe`**.
3. Launch **Clickify** from your Start menu or Desktop shortcut.

### 2. Configure API Keys

On first launch, Clickify will prompt you to configure your API keys. You can also right-click the **System Tray icon → Settings / API keys…** at any time.

| Service | Provider | Purpose |
| :--- | :--- | :--- |
| **Cartesia** | [cartesia.ai](https://cartesia.ai) | Voice synthesis (TTS) & speech recognition (STT) |
| **OpenRouter** *(Default)* | [openrouter.ai](https://openrouter.ai) | Vision & multimodal reasoning (`gemini-2.5-flash`) |
| **Google Gemini** *(Alternative)* | [aistudio.google.com](https://aistudio.google.com) | Direct Google Gemini 2.0 Flash vision |

---

## 🎮 How to Use

| Action | Shortcut / Trigger | Description |
| :--- | :--- | :--- |
| **Push-to-Talk** | `Ctrl + Shift + Space` | Hold to speak; release when you're done |
| **Voice Activity** | Continuous Mic Detection | Automatically begins listening when you speak |
| **Interrupt Playback** | Say *"Stop"* or *"Cancel"* | Instantly stops speech response (works in English, Hindi, and Telugu) |
| **System Tray** | Right-click tray icon | Access Settings, toggle overlay, configure auto-start, or exit |

> **Pro Tip:** Ask direct questions about what you see on your monitor (e.g., *"How do I export this layer?"*, *"Why is this code failing?"*, or *"Summarize this document"*). Clickify takes an instant snapshot of your display when you ask.

---

## 🛠️ Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+ recommended)
- Windows 10/11 (x64)

### Clone & Install

```bash
git clone https://github.com/Praveen1270/clickifyhk.git
cd clickifyhk
npm install
```

### Local Environment Configuration

Copy the sample environment file:

```bash
cp .env.example .env
```

Set your keys in `.env`:
```env
CARTESIA_API_KEY=your-cartesia-key-here
OPENROUTER_API_KEY=sk-or-v1-...your-key-here
GEMINI_API_KEY=your-gemini-key-here
LLM_PROVIDER=openrouter
```

### Run Locally

```bash
npm start
```

### Build Executable & Installer

To package the standalone Windows installer into the `release/` directory:

```bash
npm run package
```

---

## 📂 Project Architecture

```
clickifyhk/
├── .github/
│   └── workflows/
│       └── release-windows.yml  # Automated CI release builder
├── assets/
│   └── icon.png                 # Application and tray icons
├── src/
│   ├── main/
│   │   └── index.ts             # Main process: tray, IPC, shortcuts, window manager
│   ├── preload/
│   │   └── index.ts             # Secure contextBridge API bindings
│   └── renderer/
│       ├── index.html           # Screen overlay companion UI
│       ├── renderer.ts          # Cursor tracking, audio VAD, speech pipeline
│       ├── hint.html            # Step-by-step hint bubble
│       ├── settings.html        # Settings panel & live mic meter
│       └── settings.ts          # Settings controller & device enumeration
├── tsconfig.json                # TypeScript compiler configuration
└── package.json                 # Project dependencies & build scripts
```

---

## 🚢 Publishing a Release

GitHub Actions automatically builds the Windows installer and publishes a GitHub Release whenever you push a version tag:

```bash
git tag v0.1.2
git push origin v0.1.2
```

You can view builds and download installers under [GitHub Releases](https://github.com/Praveen1270/clickifyhk/releases).
