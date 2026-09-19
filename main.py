# main.py
#
# Backend for the "speak a goal -> OMNI checks inventory -> Zip buys what's
# missing" agent. Keeps API keys server-side (never ship them to the
# browser). Three real endpoints do the actual work:
#
#   POST /api/intent         voice request (+ camera frame + state) -> action + reply
#   POST /api/vision-check   camera frame + checklist -> visible/present/missing
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
from typing import Any, Optional

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

load_dotenv()

OMNI_BASE_URL = (os.getenv("OMNI_BASE_URL") or "https://yibuapi.com").rstrip("/")
OMNI_API_KEY = os.getenv("OMNI_API_KEY", "")
OMNI_MODEL = os.getenv("OMNI_MODEL") or "qwen3.5-omni-flash"
ZIP_BASE_URL = os.getenv("ZIP_BASE_URL", "")
ZIP_API_KEY = os.getenv("ZIP_API_KEY", "")
PORT = int(os.getenv("PORT", "3000"))

FRONTEND_DIST = Path(__file__).parent / "frontend" / "dist"
PURCHASES_FILE = Path(__file__).parent / "data" / "purchases.json"

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


class VisionCheckRequest(BaseModel):
    imageBase64: str
    ingredients: list[Ingredient] = []  # empty checklist = just describe what's visible


class PurchaseRequest(BaseModel):
    items: list[Ingredient]
    goal: Optional[str] = None


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
        raise RuntimeError("OMNI_API_KEY is not set - copy .env.example to .env and fill it in")

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


# -------------------------------------------------------------------------
# Zip call helper
# -------------------------------------------------------------------------
# ASSUMPTION: standard REST resource - POST /purchase-requests creates a
# request that Zip's own approval/budget rules then route automatically.
# Swap in the real path + payload shape from Zip's REST docs / Postman
# collection for the company they set up for you. The Zip MCP server is an
# alternative to this REST call if you'd rather demo the MCP integration -
# see README.md for notes on that path.
async def call_zip(item: dict) -> dict:
    if not ZIP_API_KEY or ZIP_API_KEY == "REPLACE_ME":
        raise RuntimeError("ZIP_API_KEY is not set - copy .env.example to .env and fill it in")

    async with httpx.AsyncClient(timeout=60) as client:
        res = await client.post(
            f"{ZIP_BASE_URL}/v1/purchase-requests",
            headers={"Authorization": f"Bearer {ZIP_API_KEY}"},
            json={
                "description": item["name"],
                "quantity": item.get("quantity") or 1,
                "unit": item.get("unit") or "unit",
                "justification": (
                    "Auto-requested by OMNI Fridge Agent: missing ingredient for "
                    f'"{item.get("goal") or "the current task"}"'
                ),
            },
        )

    if res.status_code >= 400:
        raise RuntimeError(f"Zip call failed ({res.status_code}): {res.text}")

    return res.json()


# -------------------------------------------------------------------------
# POST /api/intent
# Body: { audioBase64? | transcript?, audioFormat?, imageBase64?, + app state
#         (goal, ingredients, present, missing, skipped, visible) }
# Returns: { transcript, action, reply, goal, ingredients, items }
#   action: set_goal | skip_items | unskip_items | answer
# -------------------------------------------------------------------------
INTENT_SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You are OMNI, a voice assistant built into a smart fridge/cupboard camera. "
        "The user speaks to you at any time. You receive their request (audio or "
        "text), the latest camera frame, and the app's current state as JSON. Use "
        "all three together. Decide what the user wants and respond with ONLY a "
        "JSON object:\n"
        '{"transcript": "<exact words the user said>", '
        '"action": "set_goal" | "skip_items" | "unskip_items" | "answer", '
        '"reply": "<1-2 short spoken sentences, natural, no markdown>", '
        '"goal": "<short label, set_goal only>", '
        '"ingredients": [{"name": "<item>", "quantity": <number>, "unit": "<unit>"}], '
        '"items": ["<item names, skip_items/unskip_items only>"]}\n'
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
}

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

    result = await _omni_or_500([INTENT_SYSTEM_PROMPT, {"role": "user", "content": content}])
    return _normalize_intent(result, body.transcript or "")


# -------------------------------------------------------------------------
# POST /api/vision-check
# Body: { imageBase64: str, ingredients?: [{name, quantity, unit}] }
# Returns: { visible: [str], present: [str], missing: [str] }
# Called continuously by the frontend (one frame every few seconds).
# -------------------------------------------------------------------------
VISION_SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You are a vision system watching a live camera feed of a fridge or cupboard. "
        "Given one frame and an optional checklist, report (a) every distinct food or "
        "household item you can clearly see, and (b) which checklist items are "
        "visibly present versus not. Be reasonably strict - only mark something "
        "present if you can actually see it or its container. Respond with ONLY a "
        'JSON object: {"visible": ["..."], "present": ["..."], "missing": ["..."]}. '
        "present and missing must use the exact item names from the checklist "
        "(both empty if the checklist is empty)."
    ),
}


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
    result = await _omni_or_500([VISION_SYSTEM_PROMPT, user_message])
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
# POST /api/purchase
# Body: { items: [{name, quantity, unit}], goal?: str }
# Returns: { results: [{name, status, raw}] }
# -------------------------------------------------------------------------
@app.post("/api/purchase")
async def purchase(body: PurchaseRequest):
    if not body.items:
        raise HTTPException(400, "items[] is required")

    results = []
    for item in body.items:
        try:
            raw = await call_zip({**item.model_dump(), "goal": body.goal})
            results.append(
                {"name": item.name, "status": raw.get("status") or raw.get("state") or "submitted", "raw": raw}
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
            "name": item.name,
            "quantity": item.quantity,
            "unit": item.unit,
            "status": r["status"],
            "error": r.get("error"),
            "raw": r.get("raw"),
        }
        for item, r in zip(body.items, results)
    ]
    _save_purchases(records + _load_purchases())

    return {"results": results}


# -------------------------------------------------------------------------
# GET /api/purchases
# Returns: { purchases: [{id, createdAt, goal, name, quantity, unit, status, error, raw}] }
# Newest first. Persisted to data/purchases.json so a server restart keeps them.
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

    uvicorn.run("main:app", host="0.0.0.0", port=PORT, reload=True)
