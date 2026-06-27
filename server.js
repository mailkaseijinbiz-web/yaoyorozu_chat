const express = require('express');
const dotenv = require('dotenv');
const path = require('path');
const cors = require('cors');

dotenv.config({ override: true });

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// OpenRouter (OpenAI互換API) — google/gemma-3-27b-it
// ==========================================
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'google/gemma-3-27b-it';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const hasApiKey = !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY !== 'your_openrouter_api_key_here';

if (!hasApiKey) {
  console.warn('OPENROUTER_API_KEY is not set — starting in DEMO mode (fixed responses).');
}

// OpenRouterのchat completionsを呼び、本文テキストを返す。
// Gemmaはレスポンススキーマ非対応のため、JSON整形はプロンプト指示＋parseJSONSafeで担保する。
async function callOpenRouter({ messages, temperature }) {
  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/yaorozu-chat',
      'X-Title': 'Yaorozu Chat'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      ...(temperature != null ? { temperature } : {})
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
  return text;
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
  const { image } = req.body;
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
If there are no suitable objects, set "targets" to an empty array.`;

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

function buildBanterPrompt(spirits, newcomer, turnCount, situation) {
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

  return `You are a skilled comedy writer composing a snappy, comedy-duo-style back-and-forth between spirits that inhabit everyday objects.
The ${spirits.length} spirits on stage are:

${cast}
${newcomer ? `\n* "${newcomer}" has just joined the conversation! Have everyone welcome them or tease them.\n` : ''}

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
  const { spirits, history, newcomer, situation } = req.body;

  if (!spirits || !Array.isArray(spirits) || spirits.length < 2) {
    return res.status(400).json({ error: 'At least 2 spirits are required' });
  }

  const agentIds = spirits.map((_, i) => `agent${i}`);
  const turnCount = history ? history.length : 0;

  if (!hasApiKey) {
    const speaker = turnCount % spirits.length;
    const targetName = spirits[(speaker + 1) % spirits.length].name;
    const demoLines = [
      { reply: `Oh, if it isn't ${targetName}! How've you been?`, ttsReply: `Oh, if it isn't ${targetName}! How've you been?`, isEnd: false },
      { reply: `Whoa! Don't just talk to me out of nowhere... you scared me!`, ttsReply: `Whoa! Don't just talk to me out of nowhere... you scared me!`, isEnd: false },
      { reply: `Ha ha! Alright, that's enough! Thanks, everyone!`, ttsReply: `Ha ha! Alright, that's enough! Thanks, everyone!`, isEnd: true }
    ];
    const line = demoLines[turnCount % demoLines.length];
    return res.json({ demo: true, nextSpeaker: agentIds[speaker], reply: line.reply, ttsReply: line.ttsReply, isEnd: line.isEnd });
  }

  try {
    const systemPrompt = buildBanterPrompt(spirits, newcomer, turnCount, situation);

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

    const jsonSpec = `Output ONLY the following JSON structure (no preamble, no explanation, no code fences):
{
  "nextSpeaker": one of ${JSON.stringify(agentIds)} (the ID of the spirit who speaks next),
  "reply": "What they say. An emotionally expressive, short English line (1-2 sentences, max ~80 chars)",
  "ttsReply": "A spoken-out version of the line for text-to-speech: plain natural English, spelling out any symbols or abbreviations so they read aloud correctly. '!' and '?' are fine to keep.",
  "isEnd": true or false (true only if this is the closing punchline that ends the conversation, otherwise false)
}`;

    const text = await callOpenRouter({
      temperature: 1.0,
      messages: [
        { role: 'user', content: systemPrompt + '\n\n' + conversation + '\n\n' + jsonSpec }
      ]
    });

    const data = parseJSONSafe(text);
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
    console.log(`Mode: ${hasApiKey ? `OpenRouter (${OPENROUTER_MODEL})` : 'DEMO (no API key)'}`);
  });
}

// Express 5 グローバルエラーハンドラー
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
