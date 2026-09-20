# Needy

Needy is a voice-and-camera shopping assistant that notices what you're missing
and orders it for you. Tell it what you want to make or build, and it works out
what that takes, looks through your camera to see what you already have, and
sends a purchase request to Zip for the rest. It works for groceries (checking a
fridge or cupboard) and for hackathon hardware (checking a workbench of parts
against the MLH lab's stock), so you never have to write a shopping list.

Speak a goal ("I'm baking a chocolate cake") → OMNI figures out what you need
and checks a live camera feed of your fridge/cupboard against it → Zip buys
whatever's missing, routed through real approval/budget rules.

There are two modes, switched with the **Food / Hardware** toggle on the Live
page: **Food** checks a fridge or cupboard and buys groceries; **Hardware**
checks a workbench of electronics for a build ("I want a camera that streams
wirelessly") and requests the parts from the MLH hackathon hardware lab.

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
FastAPI backend (backend/main.py)  ── holds API keys, never exposed to browser
   │                    │
   ▼                    ▼
OMNI (yibuapi)       Zip REST API
- speech → intent    - purchase requests
- vision → inventory - approval/budget routing
```

These backend endpoints do the real work (plus `GET /api/oak/stream` for the optional OAK camera):

| Endpoint              | Input                                | Output                                 |
|------------------------|---------------------------------------|------------------------------------------|
| `POST /api/intent`      | voice audio (or text) + latest frame + state | `{transcript, action, reply, goal, ingredients, items}` |
| `POST /api/vision-check`| camera frame + ingredient list       | `{visible:[...], present:[...], missing:[...]}` |
| `POST /api/prices`      | missing items                        | pack + price per item, and the cheaper vendor (hardware: always $0.00) |
| `POST /api/purchase`    | missing items                        | Zip purchase results per item; in hardware mode `{results: [], unavailable: [{name, reason}]}` if anything is out of stock |
| `GET /api/purchases`    | -                                    | stored purchase history                  |
| `GET /api/inventory`    | -                                    | hardware lab stock: `{items: [{name, available, source?}]}` |
| `POST /api/inventory/reset` | -                                | restore the starting stock (between demos) |

`/api/intent`, `/api/vision-check` and `/api/prices` all take a `mode` of
`food` (default) or `hardware`; each mode has its own prompts.

## Setup

```bash
# backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements.txt
cp backend/.env.example backend/.env
# edit backend/.env with your real OMNI (yibuapi) key/base URL and Zip key/base URL

# frontend (React + Vite)
cd frontend && npm install
```

**Development** - run both, then open http://localhost:5173 (Vite proxies `/api` to the backend):

```bash
python backend/main.py  # backend on :3000 (or: cd backend && python main.py)
cd frontend && npm run dev
```

**Single-server build** - `cd frontend && npm run build`, then `python backend/main.py`
and open http://localhost:3000 (FastAPI serves `frontend/dist`).

Interactive API docs are at http://localhost:3000/docs.

## Grocery catalog (already seeded — do not re-run casually)

Food prices come from a real catalog of 125 staples seeded into Zip as products,
each priced at Loblaws, Metro, Walmart and Costco. The basket shows the cheapest
of the four, and each Zip request goes to the store that won that item, so one
order can be split across vendors. Anything the catalog does not stock (and all
of hardware mode) falls through to an OMNI price estimate instead.

An estimate is a fresh guess each time it is asked for, so the first one for a
given name is pinned in `backend/data/estimates.json` and reused; without that
an item can be shown at one price and ordered at another. Delete that file to
re-quote.

Vendor prices are derived from the item's reference price by
`catalog_seed.price_for`, which hashes the item and vendor name so the spread is
plausible, varies by store, and is identical on every machine and every run.

`backend/catalog_seed.py` created those items and recorded their ids in
`backend/catalog.json`, which is committed on purpose: Zip cannot list or delete
products, so without the ledger the next person to run the script would create a
permanent duplicate of every item. Re-runs skip whatever is already in it.

```bash
python backend/catalog_seed.py --dry-run         # show what is missing
python backend/catalog_seed.py                   # create only the missing items
python backend/catalog_seed.py --refresh-prices  # push edited prices to Zip
```

## Hardware mode and the MLH inventory

Hardware mode is built for a hackathon, where parts are borrowed from a lab
rather than bought. It differs from food mode in four ways:

- **Vendor.** Requests go to the `MLH` vendor in Zip (`ZIP_HARDWARE_VENDOR_NAME`,
  default `MLH`; the vendor must exist in your Zip company).
- **Everything is $0.00.** Hardware quotes, Zip requests and the Purchases page
  all show $0.00, and no OMNI price estimate is made.
- **The model picks from the lab's catalog.** The hardware prompt lists every
  orderable part name (no stock counts), so suggestions like "Raspberry Pi 3" or
  "Ultrasonic Distance Sensor" match the lab's real names. Names the model makes
  up are matched to the closest catalog item where possible (`backend/inventory.py`:
  exact name, contained name, a short alias list, then a rare-word similarity).
- **Stock is checked at checkout, not before.** The model and the basket never
  show stock. When you click **Order with Zip**, the whole basket is checked
  against the lab's stock in one step:
  - If anything is out of stock, short, or not in the catalog, **nothing is sent
    to Zip and no stock is taken**. OMNI says what is short (e.g. "ESP32-CAM is
    out of stock. Nothing was sent to Zip.") and you stay on the Live page to
    skip items or change the plan.
  - If everything is available, the stock is deducted and one Zip request per
    part is sent. OMNI says "Success! N requests sent to Zip." If Zip rejects a
    part, its stock is put back.
  - Requests are held at submission, not at approval, so a pending request still
    reserves its parts.

The stock lives in `backend/data/inventory.json` (git-ignored), created from the
committed seed `backend/inventory_seed.json` (the MLH lab list) on first use. Parts
added to the seed later appear in an existing stock file automatically. Edit counts
in either file, or use **Reset stock** on the Inventory page to restore the seed.
Special-request gear (`"source": "special"`) is never orderable; makerspace items
(`"source": "makerspace"`) are.

## Pages

The app has three pages. **Live camera** is the main flow. **Inventory** lists
the hardware lab's stock (searchable, with Reset stock). **Zip purchases** lists
every purchase request (status, goal, time), and you're taken there automatically
after purchasing. Hardware rows show how many of that part were left after the
order ("MLH · 5 remaining") in place of the Zip request number. Purchases are stored
in `backend/data/purchases.json`.

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
- Click **Order with Zip** (or skip items first) to order what's missing, then
  review it on the Zip purchases page. In hardware mode this is where the stock
  check happens (see above).
- In hardware mode, the vision check also counts retail or kit packaging: a
  Raspberry Pi 3 box (or a CanaKit kit box) marks the Pi, and the kit's contents,
  as present.

## Luxonis OAK camera (optional)

An OAK camera is not a webcam, so the browser can't open it directly. The
backend reads it with the `depthai` library (`backend/oak.py`) and serves it as an MJPEG
stream at `/api/oak/stream`; the Live camera page shows it in place of the
computer camera and samples frames from it the same way. The mic still comes
from the computer.

- Plug the OAK in over USB-C and start the backend. The page's **Camera**
  dropdown auto-selects "OAK camera" when one is detected (the computer camera
  is always available as a fallback). Pick the source *before* clicking Start.
- Tested with an OAK-1 on macOS: 1280x720 @ 15 fps.
- **USB2 is forced by default.** On this setup USB3 made the device vanish
  after boot (`X_LINK_DEVICE_NOT_FOUND`). Set `OAK_MAX_USB=SUPER` in `backend/.env` to
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
clearly-marked assumptions, so these are the assumption points in `backend/main.py`:

1. **`call_omni()` in `backend/main.py`** - verified (see above).

2. **`call_zip()` in `backend/main.py`** — assumes a REST resource like
   `POST /v1/purchase-requests` that returns a status field. Swap in the
   real endpoint path and payload shape from Zip's REST docs / Postman
   collection for the company they provision you. If you'd rather
   demo through the **Zip MCP server** instead of raw REST (arguably a
   stronger "Best Use of Zip" story since it shows agent-native tool use),
   that's a swap-in replacement for `call_zip()` — point an MCP client at
   their server and call the purchase-request tool the same way.
