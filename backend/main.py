# main.py
#
# Backend for the "speak a goal -> OMNI checks inventory -> Zip buys what's
# missing" agent. Keeps API keys server-side (never ship them to the
# browser). Three real endpoints do the actual work:
#
#   POST /api/intent         voice request (+ camera frame + state) -> action + reply
#   POST /api/vision-check   camera frame + checklist -> visible/present/missing
#   POST /api/prices         missing items -> estimated pack/SKU + price per item
#   POST /api/purchase       missing items -> Zip purchase requests + status
#   GET  /api/purchases      stored purchase history for the Purchases page
#   GET  /api/oak/stream     Luxonis OAK camera as MJPEG (optional, needs depthai)
#
# The two functions you are most likely to need to adjust once you have the
# real docs in front of you are call_omni() and call_zip() below - everything
# else (routing, prompt construction, diffing) should not need to change.

import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel

from oak import oak
from zip_client import call_zip


BACKEND_DIR = Path(__file__).parent
load_dotenv(BACKEND_DIR / ".env")  # backend/.env, regardless of the working directory

OMNI_BASE_URL = (os.getenv("OMNI_BASE_URL") or "https://yibuapi.com").rstrip("/")
OMNI_API_KEY = os.getenv("OMNI_API_KEY", "")
OMNI_MODEL = os.getenv("OMNI_MODEL") or "qwen3.5-omni-flash"
ZIP_BASE_URL = os.getenv("ZIP_BASE_URL", "")
ZIP_API_KEY = os.getenv("ZIP_API_KEY", "")
PORT = int(os.getenv("PORT", "3000"))

FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"
PURCHASES_FILE = BACKEND_DIR / "data" / "purchases.json"

app = FastAPI(title="OMNI Fridge Agent")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# Match the old Express behaviour: errors come back as {"error": "..."} so the
# frontend's `(await res.json()).error` keeps working.
@app.exception_handler(HTTPException)
async def http_exception_handler(_, exc: HTTPException):
    return JSONResponse({"error": exc.detail}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_, exc: RequestValidationError):
    msg = "; ".join(f"{'.'.join(map(str, e['loc'][1:]))}: {e['msg']}" for e in exc.errors())
    return JSONResponse({"error": msg}, status_code=400)


# -------------------------------------------------------------------------
# Request models
# -------------------------------------------------------------------------
class Ingredient(BaseModel):
    name: str
    quantity: Optional[float] = None
    unit: Optional[str] = None


Mode = Literal["food", "hardware"]


class IntentRequest(BaseModel):
    # One voice request: audio (preferred) or typed text, plus the latest camera
    # frame and what the app currently believes, so OMNI can answer in context.
    transcript: Optional[str] = None
    audioBase64: Optional[str] = None
    audioFormat: Optional[str] = None
    imageBase64: Optional[str] = None
    goal: Optional[str] = None
    ingredients: list[Ingredient] = []
    present: list[str] = []
    missing: list[str] = []
    skipped: list[str] = []
    visible: list[str] = []
    mode: Mode = "food"


class VisionCheckRequest(BaseModel):
    imageBase64: str
    ingredients: list[Ingredient] = []  # empty checklist = just describe what's visible
    mode: Mode = "food"


class PriceRequest(BaseModel):
    items: list[Ingredient]
    goal: Optional[str] = None
    mode: Mode = "food"


class PriceQuote(BaseModel):
    product: Optional[str] = None
    rate: Optional[str] = None


class PurchaseRequest(BaseModel):
    items: list[Ingredient]
    goal: Optional[str] = None
    mode: Mode = "food"
    # Quotes the user already saw (from /api/prices), keyed by item name. Reused
    # as-is so the order matches the basket on screen instead of re-guessing.
    prices: dict[str, PriceQuote] = {}


