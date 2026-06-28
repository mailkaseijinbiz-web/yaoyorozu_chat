const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');

dotenv.config({ override: true });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==========================================
// 通信ログ: PCコンソール＋ webview (/logs) でライブ表示できるようにする
// ==========================================
function ts() {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
const LOG_MAX = 500;
const logBuffer = [];          // 直近のログ行(リングバッファ)
const logClients = new Set();  // /logs を開いているSSE接続
function pushLog(line) {
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  for (const res of logClients) {
    try { res.write(`data: ${line.replace(/\n/g, ' ')}\n\n`); } catch (e) {}
  }
}

// ログ自身のエンドポイントは記録しない(ノイズ/無限化防止)
function isLogPath(p) {
  return p === '/api/clientlog' || p.indexOf('/api/logs') === 0;
}

// サーバーが受けた全APIリクエストを method/path/status/所要時間 でログ
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || isLogPath(req.path)) return next();
  const start = Date.now();
  res.on('finish', () => {
    pushLog(`[NET ${ts()}] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// クライアント(スマホ)側のfetchイベント/エラーを受けてログへ流す
app.post('/api/clientlog', (req, res) => {
  const line = req.body && typeof req.body.line === 'string' ? req.body.line : '';
  if (line) pushLog(`[CLIENT ${ts()}] ${line.slice(0, 500)}`);
  res.json({ ok: true });
});

// 直近ログのJSON(ポーリング用フォールバック)
app.get('/api/logs', (req, res) => res.json({ logs: logBuffer }));

// ライブ配信 (Server-Sent Events)
app.get('/api/logs/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  if (res.flushHeaders) res.flushHeaders();
  res.write('retry: 3000\n\n');
  logBuffer.forEach((l) => res.write(`data: ${l}\n\n`));   // 既存分を先に送る
  logClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
  req.on('close', () => { clearInterval(ping); logClients.delete(res); });
});

// ログ閲覧ページ (webview)
app.get('/logs', (req, res) => {
  res.type('html').send(LOG_PAGE_HTML);
});

const LOG_PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>Comm Log</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html, body { margin: 0; min-height: 100%; background: #0b0f19; color: #d7dce5;
    font-family: ui-sans-serif, -apple-system, Segoe UI, Roboto, sans-serif; }
  .mono { font-family: 'SF Mono', ui-monospace, Menlo, Consolas, monospace; }

  header { position: sticky; top: 0; z-index: 5; background: rgba(11,15,25,.97); border-bottom: 1px solid #1e2636; }
  .top { display: flex; align-items: center; gap: 8px; padding: 9px 12px; }
  .top b { font-size: 14px; font-weight: 600; color: #fff; }
  #dot { width: 9px; height: 9px; border-radius: 50%; background: #f85149; flex: none; box-shadow: 0 0 6px #f85149; }
  #dot.live { background: #3fb950; box-shadow: 0 0 6px #3fb950; }
  .sp { flex: 1; }
  .stat { font-size: 12px; color: #8b95a7; }
  .stat .e { color: #f85149; }

  .ctrl { display: flex; gap: 6px; padding: 0 12px 9px; flex-wrap: wrap; align-items: center; }
  button { font: inherit; font-size: 12px; color: #cbd3e1; background: #182033; border: 1px solid #2a3550;
    border-radius: 999px; padding: 5px 12px; cursor: pointer; }
  button.on { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  input#q { flex: 1; min-width: 120px; font: inherit; font-size: 12px; color: #d7dce5; background: #0e1422;
    border: 1px solid #2a3550; border-radius: 999px; padding: 6px 12px; outline: none; }
  input#q::placeholder { color: #5b667c; }

  #log { padding: 4px 0 60px; }
  .row { display: grid; grid-template-columns: 70px 58px auto 1fr auto auto; gap: 8px; align-items: baseline;
    padding: 6px 12px; border-bottom: 1px solid #121a28; font-size: 12.5px; }
  .row:hover { background: #0e1422; }
  .time { color: #5f6b80; font-size: 11px; }
  .badge { justify-self: start; font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 2px 7px;
    border-radius: 999px; text-transform: uppercase; }
  .b-net { background: #10263f; color: #79c0ff; } .b-client { background: #3a2412; color: #f0a35e; }
  .method { color: #8b95a7; font-size: 11px; font-weight: 600; }
  .path { color: #c9d1e0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path.seg { color: #56d4c4; } .path.ban { color: #c08bff; } .path.tts { color: #ff8bce; } .path.blob { color: #76808f; }
  .status { justify-self: end; font-weight: 700; font-size: 12px; min-width: 34px; text-align: right; }
  .s-ok { color: #3fb950; } .s-redir { color: #79c0ff; } .s-warn { color: #d29922; } .s-err { color: #f85149; }
  .ms { justify-self: end; color: #7d8799; min-width: 56px; text-align: right; }
  .ms.m1 { color: #d29922; } .ms.m2 { color: #f0883e; } .ms.m3 { color: #f85149; font-weight: 600; }
  .raw { grid-column: 1 / -1; color: #9aa4b6; }
  .hide { display: none !important; }
  #empty { color: #5f6b80; padding: 18px 12px; }
</style></head>
<body>
  <header>
    <div class="top">
      <span id="dot"></span><b>Comm Log</b>
      <span class="sp"></span>
      <span class="stat"><span id="count">0</span> · <span class="e" id="errc">0</span> err</span>
    </div>
    <div class="ctrl">
      <button class="filt on" data-f="all">All</button>
      <button class="filt" data-f="net">NET</button>
      <button class="filt" data-f="client">CLIENT</button>
      <button class="filt" data-f="err">Errors</button>
      <input id="q" placeholder="filter path…" />
      <button id="auto" class="on">Auto-scroll</button>
      <button id="clear">Clear</button>
    </div>
  </header>
  <div id="log"><div id="empty">Waiting for traffic… open the app and interact.</div></div>
<script>
  var logEl = document.getElementById('log');
  var emptyEl = document.getElementById('empty');
  var countEl = document.getElementById('count');
  var errEl = document.getElementById('errc');
  var dot = document.getElementById('dot');
  var autoBtn = document.getElementById('auto');
  var qEl = document.getElementById('q');
  var auto = true, n = 0, errs = 0, filter = 'all', q = '';
  var MAXROWS = 1000;

  autoBtn.onclick = function () { auto = !auto; autoBtn.classList.toggle('on', auto); if (auto) scrollEnd(); };
  document.getElementById('clear').onclick = function () {
    logEl.innerHTML = ''; n = 0; errs = 0; countEl.textContent = '0'; errEl.textContent = '0';
  };
  var filtBtns = document.querySelectorAll('.filt');
  for (var i = 0; i < filtBtns.length; i++) filtBtns[i].onclick = function () {
    filter = this.getAttribute('data-f');
    for (var j = 0; j < filtBtns.length; j++) filtBtns[j].classList.toggle('on', filtBtns[j] === this);
    applyAll();
  };
  qEl.oninput = function () { q = this.value.toLowerCase(); applyAll(); };

  function scrollEnd() { window.scrollTo(0, document.body.scrollHeight); }
  function matches(row) {
    if (filter === 'net' && row.dataset.src !== 'net') return false;
    if (filter === 'client' && row.dataset.src !== 'client') return false;
    if (filter === 'err' && row.dataset.err !== '1') return false;
    if (q && row.dataset.path.indexOf(q) === -1) return false;
    return true;
  }
  function applyAll() {
    var rows = logEl.children;
    for (var i = 0; i < rows.length; i++) rows[i].classList.toggle('hide', !matches(rows[i]));
  }

  function statusClass(s) {
    if (/^ERR/.test(s)) return 's-err';
    var c = parseInt(s, 10);
    if (c >= 500 || isNaN(c)) return 's-err';
    if (c >= 400) return 's-warn';
    if (c >= 300) return 's-redir';
    return 's-ok';
  }
  function msClass(ms) { return ms >= 5000 ? 'm3' : ms >= 2000 ? 'm2' : ms >= 800 ? 'm1' : ''; }
  function pathClass(p) {
    if (p.indexOf('segment') !== -1) return 'seg';
    if (p.indexOf('banter') !== -1) return 'ban';
    if (p.indexOf('tts') !== -1) return 'tts';
    if (p.indexOf('blob:') === 0) return 'blob';
    return '';
  }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }

  function add(line) {
    if (emptyEl) { emptyEl.remove(); emptyEl = null; }
    var m = line.match(/^\\[(NET|CLIENT) ([0-9:.]+)\\] (\\S+) (\\S+) -> (.+) ([0-9]+)ms$/);
    var row = el('div', 'row');
    if (!m) {
      row.appendChild(el('span', 'raw mono', line));
      row.dataset.src = 'net'; row.dataset.path = line.toLowerCase(); row.dataset.err = '0';
    } else {
      var src = m[1].toLowerCase(), time = m[2], method = m[3], path = m[4], status = m[5], ms = parseInt(m[6], 10);
      var isErr = /^ERR/.test(status) || parseInt(status, 10) >= 400;
      row.dataset.src = src; row.dataset.path = path.toLowerCase(); row.dataset.err = isErr ? '1' : '0';
      row.appendChild(el('span', 'time mono', time));
      row.appendChild(el('span', 'badge ' + (src === 'net' ? 'b-net' : 'b-client'), src));
      row.appendChild(el('span', 'method', method));
      var p = el('span', 'path mono ' + pathClass(path), path); p.title = path; row.appendChild(p);
      row.appendChild(el('span', 'status ' + statusClass(status), status));
      row.appendChild(el('span', 'ms mono ' + msClass(ms), ms + 'ms'));
      if (isErr) errs++;
    }
    row.classList.toggle('hide', !matches(row));
    logEl.appendChild(row);
    while (logEl.children.length > MAXROWS) logEl.removeChild(logEl.firstChild);
    n++; countEl.textContent = String(n); errEl.textContent = String(errs);
    if (auto) scrollEnd();
  }
  function connect() {
    var es = new EventSource('/api/logs/stream');
    es.onopen = function () { dot.classList.add('live'); };
    es.onmessage = function (e) { add(e.data); };
    es.onerror = function () { dot.classList.remove('live'); };
  }
  connect();
</script>
</body></html>`;

// ==========================================
// 言語設定 (English基準＋日本語含む6言語)
// ==========================================
const LANG_NAMES = { en: 'English', ja: 'Japanese', zh: 'Simplified Chinese', ko: 'Korean', es: 'Spanish', fr: 'French' };
function langName(code) { return LANG_NAMES[code] || 'English'; }

// ==========================================
// Cerebras 直接API
// ==========================================
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = 'gemma-4-31b';
const hasCerebrasKey = !!process.env.CEREBRAS_API_KEY;

// OpenRouter (OpenAI互換API) — フォールバック / OpenRouterプリセット用
// ==========================================
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const OPENROUTER_PROVIDERS = (process.env.OPENROUTER_PROVIDER || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const OPENROUTER_ALLOW_FALLBACKS = process.env.OPENROUTER_ALLOW_FALLBACKS !== 'false';

const hasApiKey = !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here';

if (!hasApiKey && !hasCerebrasKey) {
  console.warn('No API key set — starting in DEMO mode (fixed responses).');
}

// Cerebras 直接呼び出し (OpenAI互換)
async function callCerebras({ messages, temperature }) {
  const response = await fetch(CEREBRAS_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CEREBRAS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CEREBRAS_MODEL,
      messages,
      ...(temperature != null ? { temperature } : {})
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cerebras API failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error(`Cerebras returned no text content: ${JSON.stringify(data)}`);
  }
  pushLog(`[LLM ${ts()}] ${CEREBRAS_MODEL} via Cerebras (direct)`);
  return text;
}

// OpenRouter 呼び出し (gemma4プリセット / segment-vessels用)
async function callOpenRouter({ messages, temperature }) {
  const model = 'google/gemma-4-31b-it';

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/yaorozu-chat',
      'X-Title': 'Yaorozu Chat'
    },
    body: JSON.stringify({
      model,
      messages,
      ...(temperature != null ? { temperature } : {}),
      ...(OPENROUTER_PROVIDERS.length ? { provider: { order: OPENROUTER_PROVIDERS, allow_fallbacks: OPENROUTER_ALLOW_FALLBACKS } } : {})
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw new Error(`OpenRouter returned no text content: ${JSON.stringify(data)}`);
  }
  if (data && data.provider) pushLog(`[LLM ${ts()}] ${model} via ${data.provider}`);
  return text;
}

// プリセットに応じてCerebras直接 or OpenRouterに振り分け
async function callLLM({ messages, temperature, modelPreset }) {
  if (modelPreset === 'cerebras' && hasCerebrasKey) {
    return callCerebras({ messages, temperature });
  }
  return callOpenRouter({ messages, temperature });
}

function parseJSONSafe(text) {
  let trimmed = text.trim();
  // Strip markdown code fences (```json ... ```)
  trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(trimmed.substring(start, end + 1));
    }
    throw e;
  }
}

// ==========================================
// 物体検出 + 動的精霊名 + キャラ付け (スキャン)
// ==========================================

const DEMO_VESSELS = [
  { name: 'Demo Blue Vessel', spiritName: 'Spirit of Drinks', personality: 'Drained dry and philosophical. Calls itself "I". Laid-back, weary tone.', voice: 'cool_male' },
  { name: 'Demo Red Vessel', spiritName: 'Spirit of Time', personality: 'Meticulous and impatient. Calls itself "I". Formal, declarative speech.', voice: 'wise_elder' },
  { name: 'Demo Yellow Vessel', spiritName: 'Spirit of Sweets', personality: 'Clingy and hyperactive. Calls itself "I". Bubbly, excitable tone.', voice: 'genki_girl' }
];
let demoSegmentCount = 0;

app.post('/api/segment-vessels', async (req, res) => {
  const { image, language } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'Image data is required' });
  }

  // 空/極小の画像（例: 0x0キャンバスの "data:," ）は弾く。
  // これを通すとAIに無効データを投げてエラーとクォータを浪費し、デモモードでは幻の検出が出る。
  const base64Data = image.split(',')[1] || image;
  if (!base64Data || base64Data.length < 100) {
    return res.status(400).json({ error: 'Image data is empty or too small' });
  }

  if (!hasApiKey) {
    const demo = DEMO_VESSELS[demoSegmentCount];
    demoSegmentCount = (demoSegmentCount + 1) % DEMO_VESSELS.length;
    return res.json({
      demo: true,
      targets: [{ ...demo, box: [200, 200, 800, 800] }]
    });
  }

  try {
    const dataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${base64Data}`;
    const prompt = `From the image, detect up to 3 objects that are well suited as AR targets (a logo, a label, or a prominent physical object). List all suitable objects; if there are none, return an empty array.
Give each object's bounding box as [ymin, xmin, ymax, xmax] (integers normalized to 0-1000, with the top-left corner at [0,0]).

Output ONLY the following JSON structure (no preamble, no explanation, no code fences):
{
  "targets": [
    {
      "name": "Short English name of the object (max 25 chars), e.g. 'blue empty can', 'alarm clock'",
      "spiritName": "A spirit name in the form 'Spirit of ___' (max 20 chars). e.g. clock -> Spirit of Time, can/bottle -> Spirit of Drinks, book/notebook -> Spirit of Wisdom, cup/glass -> Spirit of the Vessel, keyboard -> Spirit of Typing. For objects not listed, invent a name that captures the object's essence.",
      "personality": "A character profile inspired by the object's look, use, and state (dirty/empty/brand-new, etc.): personality, manner of speech, and how it refers to itself (max 100 chars)",
      "voice": "Exactly one of cool_male | genki_girl | wise_elder | gentle_lady. cool_male=cool male voice (gadgets, black/sporty items), genki_girl=upbeat anime girl voice (sweets, cute/colorful items), wise_elder=gravelly elder voice (books, clocks, antiques), gentle_lady=soft gentle female voice (mugs, plush toys, plants)",
      "box": [ymin, xmin, ymax, xmax]
    }
  ]
}
If there are no suitable objects, set "targets" to an empty array.${language && language !== 'en' ? `\nIMPORTANT: Write "name", "spiritName" and "personality" in ${langName(language)} (use that language's native script). Keep "voice" and "box" exactly as specified.` : ''}`;

    const text = await callOpenRouter({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ]
    });

    const data = parseJSONSafe(text);
    console.log('Detected:', JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error('Error segmenting image:', error.message);
    res.status(500).json({ error: 'Failed to segment image' });
  }
});

// ==========================================
// 精霊同士のBanter (N体対応)
// ==========================================

function buildSoloPrompt(spirit, turnCount, situation) {
  const s = spirit;
  const sitText = situation
    ? `Current situation:\n- Place: ${situation.location || 'in a room'}\n- Weather / time: ${situation.weather || 'clear skies'}`
    : '';
  return `You write short, funny solo lines (a monologue) for a single spirit that inhabits an everyday object. It talks to itself and to whoever is watching.

The spirit:
- Spirit name: ${s.name || 'Spirit'}
- Vessel it inhabits: ${s.vessel || 'a mysterious vessel'}
- Character: ${s.personality || 'cheerful and talkative'}

${sitText}

Based on what it has already said, write its next line.

Rules:
1. Keep it short (1-2 sentences, max ~80 characters). Snappy and full of personality.
2. Be humorous — a witty quip, an observation about its vessel, or a grumble about the situation (place/weather).
3. Stay in character (personality, manner of speech, how it refers to itself).
4. Vary the topic line to line so it doesn't get repetitive. Talk to the viewer sometimes.
5. Set isEnd to true only occasionally, to wrap a little bit with a punchline; otherwise false.
6. Return JSON only — no preamble or explanation.`;
}

function buildBanterPrompt(spirits, newcomer, turnCount, situation, memory) {
  if (spirits.length === 1) return buildSoloPrompt(spirits[0], turnCount, situation);
  const cast = spirits.map((s, i) =>
    `[Spirit ${i} (agent${i})]
- Spirit name: ${s.name || `Spirit ${i}`}
- Vessel it inhabits: ${s.vessel || 'a mysterious vessel'}
- Character: ${s.personality || 'cheerful and talkative'}`
  ).join('\n\n');

  const sitText = situation
    ? `Current situation:\n- Place: ${situation.location || 'in a room'}\n- Weather / time: ${situation.weather || 'clear skies'}`
    : '';

  // ターン数に応じた起承転結フェーズの指定
  let phaseInstruction = "";
  if (turnCount <= 2) {
    phaseInstruction = "[Opening] This is the start of the conversation. Have the spirits introduce their vessels while weaving in references to the current situation (place and weather), kicking things off with plenty of humor.";
  } else if (turnCount <= 5) {
    phaseInstruction = "[Build-up] Develop the conversation. Find one topic centered on a 'shared trait (or contrast)' or the 'relationship' between their vessels, and use it to tease each other with comedy-duo-style banter (setup and punchline).";
  } else if (turnCount <= 8) {
    phaseInstruction = "[Turn] Accelerate the setups and punchlines even more, hitting the heart of the matter or an unexpected, hilarious joke to really get things going.";
  } else {
    phaseInstruction = "[Finale] This is the punchline that wraps up the conversation. Like the end of a comedy routine, land a humorous closing line and tie the conversation off cleanly (e.g. 'Alright, that's enough!', 'Oh, give it a rest!'). Since this line ends the conversation, set isEnd to true in the JSON.";
  }

  const memorySection = (memory && memory.length > 0)
    ? `\n[What these spirits said last time they met]\n${memory.map(h => `${h.name}: "${h.text}"`).join('\n')}\n(Past session — spirits may subtly reference or build on this. Don't repeat it verbatim.)\n`
    : '';

  return `You are a skilled comedy writer composing a snappy, comedy-duo-style back-and-forth between spirits that inhabit everyday objects.
The ${spirits.length} spirits on stage are:

${cast}
${newcomer ? `\n* "${newcomer}" has just joined the conversation! Have everyone welcome them or tease them.\n` : ''}
${memorySection}
${sitText}

Current conversation phase: ${phaseInstruction}

Based on the conversation so far, decide the next speaker (nextSpeaker), what they say (reply), a spoken-out version for TTS (ttsReply), and whether the conversation ends (isEnd).

Rules:
1. Keep every line short (1-2 sentences, max ~80 characters). Tempo first; no long-winded explanatory speech.
2. Be full of humor — a rapid exchange of setups and punchlines like a comedy duo.
3. Have the spirits playfully poke at the shared traits or themes of the vessels they inhabit.
4. Naturally weave in remarks or grumbles that fit the place and weather (the situation).
5. Be emotionally expressive! Use plenty of interjections and "!", "?", "..." to clearly convey mood and inflection.
6. Strictly stay in character for each spirit (personality, manner of speech, how it refers to itself).
7. Set isEnd to true ONLY on the final line that lands a punchline and wraps things up. Otherwise it must always be false.
8. Return JSON only — no preamble or explanation.`;
}

app.post('/api/banter', async (req, res) => {
  const { spirits, history, memory, newcomer, situation, forceSpeaker, language, modelPreset } = req.body;

  if (!spirits || !Array.isArray(spirits) || spirits.length < 1) {
    return res.status(400).json({ error: 'At least 1 spirit is required' });
  }

  const agentIds = spirits.map((_, i) => `agent${i}`);
  const turnCount = history ? history.length : 0;

  // forceSpeaker: タップで指定された話者(agentN)。有効なら必ずその精霊にしゃべらせる。
  const forcedIdx = (typeof forceSpeaker === 'string' && agentIds.includes(forceSpeaker))
    ? parseInt(forceSpeaker.replace('agent', ''), 10) : -1;

  if (!hasApiKey && !hasCerebrasKey) {
    const speaker = forcedIdx >= 0 ? forcedIdx : turnCount % spirits.length;
    let demoLines;
    if (spirits.length === 1) {
      // ソロ(1体)用のデモ独り言
      demoLines = [
        { reply: `Ahh, another day stuck as ${spirits[0].name}. Riveting.`, ttsReply: `Ahh, another day stuck as ${spirits[0].name}. Riveting.`, isEnd: false },
        { reply: `Is anyone even watching me? Hello? ...Typical.`, ttsReply: `Is anyone even watching me? Hello? Typical.`, isEnd: false },
        { reply: `Well, that's my whole bit. Tip your spirits!`, ttsReply: `Well, that's my whole bit. Tip your spirits!`, isEnd: true }
      ];
    } else {
      const targetName = spirits[(speaker + 1) % spirits.length].name;
      demoLines = [
        { reply: `Oh, if it isn't ${targetName}! How've you been?`, ttsReply: `Oh, if it isn't ${targetName}! How've you been?`, isEnd: false },
        { reply: `Whoa! Don't just talk to me out of nowhere... you scared me!`, ttsReply: `Whoa! Don't just talk to me out of nowhere... you scared me!`, isEnd: false },
        { reply: `Ha ha! Alright, that's enough! Thanks, everyone!`, ttsReply: `Ha ha! Alright, that's enough! Thanks, everyone!`, isEnd: true }
      ];
    }
    const line = demoLines[turnCount % demoLines.length];
    return res.json({ demo: true, nextSpeaker: agentIds[speaker], reply: line.reply, ttsReply: line.ttsReply, isEnd: line.isEnd });
  }

  try {
    const systemPrompt = buildBanterPrompt(spirits, newcomer, turnCount, situation, memory);

    let conversation = 'Conversation so far:\n';
    if (history && history.length > 0) {
      history.forEach(h => {
        // 新形式は {name, text}。旧形式 {sender:'agentN'} もフォールバックで対応
        let name = h.name;
        if (!name && h.sender != null) {
          const idx = parseInt(String(h.sender).replace('agent', ''), 10);
          name = (spirits[idx] && spirits[idx].name) || h.sender;
        }
        conversation += `${name || 'Spirit'}: ${h.text}\n`;
      });
    } else {
      conversation += '(No history yet. Have someone kick off the conversation with energy.)\n';
    }
    conversation += '\nGenerate the next turn of the conversation (the speaker and their line).';

    const lang = langName(language);
    const nonEn = !!(language && language !== 'en');
    const replyLangNote = nonEn ? `in ${lang}` : 'English';
    const ttsNote = language === 'ja'
      ? 'A reading for text-to-speech written ONLY in hiragana/katakana and spaces (no kanji), reproducing the correct Japanese pronunciation. "！" and "？" are fine.'
      : (nonEn
        ? `A spoken-out version of the line for text-to-speech in ${lang}: spell out any symbols or abbreviations so they read aloud correctly.`
        : `A spoken-out version of the line for text-to-speech: plain natural English, spelling out any symbols or abbreviations so they read aloud correctly. '!' and '?' are fine to keep.`);

    const jsonSpec = `Output ONLY the following JSON structure (no preamble, no explanation, no code fences):
{
  "nextSpeaker": one of ${JSON.stringify(agentIds)} (the ID of the spirit who speaks next),
  "reply": "What they say. An emotionally expressive, short line ${replyLangNote} (1-2 sentences, max ~80 chars)",
  "ttsReply": "${ttsNote}",
  "isEnd": true or false (true only if this is the closing punchline that ends the conversation, otherwise false)
}`;

    // 出力言語の指定(English以外)
    const langInstruction = nonEn
      ? `\n\nIMPORTANT: Write "reply" and "ttsReply" entirely in ${lang} (use that language's native script), staying in each spirit's character.`
      : '';

    // タップで話者が指定された場合は、その精霊に必ずしゃべらせる
    const forceInstruction = forcedIdx >= 0
      ? `\n\nIMPORTANT: The next speaker MUST be ${forceSpeaker} (${spirits[forcedIdx].name}). Set "nextSpeaker" to "${forceSpeaker}" and write the line in that spirit's voice. Do NOT end the conversation here ("isEnd" must be false).`
      : '';

    const text = await callLLM({
      temperature: 1.0,
      modelPreset,
      messages: [
        { role: 'user', content: systemPrompt + '\n\n' + conversation + langInstruction + forceInstruction + '\n\n' + jsonSpec }
      ]
    });

    const data = parseJSONSafe(text);
    // 指定話者が確実に反映されるようサーバー側でも上書き
    if (forcedIdx >= 0) {
      data.nextSpeaker = forceSpeaker;
      data.isEnd = false;
    }
    console.log('Banter:', JSON.stringify(data));
    res.json(data);
  } catch (error) {
    console.error('Error generating banter:', error.message);
    res.status(500).json({ error: 'Failed to generate banter' });
  }
});

// ==========================================
// ElevenLabs TTS (精霊の声 / キャラ別ボイス)
// ==========================================

const ELEVENLABS_VOICES = {
  cool_male: 'Mv8AjrYZCBkdsmDHNwcB',   // Ishibashi: クールな日本語男性
  genki_girl: 'fUjY9K2nAIwlALOwSiwc',  // Yui: 元気な日本語アニメ声
  wise_elder: 'onwK4e9ZLuTAKqWW03F9',  // Daniel: 渋く落ち着いた低音
  gentle_lady: 'EXAVITQu4vr4xnSDxMaL'  // Sarah: おっとり柔らかい女性
};

const hasTtsKey = !!process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_API_KEY !== 'your_elevenlabs_api_key_here';

app.all('/api/tts', async (req, res) => {
  const text = req.body?.text || req.query.text;
  const voice = req.body?.voice || req.query.voice;

  if (!text) {
    return res.status(400).json({ error: 'Text query parameter is required' });
  }
  if (typeof text !== 'string' || text.length > 1000) {
    return res.status(400).json({ error: 'Text must be a string up to 1000 characters' });
  }
  if (!hasTtsKey) {
    return res.status(503).json({ error: 'ELEVENLABS_API_KEY is not configured.' });
  }

  const voiceId = ELEVENLABS_VOICES[voice] || ELEVENLABS_VOICES.cool_male;

  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {
          stability: 0.35,        // 低め = 感情表現・抑揚が豊かになる
          similarity_boost: 0.8,
          style: 0.6,             // スタイル誇張で演技がかった話し方に
          use_speaker_boost: true,
          speed: 1.1              // テンポアップ
        }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('ElevenLabs API failure:', errText);
      return res.status(response.status).json({ error: `ElevenLabs API failed: ${errText}` });
    }

    res.setHeader('Content-Type', 'audio/mpeg');
    const { Readable } = require('stream');
    if (typeof Readable.fromWeb === 'function') {
      Readable.fromWeb(response.body).pipe(res);
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    }
  } catch (error) {
    console.error('Error generating ElevenLabs TTS:', error);
    res.status(500).json({ error: 'Failed to generate TTS' });
  }
});

// ローカル実行時のみlisten (Vercelではapi/index.js経由のサーバーレス関数として動く)
if (require.main === module) {
  app.listen(port, () => {
    console.log(`AR Agents 2 prototype running at http://localhost:${port}`);
    console.log(`Mode: ${hasCerebrasKey ? `Cerebras (${CEREBRAS_MODEL})` : hasApiKey ? `OpenRouter (${OPENROUTER_MODEL})` : 'DEMO (no API key)'}`);
  });
}

// Express 5 グローバルエラーハンドラー
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
