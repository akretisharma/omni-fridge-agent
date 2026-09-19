# main.py
#
# Backend for the "speak a goal -> OMNI checks inventory -> Zip buys what's
# missing" agent. Keeps API keys server-side (never ship them to the
# browser). Three real endpoints do the actual work:
#
#   POST /api/intent         audio or transcript -> {goal, ingredients[]}
#   POST /api/vision-check   fridge/cupboard photo + ingredients -> present/missing
#   POST /api/purchase       missing items -> Zip purchase requests + status
#   GET  /api/purchases      stored purchase history for the Purchases page
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
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from pydantic import BaseModel

load_dotenv()

OMNI_BASE_URL = os.getenv("OMNI_BASE_URL", "")
OMNI_API_KEY = os.getenv("OMNI_API_KEY", "")
OMNI_MODEL = os.getenv("OMNI_MODEL") or "qwen3.5-omni"
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
class IntentRequest(BaseModel):
    transcript: Optional[str] = None
    audioBase64: Optional[str] = None
    audioFormat: Optional[str] = None


class Ingredient(BaseModel):
    name: str
    quantity: Optional[float] = None
    unit: Optional[str] = None


class VisionCheckRequest(BaseModel):
    imageBase64: str
    ingredients: list[Ingredient]


class PurchaseRequest(BaseModel):
    items: list[Ingredient]
    goal: Optional[str] = None


# -------------------------------------------------------------------------
# OMNI call helper
# -------------------------------------------------------------------------
# ASSUMPTION: yibuapi exposes an OpenAI-compatible /v1/chat/completions
# endpoint, and accepts multimodal "content" arrays the way OpenAI's API
# does: [{type:"text", text}, {type:"image_url", image_url:{url}},
# {type:"input_audio", input_audio:{data, format}}].
#
# If the real docs differ (different path, different field names for audio
# or images), this is the only function you should need to edit. Everything
# upstream just builds a `messages` list and calls call_omni(messages).
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
# Body: { transcript?, audioBase64?, audioFormat? }
# Returns: { goal: str, ingredients: [{name, quantity, unit}] }
# -------------------------------------------------------------------------
INTENT_SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You are a kitchen/pantry assistant. The user will describe something "
        "they want to do (e.g. \"I'm baking a chocolate cake\" or \"I need to "
        "restock the printer supplies\"). Work out the concrete list of items "
        "needed to accomplish it. Respond with ONLY a JSON object of the form "
        '{"goal": "<short label>", "ingredients": [{"name": "<item>", '
        '"quantity": <number>, "unit": "<unit>"}]}. Keep the list to the items '
        "that matter for the demo (roughly 5-8 items). No prose, just JSON."
    ),
}


@app.post("/api/intent")
async def intent(body: IntentRequest):
    if body.audioBase64:
        # Primary path: send the raw audio to OMNI so speech/audio
        # understanding is genuinely happening inside OMNI, not a browser API.
        user_content = [
            {
                "type": "input_audio",
                "input_audio": {"data": body.audioBase64, "format": body.audioFormat or "webm"},
            }
        ]
    elif body.transcript:
        # Fallback path: browser SpeechRecognition already produced text.
        # Still a real OMNI call for the language-reasoning half of the task,
        # useful as a demo-safety net if live audio upload is flaky.
        user_content = [{"type": "text", "text": body.transcript}]
    else:
        raise HTTPException(400, "Provide transcript or audioBase64")

    return await _omni_or_500([INTENT_SYSTEM_PROMPT, {"role": "user", "content": user_content}])


# -------------------------------------------------------------------------
# POST /api/vision-check
# Body: { imageBase64: str, ingredients: [{name, quantity, unit}] }
# Returns: { present: [str], missing: [str] }
# -------------------------------------------------------------------------
VISION_SYSTEM_PROMPT = {
    "role": "system",
    "content": (
        "You are a vision system inspecting a photo of a fridge or cupboard. "
        "Given a photo and a checklist of ingredient names, decide which items "
        "are visibly present and which are not. Be reasonably strict - only "
        "mark something present if you can actually see it or its container. "
        'Respond with ONLY a JSON object: {"present": ["..."], "missing": ["..."]} '
        "using the exact item names from the checklist."
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
    return await _omni_or_500([VISION_SYSTEM_PROMPT, user_message])


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