# -------------------------------------------------------------------------
# OMNI call helper
# -------------------------------------------------------------------------
# yibuapi exposes an OpenAI-compatible /v1/chat/completions endpoint
# (verified against the live API with qwen3.5-omni-flash). Multimodal
# "content" arrays: [{type:"text", text}, {type:"image_url", image_url:{url}},
# {type:"input_audio", input_audio:{data, format}}]. Gotchas:
#   - input_audio.data must be a data URI ("data:;base64,<b64>"), not bare base64.
#   - Available models: qwen3.5-omni-flash / -plus / -plus-realtime,
#     qwen3.8-omni-flash, gemini-3.1-flash-live-preview (see GET /v1/models).
#   - Spoken output is supported via modalities:["text","audio"] + stream:true
#     with audio.voice in {Ethan, Serena, Tina, Ryan, Aiden, Momo, ...}.
# Everything upstream just builds a `messages` list and calls call_omni(messages).
async def call_omni(messages: list[dict], parse_json: bool = True) -> Any:
    if not OMNI_API_KEY or OMNI_API_KEY == "REPLACE_ME":
        raise RuntimeError("OMNI_API_KEY is not set - copy backend/.env.example to backend/.env and fill it in")

    async with httpx.AsyncClient(timeout=120) as client:
        res = await client.post(
            f"{OMNI_BASE_URL}/v1/chat/completions",
            headers={"Authorization": f"Bearer {OMNI_API_KEY}"},
            json={"model": OMNI_MODEL, "messages": messages, "temperature": 0.2},
        )

    if res.status_code >= 400:
        raise RuntimeError(f"OMNI call failed ({res.status_code}): {res.text}")

    data = res.json()
    text = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""

    return extract_json(text) if parse_json else text


# Models sometimes wrap JSON in prose or ```json fences - this pulls the
# first {...} or [...] block out and parses it, so a stray sentence before
# or after the JSON doesn't break the demo.
def extract_json(text: str) -> Any:
    cleaned = re.sub(r"```json|```", "", text).strip()
    match = re.search(r"[{\[][\s\S]*[}\]]", cleaned)
    if not match:
        raise RuntimeError(f"OMNI response was not JSON: {text}")
    return json.loads(match.group(0))


_PRICE_JSON = (
    'Reply with ONLY JSON: {"items":[{"name":"<same name as input>",'
    '"product":"<what you would actually buy>","rate":"<price like 13.98>"}]}. '
    "Include every input name. rate must be a number string with 2 decimals."
)

PRICE_PROMPTS = {
    "food": (
        "You estimate typical US store pack prices in USD for anything a fridge or "
        "pantry agent might buy: groceries, produce, drinks, liquor, snacks, "
        "household goods, or other inventory. There is no fixed catalog — invent a "
        "reasonable pack for whatever names you are given. Pick the common package "
        "someone would actually buy (a bag of ice, 750ml vodka, 12 eggs, a bag of "
        "chips), not the recipe amount. " + _PRICE_JSON
    ),
    "hardware": (
        "You estimate typical US retail prices in USD for electronics and maker "
        "parts a hackathon hardware lab would buy: Arduino/ESP32/Raspberry Pi "
        "boards, cameras, sensors, motors, servos, breadboards, jumper wires, "
        "resistors, LEDs, batteries, USB cables, microSD cards, power supplies, "
        "and similar beginner-friendly modules. There is no fixed catalog — invent "
        "a reasonable SKU for whatever names you are given (e.g. Raspberry Pi 3 "
        "Model B, HC-SR04 ultrasonic sensor, 32GB microSD). Price one purchasable "
        "unit (Adafruit / Amazon / Micro Center typical), not a bulk reel. "
        + _PRICE_JSON
    ),
}


async def guess_prices(items: list, goal: Optional[str], mode: str = "food") -> dict[str, dict]:
    """OMNI guesses a store-pack or parts-SKU price per item. Keyed by lowercased name."""
    payload = {
        "mode": mode,
        "goal": goal,
        "items": [{"name": i.name, "quantity": i.quantity, "unit": i.unit} for i in items],
    }
    prompt = PRICE_PROMPTS.get(mode) or PRICE_PROMPTS["food"]
    try:
        result = await call_omni(
            [
                {"role": "system", "content": prompt},
                {"role": "user", "content": json.dumps(payload)},
            ]
        )
    except Exception as err:
        print("OMNI price guess failed:", err)
        return {}
    out: dict[str, dict] = {}
    rows = result.get("items") if isinstance(result, dict) else result
    if not isinstance(rows, list):
        return {}
    for row in rows:
        if not isinstance(row, dict) or not row.get("name"):
            continue
        try:
            rate = f"{max(0.01, float(row.get('rate'))):.2f}"
        except (TypeError, ValueError):
            continue
        out[str(row["name"]).strip().lower()] = {
            "product": str(row.get("product") or row["name"]).strip(),
            "rate": rate,
        }
    return out


