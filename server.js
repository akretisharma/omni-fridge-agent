// server.js
//
// Backend for the "speak a goal -> OMNI checks inventory -> Zip buys what's
// missing" agent. Keeps API keys server-side (never ship them to the
// browser). Three real endpoints do the actual work:
//
//   POST /api/intent         audio or transcript -> {goal, ingredients[]}
//   POST /api/vision-check   fridge/cupboard photo + ingredients -> present/missing
//   POST /api/purchase       missing items -> Zip purchase requests + status
//
// The two functions you are most likely to need to adjust once you have the
// real docs in front of you are callOmni() and callZip() below - everything
// else (routing, prompt construction, diffing) should not need to change.

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // frames + audio clips as base64 can be a few MB

const {
  OMNI_BASE_URL,
  OMNI_API_KEY,
  OMNI_MODEL,
  ZIP_BASE_URL,
  ZIP_API_KEY,
  PORT = 3000,
} = process.env;

// -------------------------------------------------------------------------
// OMNI call helper
// -------------------------------------------------------------------------
// ASSUMPTION: yibuapi exposes an OpenAI-compatible /v1/chat/completions
// endpoint, and accepts multimodal "content" arrays the way OpenAI's API
// does: [{type:"text", text}, {type:"image_url", image_url:{url}},
// {type:"input_audio", input_audio:{data, format}}].
//
// If the real docs differ (different path, different field names for audio
// or images), this is the only function you should need to edit. Everything
// upstream just builds a `messages` array and calls callOmni(messages).
async function callOmni(messages, { json = true } = {}) {
  if (!OMNI_API_KEY || OMNI_API_KEY === 'REPLACE_ME') {
    throw new Error('OMNI_API_KEY is not set - copy .env.example to .env and fill it in');
  }

  const res = await fetch(`${OMNI_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OMNI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OMNI_MODEL || 'qwen3.5-omni',
      messages,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OMNI call failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';

  if (!json) return text;
  return extractJson(text);
}

// Models sometimes wrap JSON in prose or ```json fences - this pulls the
// first {...} or [...] block out and parses it, so a stray sentence before
// or after the JSON doesn't break the demo.
function extractJson(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const match = cleaned.match(/[{\[][\s\S]*[}\]]/);
  if (!match) throw new Error(`OMNI response was not JSON: ${text}`);
  return JSON.parse(match[0]);
}

// -------------------------------------------------------------------------
// Zip call helper
// -------------------------------------------------------------------------
// ASSUMPTION: standard REST resource - POST /purchase-requests creates a
// request that Zip's own approval/budget rules then route automatically.
// Swap in the real path + payload shape from Zip's REST docs / Postman
// collection for the company they set up for you. The Zip MCP server is an
// alternative to this REST call if you'd rather demo the MCP integration -
// see README.md for notes on that path.
async function callZip(item) {
  if (!ZIP_API_KEY || ZIP_API_KEY === 'REPLACE_ME') {
    throw new Error('ZIP_API_KEY is not set - copy .env.example to .env and fill it in');
  }

  const res = await fetch(`${ZIP_BASE_URL}/v1/purchase-requests`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZIP_API_KEY}`,
    },
    body: JSON.stringify({
      description: item.name,
      quantity: item.quantity || 1,
      unit: item.unit || 'unit',
      justification: `Auto-requested by OMNI Fridge Agent: missing ingredient for "${item.goal || 'the current task'}"`,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Zip call failed (${res.status}): ${errText}`);
  }

  return res.json();
}

// -------------------------------------------------------------------------
// POST /api/intent
// Body: { transcript?: string, audioBase64?: string, audioFormat?: string }
// Returns: { goal: string, ingredients: [{name, quantity, unit}] }
// -------------------------------------------------------------------------
app.post('/api/intent', async (req, res) => {
  try {
    const { transcript, audioBase64, audioFormat } = req.body;

    const systemPrompt = {
      role: 'system',
      content:
        'You are a kitchen/pantry assistant. The user will describe something ' +
        'they want to do (e.g. "I\'m baking a chocolate cake" or "I need to ' +
        'restock the printer supplies"). Work out the concrete list of items ' +
        'needed to accomplish it. Respond with ONLY a JSON object of the form ' +
        '{"goal": "<short label>", "ingredients": [{"name": "<item>", ' +
        '"quantity": <number>, "unit": "<unit>"}]}. Keep the list to the items ' +
        'that matter for the demo (roughly 5-8 items). No prose, just JSON.',
    };

    let userContent;
    if (audioBase64) {
      // Primary path: send the raw audio to OMNI so speech/audio
      // understanding is genuinely happening inside OMNI, not a browser API.
      userContent = [
        {
          type: 'input_audio',
          input_audio: { data: audioBase64, format: audioFormat || 'webm' },
        },
      ];
    } else if (transcript) {
      // Fallback path: browser SpeechRecognition already produced text.
      // Still a real OMNI call for the language-reasoning half of the task,
      // useful as a demo-safety net if live audio upload is flaky.
      userContent = [{ type: 'text', text: transcript }];
    } else {
      return res.status(400).json({ error: 'Provide transcript or audioBase64' });
    }

    const result = await callOmni([systemPrompt, { role: 'user', content: userContent }]);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// POST /api/vision-check
// Body: { imageBase64: string, ingredients: [{name, quantity, unit}] }
// Returns: { present: string[], missing: string[] }
// -------------------------------------------------------------------------
app.post('/api/vision-check', async (req, res) => {
  try {
    const { imageBase64, ingredients } = req.body;
    if (!imageBase64 || !Array.isArray(ingredients)) {
      return res.status(400).json({ error: 'imageBase64 and ingredients[] are required' });
    }

    const names = ingredients.map((i) => i.name);

    const systemPrompt = {
      role: 'system',
      content:
        'You are a vision system inspecting a photo of a fridge or cupboard. ' +
        'Given a photo and a checklist of ingredient names, decide which items ' +
        'are visibly present and which are not. Be reasonably strict - only ' +
        'mark something present if you can actually see it or its container. ' +
        'Respond with ONLY a JSON object: {"present": ["..."], "missing": ["..."]} ' +
        'using the exact item names from the checklist.',
    };

    const userMessage = {
      role: 'user',
      content: [
        { type: 'text', text: `Checklist: ${JSON.stringify(names)}` },
        { type: 'image_url', image_url: { url: imageBase64 } },
      ],
    };

    const result = await callOmni([systemPrompt, userMessage]);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------------
// POST /api/purchase
// Body: { items: [{name, quantity, unit}], goal?: string }
// Returns: { results: [{name, status, raw}] }
// -------------------------------------------------------------------------
app.post('/api/purchase', async (req, res) => {
  try {
    const { items, goal } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items[] is required' });
    }

    const results = [];
    for (const item of items) {
      try {
        const raw = await callZip({ ...item, goal });
        results.push({
          name: item.name,
          status: raw.status || raw.state || 'submitted',
          raw,
        });
      } catch (err) {
        results.push({ name: item.name, status: 'error', error: err.message });
      }
    }

    res.json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static('public'));

app.listen(PORT, () => {
  console.log(`OMNI Fridge Agent backend listening on http://localhost:${PORT}`);
});
