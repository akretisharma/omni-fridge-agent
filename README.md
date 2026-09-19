# OMNI Fridge Agent

Speak a goal ("I'm baking a chocolate cake") → OMNI figures out what you need
and checks a live camera feed of your fridge/cupboard against it → Zip buys
whatever's missing, routed through real approval/budget rules.

Built for Hack the North — targets the **OMNI Live** and **Zip** sponsor
prizes at once.

## Why this needs multimodal AI (not a chatbot)

A text-only assistant can't see what's actually in the fridge. A vision-only
app can't turn "I'm baking a cake" into a concrete ingredient list, and can't
narrate results back. This agent chains all three: **speech** (what do you
want to do) → **language reasoning** (what does that require) → **vision**
(what do you actually have) → **procurement action** (get the rest, with real
approval routing).

## Architecture

```
Browser (mic + camera)
   │  audio / photo (base64)
   ▼
FastAPI backend (main.py)  ── holds API keys, never exposed to browser
   │                    │
   ▼                    ▼
OMNI (yibuapi)       Zip REST API
- speech → intent    - purchase requests
- vision → inventory - approval/budget routing
```

Three backend endpoints do the real work:

| Endpoint              | Input                                | Output                                 |
|------------------------|---------------------------------------|------------------------------------------|
| `POST /api/intent`      | mic audio (or transcript fallback)   | `{goal, ingredients:[{name,qty,unit}]}`  |
| `POST /api/vision-check`| camera frame + ingredient list       | `{present:[...], missing:[...]}`         |
| `POST /api/purchase`    | missing items                        | Zip purchase results per item            |
| `GET /api/purchases`    | -                                    | stored purchase history                  |

## Setup

```bash
# backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# edit .env with your real OMNI (yibuapi) key/base URL and Zip key/base URL

# frontend (React + Vite)
cd frontend && npm install
```

**Development** - run both, then open http://localhost:5173 (Vite proxies `/api` to the backend):

```bash
python main.py          # backend on :3000
cd frontend && npm run dev
```

**Single-server build** - `cd frontend && npm run build`, then `python main.py`
and open http://localhost:3000 (FastAPI serves `frontend/dist`).

Interactive API docs are at http://localhost:3000/docs.

The app has two pages. **Live camera** is the main flow; **Zip purchases**
lists every purchase request (status, goal, time), and you're taken there
automatically after purchasing. Purchases are stored in `data/purchases.json`.

On the Live camera page, click **Start camera**, point it at the fridge/cupboard, then **hold the
"Hold to talk" button** and say something like *"I'm baking a chocolate
cake."* Release to send. Once the ingredient list appears, click **Scan
fridge / cupboard**, then **Purchase missing items via Zip**.

## Things to verify / adjust once you have the real docs at the event

I don't have your actual OMNI or Zip API documentation, so this scaffold
makes reasonable, clearly-marked assumptions. Everything else in the app
(routing, prompts, UI, diffing logic) is complete and shouldn't need
changes — only these two functions in `main.py` are assumption points:

1. **`call_omni()` in `main.py`** — assumes yibuapi exposes an
   OpenAI-compatible `/v1/chat/completions` endpoint, and accepts
   multimodal `content` blocks (`image_url`, `input_audio`) the way
   OpenAI's API does. Check `https://yibuapi.com/pricing` / your API key
   email for the real base URL, model name, and exact content-block
   format for audio and images. If audio input isn't supported yet,
   uncheck **"Send raw audio to OMNI"** in the UI to fall back to the
   browser's built-in speech-to-text — the language reasoning still goes
   through OMNI either way.

2. **`call_zip()` in `main.py`** — assumes a REST resource like
   `POST /v1/purchase-requests` that returns a status field. Swap in the
   real endpoint path and payload shape from Zip's REST docs / Postman
   collection for the company they provision you. If you'd rather
   demo through the **Zip MCP server** instead of raw REST (arguably a
   stronger "Best Use of Zip" story since it shows agent-native tool use),
   that's a swap-in replacement for `call_zip()` — point an MCP client at
   their server and call the purchase-request tool the same way.

## Ideas to strengthen the demo before judging

- **Make the approval logic visible.** Pick a scenario where one item
  (e.g. butter) pushes the cart over a budget threshold and gets routed
  for approval while the rest auto-approve — say so out loud. That's the
  single biggest lever for the Zip "Best Use" prize: reading data is fine,
  but *using* the approval/budget rules is what scores.
- **Interruptibility.** The missing-item chips are already click-to-skip
  before purchase. For the OMNI "continuous/interruptible interaction"
  criterion, the natural extension is a second push-to-talk moment after
  the scan ("actually skip the sugar") that removes an item by voice
  instead of a click — `handleUtterance` and `renderCheck` are already
  structured to make that a small addition.
- **Stage the fridge.** 5–8 items, well lit, unambiguous — vision
  reliability on stage matters more than a messy real fridge.
- **One clean end-to-end run.** Judges want a small complete workflow over
  a sprawling one — the full loop (speak → scan → purchase) is that loop;
  keep the demo to exactly that.