# guess_prices keys by lowercased name; the frontend holds the exact names.
def by_item_name(items: list, prices: dict[str, dict]) -> dict[str, dict]:
    return {i.name: prices[key] for i in items if (key := (i.name or "").strip().lower()) in prices}


# Zip lives in zip_client.py: POST /requests on HTN staging so they show
# on the same Zip company dashboard as this API key.


# -------------------------------------------------------------------------
# POST /api/intent
# Body: { audioBase64? | transcript?, audioFormat?, imageBase64?, + app state
#         (goal, ingredients, present, missing, skipped, visible) }
# Returns: { transcript, action, reply, goal, ingredients, items }
#   action: set_goal | skip_items | unskip_items | answer
# -------------------------------------------------------------------------
# The app has two modes. "food" checks a fridge/cupboard; "hardware" checks a
# workbench of electronics for a build. The JSON field is still called
# "ingredients" in both so the API and frontend share one shape: in hardware
# mode it holds the parts list.
_INTENT_FORMAT = (
    "You receive their request (audio or text), the latest camera frame, and the "
    "app's current state as JSON. Use all three together. Decide what the user "
    "wants and respond with ONLY a JSON object:\n"
    '{"transcript": "<exact words the user said>", '
    '"action": "set_goal" | "skip_items" | "unskip_items" | "answer", '
    '"reply": "<1-2 short spoken sentences, natural, no markdown>", '
    '"goal": "<short label, set_goal only>", '
    '"ingredients": [{"name": "<item>", "quantity": <number>, "unit": "<unit>"}], '
    '"items": ["<item names, skip_items/unskip_items only>"]}\n'
)

INTENT_PROMPTS = {
    "food": (
        "You are OMNI, a voice assistant built into a smart fridge/cupboard camera. "
        "The user speaks to you at any time. " + _INTENT_FORMAT +
        "Actions: set_goal = the user states something they want to make or do (or "
        "changes their goal). For set_goal you MUST fill ingredients with the 5-8 "
        "concrete items needed (never leave it empty, never ask the user what they "
        "need) and the reply should confirm the goal and say you'll check the "
        'fridge, e.g. {"transcript": "I\'m making pancakes", "action": "set_goal", '
        '"reply": "Pancakes, nice - let me see what you have.", "goal": "pancakes", '
        '"ingredients": [{"name": "flour", "quantity": 2, "unit": "cups"}, '
        '{"name": "eggs", "quantity": 2, "unit": "whole"}, ...]}. skip_items / '
        "unskip_items = the user says not to buy (or to buy again) certain missing "
        "items - use the exact names from state.missing. answer = anything else, "
        "such as a question about what you can see, in which case answer from the "
        "camera frame. Keep replies brief and conversational. Never invent items "
        "you cannot see."
    ),
    "hardware": (
        "You are OMNI, a voice assistant built into a hackathon workbench camera. "
        "The camera looks at a desk of electronics parts (boards, sensors, cameras, "
        "cables, power supplies). The user speaks to you at any time. " + _INTENT_FORMAT +
        "Actions: set_goal = the user states a project they want to build (or "
        "changes their project). For set_goal you MUST fill ingredients with the "
        "5-10 concrete parts the build needs, INCLUDING parts the user may "
        "already own such as the main board and camera, so the camera can check "
        "them off (never leave it empty, never ask the user what they need). Use "
        "specific, purchasable part names with a model or spec, and a quantity "
        "with unit \"pcs\". Cover the whole build: compute, sensor/camera, "
        "power, storage, cables/connectors, and anything needed for the "
        "networking or output the user described. Keep the list minimal and "
        "realistic: one part per name (never \"X or Y\"), nothing already built "
        "into the main board (a Raspberry Pi 3 has Wi-Fi, so no Wi-Fi adapter), "
        "and no accessories the build does not need (no monitor or HDMI cable "
        "for a headless device). This is a hackathon hardware project and parts are "
        "borrowed from the MLH hardware lab inventory, so only choose common, "
        "cheap, beginner-friendly parts a hackathon hardware lab stocks: Arduino "
        "and ESP32/ESP8266 boards, Raspberry Pi, common sensors (ultrasonic, PIR, "
        "DHT/BME280, IMU, soil moisture), servos, DC motors and drivers, LEDs and "
        "LED strips, buttons, breadboards, jumper wires, resistors, batteries and "
        "USB cables. Avoid custom, niche or expensive parts, industrial "
        "equipment, and anything that needs soldering or fabrication when a "
        "breakout board or module would do. The reply should confirm the "
        "project and say you'll check the desk, e.g. "
        '{"transcript": "We want a Wi-Fi streaming camera", "action": "set_goal", '
        '"reply": "A Wi-Fi camera streamer, nice - let me see what is on your desk.", '
        '"goal": "wifi streaming camera", "ingredients": '
        '[{"name": "Raspberry Pi 3 Model B", "quantity": 1, "unit": "pcs"}, '
        '{"name": "Raspberry Pi Camera Module v2", "quantity": 1, "unit": "pcs"}, '
        '{"name": "microSD card 32GB", "quantity": 1, "unit": "pcs"}, '
        '{"name": "5V 2.5A micro-USB power supply", "quantity": 1, "unit": "pcs"}, '
        "...]}. skip_items / unskip_items = the user says not to buy (or to buy "
        "again) certain missing parts - use the exact names from state.missing. "
        "answer = anything else, such as a question about what parts you can see, "
        "in which case answer from the camera frame. Keep replies brief and "
        "conversational. Never claim to see a part you cannot see."
    ),
}


