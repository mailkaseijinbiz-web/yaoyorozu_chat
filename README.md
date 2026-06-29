# YAOYOROZU CHAT

> **Every Object Has a Spirit Inside.**

🏮 Inspired by **八百万の神 (yaoyorozu no kami)** — the Japanese belief that a deity dwells in every single thing — YAOYOROZU CHAT lets you point your phone at any object and summon the spirit living inside it.

**▶ Demo video**: https://www.youtube.com/watch?v=2xwxesu1jKQ  
**🚀 Live demo**: https://yaoyorozu-chat.vercel.app/lp  
**💻 GitHub**: https://github.com/mailkaseijinbiz-web/yaoyorozu_chat

[![YAOYOROZU CHAT — Demo](https://img.youtube.com/vi/2xwxesu1jKQ/hqdefault.jpg)](https://www.youtube.com/watch?v=2xwxesu1jKQ)

---

## About

- 🏮 **Inspired by 八百万の神 (yaoyorozu no kami)** — the Japanese belief that a deity dwells in every single thing
- 📷 **Just point your phone** — scan any object and a spirit with its own name, personality, and voice appears anchored in your space, bantering aloud and speaking when you tap it
- ⚡ **Powered by Cerebras (Gemma 4 31B)** — sub-second responses cross the line where AR starts to feel truly alive
- 🤍 **Makes you kinder** — the more you live alongside objects that talk back, the more gently you treat the world; the real heart of the project

---

## How It Works

| Step | Description |
|---|---|
| **1. Scan** | Tap the screen to scan any object. AI identifies it and generates a unique spirit — name, personality, and voice — in seconds. |
| **2. Meet** | A glowing ring marks the spirit's vessel. Point your camera at the object again to anchor it in AR space. |
| **3. Talk** | Switch to Talk mode. Spirits start bantering automatically — speech bubbles and TTS voices included. Tap a spirit to make it speak. |

Spirits spotted in frame automatically trigger Talk mode after 5 seconds. When all spirits leave the frame, the app returns to Scan mode after 3 seconds.

---

## Features

- **⚡ Cerebras ultra-fast inference** — Spirit generation < 1 sec, banter response < 800 ms (~7× faster than OpenRouter on standard GPUs — same Gemma 4 31B model, only the inference provider changes)
- **🔀 Model switching** — Toggle between Cerebras (ultra-fast) and OpenRouter (standard) with one tap
- **📸 Markerless AR** — MindAR image tracking. No printed markers needed — scan anything
- **🗣️ TTS voices** — ElevenLabs high-quality cloud voices or on-device Web Speech API
- **💬 Banter system** — Spirits trade comedy-duo-style lines and remember past conversations across sessions
- **🌍 Multilingual** — Spirit names and dialogue generated in Japanese, English, Korean, and more
- **📱 PWA** — Add to home screen for a fullscreen experience
- **🎨 Custom banter style** — Add your own prompt instruction in Settings to shape how spirits speak

---

## Setup

```bash
git clone https://github.com/mailkaseijinbiz-web/yaoyorozu_chat.git
cd yaoyorozu_chat
npm install
cp .env.example .env   # add your API keys
npm start
```

Open http://localhost:3000 on your phone (HTTPS required for camera — see below).

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `CEREBRAS_API_KEY` | Recommended | Cerebras inference (ultra-fast mode) |
| `OPENROUTER_API_KEY` | Recommended | OpenRouter — Gemma 4 31B |
| `ELEVENLABS_API_KEY` | Optional | High-quality TTS (falls back to on-device voices) |

If no keys are set, the app runs in **demo mode** with fixed spirits and placeholder dialogue.

### Testing on a phone locally

Camera requires HTTPS. Use a tunnel:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

---

## Project structure

```
.
├── server.js           # Express API server
│   ├── POST /api/scan  # Object recognition & spirit generation (Gemma 4 via Cerebras/OpenRouter)
│   ├── POST /api/banter# Spirit banter generation
│   └── POST /api/tts   # ElevenLabs voice synthesis
├── public/
│   ├── app.js          # Frontend core (scan → AR → banter loop)
│   ├── index.html      # A-Frame 1.5.0 + MindAR 1.2.5
│   ├── style.css
│   ├── sw.js           # Service Worker (PWA / offline)
│   ├── libs/
│   │   └── mindar-image-aframe.prod.js  # Self-hosted MindAR bundle
│   └── lp/             # Landing page
├── api/
│   └── index.js        # Vercel serverless entry point
└── vercel.json         # Vercel config (/api/* → Express, static → public/)
```

---

## Deploy

Pushing to `main` triggers an automatic Vercel deployment.

```bash
vercel deploy --prod
```

---

## Tech stack

| Category | Technology |
|---|---|
| AR | MindAR 1.2.5 + A-Frame 1.5.0 |
| AI inference | Cerebras (Gemma 4 31B) / OpenRouter (Gemma 4 31B) |
| TTS | ElevenLabs / Web Speech API |
| Frontend | Vanilla JS + CSS Custom Properties |
| Backend | Node.js + Express |
| Hosting | Vercel (Serverless) |
