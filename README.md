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

Four backend endpoints do the real work (plus `GET /api/oak/stream` for the optional OAK camera):

| Endpoint              | Input                                | Output                                 |
|------------------------|---------------------------------------|------------------------------------------|
| `POST /api/intent`      | voice audio (or text) + latest frame + state | `{transcript, action, reply, goal, ingredients, items}` |
| `POST /api/vision-check`| camera frame + ingredient list       | `{visible:[...], present:[...], missing:[...]}` |
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

On the Live camera page, click **Start camera and mic**. From then on:

- **The camera is watched continuously.** A frame goes to OMNI every ~3s and
  the "What OMNI sees" list and the present/missing check update live. Items
  are debounced (a status must hold for 2 scans), and OMNI narrates when a
  missing item appears in view.
- **The mic is always listening (hands-free).** Speak whenever you like; the
  app cuts your speech into utterances, sends each as audio *together with the
  latest camera frame and the current state*, and OMNI decides what you want:
  set a goal ("I'm baking a chocolate cake"), skip/unskip items ("skip the
  sugar"), or answer a question about what it sees ("what's on the shelf?").
- **Hold the "Hold to talk" button** to talk regardless of hands-free mode; it
  also interrupts OMNI mid-sentence. There is a typed-request box as a fallback.
- Click **Purchase missing items via Zip** (or skip items first) to buy what's
  missing, then review it on the Zip purchases page.

## Luxonis OAK camera (optional)

An OAK camera is not a webcam, so the browser can't open it directly. The
backend reads it with the `depthai` library (`oak.py`) and serves it as an MJPEG
stream at `/api/oak/stream`; the Live camera page shows it in place of the
computer camera and samples frames from it the same way. The mic still comes
from the computer.

- Plug the OAK in over USB-C and start the backend. The page's **Camera**
  dropdown auto-selects "OAK camera" when one is detected (the computer camera
  is always available as a fallback). Pick the source *before* clicking Start.
- Tested with an OAK-1 on macOS: 1280x720 @ 15 fps.
- **USB2 is forced by default.** On this setup USB3 made the device vanish
  after boot (`X_LINK_DEVICE_NOT_FOUND`). Set `OAK_MAX_USB=SUPER` in `.env` to
  try USB3 with a good cable.
- The camera only runs while a page is viewing it; the backend releases the USB
  device ~10-15s after the page closes or you leave the Live camera tab.
- `depthai`/`opencv` are optional; without them the app just offers the
  computer camera.

## OMNI integration notes (verified against yibuapi)

- Base URL `https://yibuapi.com` (not `api.yibuapi.com`), OpenAI-compatible
  `/v1/chat/completions`. Models on the sponsor key: `qwen3.5-omni-flash`
  (default), `qwen3.5-omni-plus`, `qwen3.5-omni-plus-realtime`,
  `qwen3.8-omni-flash`, `gemini-3.1-flash-live-preview` (`GET /v1/models`).
- Audio input must be a `data:` URI (`data:;base64,...`), 16 kHz mono WAV from
  the browser. Images are JPEG data URLs.
- Audio *output* works too (`modalities: ["text","audio"]`, `stream: true`,
  voices such as `Ethan`, `Serena`, `Tina`, `Ryan`, `Aiden`, `Momo`). Replies
  are currently spoken with browser TTS; switching to OMNI voice is a small
  change in `call_omni()` plus audio playback on the frontend.

## Things to verify / adjust once you have the real docs at the event

The OMNI side is verified against the live API. The Zip side still rests on
clearly-marked assumptions, so these are the assumption points in `main.py`:

1. **`call_omni()` in `main.py`** - verified (see above).

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
- **Interruptibility.** Already in: say "skip the sugar" after the scan, or hold
  the talk button to cut OMNI off mid-sentence. Next step for the "natural
  voice" criterion: speak replies with OMNI's own voice instead of browser TTS.
- **Stage the fridge.** 5–8 items, well lit, unambiguous — vision
  reliability on stage matters more than a messy real fridge.
- **One clean end-to-end run.** Judges want a small complete workflow over
  a sprawling one — the full loop (speak → scan → purchase) is that loop;
  keep the demo to exactly that.