def intent_prompt(mode: str) -> dict:
    return {"role": "system", "content": INTENT_PROMPTS[mode]}


INTENT_ACTIONS = {"set_goal", "skip_items", "unskip_items", "answer"}


def _audio_part(b64: str, fmt: Optional[str]) -> dict:
    # yibuapi wants a data URI here; accept bare base64 or an existing data URI.
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return {"type": "input_audio", "input_audio": {"data": f"data:;base64,{b64}", "format": fmt or "wav"}}


def _clean_names(value: Any) -> list[str]:
    return [n.strip() for n in value if isinstance(n, str) and n.strip()] if isinstance(value, list) else []


def _normalize_intent(r: Any, fallback_transcript: str = "") -> dict:
    r = r if isinstance(r, dict) else {}
    ingredients = []
    for ing in r.get("ingredients") or []:
        if isinstance(ing, dict) and isinstance(ing.get("name"), str) and ing["name"].strip():
            ingredients.append(
                {"name": ing["name"].strip(), "quantity": ing.get("quantity"), "unit": ing.get("unit")}
            )
    action = r.get("action") if r.get("action") in INTENT_ACTIONS else "answer"
    if action == "set_goal" and not ingredients:
        action = "answer"
    is_goal = action == "set_goal"
    return {
        "transcript": r.get("transcript") or fallback_transcript,
        "action": action,
        "reply": r.get("reply") or "",
        "goal": (r.get("goal") or None) if is_goal else None,
        "ingredients": ingredients if is_goal else [],
        "items": _clean_names(r.get("items")) if action in ("skip_items", "unskip_items") else [],
    }


@app.post("/api/intent")
async def intent(body: IntentRequest):
    if body.audioBase64:
        # Primary path: send the raw audio to OMNI so speech/audio
        # understanding is genuinely happening inside OMNI, not a browser API.
        request_part = _audio_part(body.audioBase64, body.audioFormat)
    elif body.transcript:
        # Typed fallback - a demo-safety net if the mic is unavailable.
        request_part = {"type": "text", "text": f"User said: {body.transcript}"}
    else:
        raise HTTPException(400, "Provide transcript or audioBase64")

    state = {
        "goal": body.goal,
        "needed": [i.name for i in body.ingredients],
        "present": body.present,
        "missing": body.missing,
        "skipped": body.skipped,
        "visible_now": body.visible,
    }
    content: list[dict] = [{"type": "text", "text": f"App state: {json.dumps(state)}"}, request_part]
    if body.imageBase64:
        content.append({"type": "image_url", "image_url": {"url": body.imageBase64}})

    result = await _omni_or_500([intent_prompt(body.mode), {"role": "user", "content": content}])
    return _normalize_intent(result, body.transcript or "")


# -------------------------------------------------------------------------
# POST /api/vision-check
# Body: { imageBase64: str, ingredients?: [{name, quantity, unit}] }
# Returns: { visible: [str], present: [str], missing: [str] }
# Called continuously by the frontend (one frame every few seconds).
# -------------------------------------------------------------------------
_VISION_FORMAT = (
    'Respond with ONLY a JSON object: {"visible": ["..."], "present": ["..."], '
    '"missing": ["..."]}. present and missing must use the exact item names from '
    "the checklist (both empty if the checklist is empty)."
)

VISION_PROMPTS = {
    "food": (
        "You are a vision system watching a live camera feed of a fridge or cupboard. "
        "Given one frame and an optional checklist, report (a) every distinct food or "
        "household item you can clearly see, and (b) which checklist items are "
        "visibly present versus not. Be reasonably strict - only mark something "
        "present if you can actually see it or its container. " + _VISION_FORMAT
    ),
    "hardware": (
        "You are a vision system watching a live camera feed of a hackathon "
        "workbench. Given one frame and an optional checklist of parts, report (a) "
        "every distinct electronics part you can clearly see (name the board, "
        "module, sensor, camera, cable or power supply as specifically as you can, "
        "e.g. \"Raspberry Pi 3 Model B\", \"Raspberry Pi camera module\", "
        '"USB cable"), and (b) which checklist items are visibly present versus '
        "not. A checklist item is present if a part that fills that role is "
        "visible, even if the exact brand differs (a Raspberry Pi 3 board counts "
        "for \"Raspberry Pi 3 Model B\"; a ribbon-cable camera board counts for a "
        "Raspberry Pi camera module). Retail or kit packaging counts too: if you "
        "see a box for a part or kit (e.g. a Raspberry Pi 3 box, a CanaKit "
        "starter kit), mark that part present, plus anything the packaging says "
        "or the kit normally includes (a CanaKit Pi kit includes the board, "
        "microSD card and power supply). Be strict about parts you cannot see: a "
        "microSD card, power supply or cable only counts if you can actually see "
        "one. " + _VISION_FORMAT
    ),
}


def vision_prompt(mode: str) -> dict:
    return {"role": "system", "content": VISION_PROMPTS[mode]}


@app.post("/api/vision-check")
async def vision_check(body: VisionCheckRequest):
    names = [i.name for i in body.ingredients]
    user_message = {
        "role": "user",
        "content": [
            {"type": "text", "text": f"Checklist: {json.dumps(names)}"},
            {"type": "image_url", "image_url": {"url": body.imageBase64}},
        ],
    }
    result = await _omni_or_500([vision_prompt(body.mode), user_message])
    result = result if isinstance(result, dict) else {}

    # Trust the model for what's present, but derive missing from the checklist
    # so the two lists always partition it exactly.
    by_lower = {n.lower(): n for n in names}
    present = []
    for n in _clean_names(result.get("present")):
        canon = by_lower.get(n.lower())
        if canon and canon not in present:
            present.append(canon)
    return {
        "visible": _clean_names(result.get("visible"))[:25],
        "present": present,
        "missing": [n for n in names if n not in present],
    }


async def _omni_or_500(messages: list[dict]) -> Any:
    try:
        return await call_omni(messages)
    except Exception as err:  # surface the message to the UI, like the old backend
        print(err)
        raise HTTPException(500, str(err))


# -------------------------------------------------------------------------
# POST /api/prices
# Body: { items: [{name, quantity, unit}], goal?: str, mode?: str }
# Returns: { prices: { "<item name>": {product, rate} } }
# Lets the UI show what each missing item will cost before ordering. Items OMNI
# cannot price are simply absent from the map.
# -------------------------------------------------------------------------
@app.post("/api/prices")
async def prices(body: PriceRequest):
    if not body.items:
        return {"prices": {}}
    quotes = await guess_prices(body.items, body.goal, body.mode)
    return {"prices": by_item_name(body.items, quotes)}


# -------------------------------------------------------------------------
# POST /api/purchase
# Body: { items: [{name, quantity, unit}], goal?: str, prices?: {name: {product, rate}} }
# Returns: { results: [{name, status, amount, product, raw}] }
# -------------------------------------------------------------------------
@app.post("/api/purchase")
async def purchase(body: PurchaseRequest):
    if not body.items:
        raise HTTPException(400, "items[] is required")

    quoted = {
        name.strip().lower(): q
        for name, quote in body.prices.items()
        if (q := quote.model_dump(exclude_none=True))
    }
    unquoted = [i for i in body.items if (i.name or "").strip().lower() not in quoted]
    prices = {**(await guess_prices(unquoted, body.goal, body.mode) if unquoted else {}), **quoted}
    results = []
    for item in body.items:
        try:
            priced = prices.get((item.name or "").strip().lower()) or {}
            raw = await call_zip({**item.model_dump(), "goal": body.goal, "mode": body.mode, **priced})
            results.append(
                {
                    "name": item.name,
                    "status": raw.get("status") or "submitted",
                    "amount": raw.get("amount"),
                    "product": raw.get("product"),
                    "vendor": raw.get("vendor"),
                    "request_id": raw.get("request_id"),
                    "request_number": raw.get("request_number"),
                    "po_number": raw.get("po_number"),
                    "raw": raw,
                }
            )
        except Exception as err:
            results.append({"name": item.name, "status": "error", "error": str(err)})

    # Record every attempt (including errors) so the Purchases page can show them.
    now = time.time()
    records = [
        {
            "id": uuid.uuid4().hex,
            "createdAt": now,
            "goal": body.goal,
            "mode": body.mode,
            "name": item.name,
            "quantity": item.quantity,
            "unit": item.unit,
            "status": r["status"],
            "amount": r.get("amount"),
            "product": r.get("product"),
            "vendor": r.get("vendor"),
            "request_id": r.get("request_id"),
            "request_number": r.get("request_number"),
            "po_number": r.get("po_number"),
            "error": r.get("error"),
            "raw": r.get("raw"),
        }
        for item, r in zip(body.items, results)
    ]
    _save_purchases(records + _load_purchases())

    return {"results": results}


# -------------------------------------------------------------------------
# GET /api/purchases
# Returns: { purchases: [{id, createdAt, goal, name, quantity, unit, status,
#            amount, product, error, raw}] }
# Newest first. Persisted to backend/data/purchases.json so a server restart keeps them.
# -------------------------------------------------------------------------
def _load_purchases() -> list[dict]:
    try:
        return json.loads(PURCHASES_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_purchases(records: list[dict]) -> None:
    PURCHASES_FILE.parent.mkdir(exist_ok=True)
    PURCHASES_FILE.write_text(json.dumps(records, indent=2))


@app.get("/api/purchases")
async def list_purchases():
    return {"purchases": _load_purchases()}


@app.delete("/api/purchases")
async def clear_purchases():
    _save_purchases([])
    return {"purchases": []}


# -------------------------------------------------------------------------
# Luxonis OAK camera (not a UVC webcam, so it can't go through getUserMedia)
#   GET /api/oak/status  -> { installed, available, running, error }
#   GET /api/oak/stream  -> multipart MJPEG, shown by the page in an <img>
# -------------------------------------------------------------------------
@app.get("/api/oak/status")
def oak_status():
    return oak.status()


@app.get("/api/oak/stream")
async def oak_stream():
    return StreamingResponse(oak.mjpeg(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/api/health")
async def health():
    return {"ok": True}


# Serves the built React app (npm run build in frontend/). Unknown paths fall
# back to index.html so client-side routes like /purchases survive a refresh.
# In development, run `npm run dev` in frontend/ instead - Vite proxies /api here.
class SPAStaticFiles(StaticFiles):
    async def get_response(self, path, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as exc:
            if exc.status_code == 404 and not path.startswith("api/"):
                return await super().get_response("index.html", scope)
            raise


# Mounted last so it doesn't shadow the /api routes.
if FRONTEND_DIST.exists():
    app.mount("/", SPAStaticFiles(directory=FRONTEND_DIST, html=True), name="static")


if __name__ == "__main__":
    import uvicorn

    # app_dir/reload_dirs make this work from any cwd and keep the reloader from
    # watching frontend/node_modules. The graceful-shutdown timeout matters: an
    # open /api/oak/stream never ends on its own, so without it a reload hangs
    # forever on "Waiting for connections to close" whenever a browser is watching.
    uvicorn.run(
        "main:app",
        app_dir=str(BACKEND_DIR),
        reload_dirs=[str(BACKEND_DIR)],
        host="0.0.0.0",
        port=PORT,
        reload=True,
        timeout_graceful_shutdown=1,
    )
