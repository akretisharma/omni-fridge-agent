# Zip HTN staging client. Auth is Zip-Api-Key (not Bearer). Writes use {"data": ...}.
# Dashboard lists come from POST /requests (intake), not raw purchase orders.

from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx
from dotenv import load_dotenv


def _env_paths() -> list[Path]:
    here = Path(__file__).resolve().parent
    # Later files win. backend/.env must beat the repo-root .env.
    return [here.parent / ".env", here / ".env"]


def _read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        for raw in path.read_text().splitlines():
            line = raw.strip()
            if line.startswith("export "):
                line = line[7:].strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return values


def _first_real(*vals: str) -> str:
    for val in vals:
        if val and val != "REPLACE_ME":
            return val
    return ""


# Zip request status codes (from Zip's public API collection, "Search requests").
REQUEST_STATUS = {1: "awaiting approval", 2: "rejected", 3: "approved", 4: "canceled", 5: "closed", 6: "paused"}


def _env() -> dict[str, str]:
    merged: dict[str, str] = {}
    for path in _env_paths():
        load_dotenv(path, override=True)
        merged.update({k: v for k, v in _read_env_file(path).items() if v and v != "REPLACE_ME"})
    base = (
        merged.get("ZIP_API_URL")
        or os.getenv("ZIP_API_URL")
        or merged.get("ZIP_BASE_URL")
        or os.getenv("ZIP_BASE_URL")
        or "https://staging-api.zip.com"
    )
    key = _first_real(merged.get("ZIP_API_KEY", ""), os.getenv("ZIP_API_KEY") or "")
    return {
        "base_url": base.rstrip("/"),
        "api_key": key,
        "api_version": merged.get("ZIP_API_VERSION") or os.getenv("ZIP_API_VERSION") or "2024-06-06",
        "currency": merged.get("ZIP_CURRENCY") or os.getenv("ZIP_CURRENCY") or "USD",
        "vendor_name": merged.get("ZIP_VENDOR_NAME") or os.getenv("ZIP_VENDOR_NAME") or "Loblaws",
        "hardware_vendor_name": merged.get("ZIP_HARDWARE_VENDOR_NAME")
        or os.getenv("ZIP_HARDWARE_VENDOR_NAME")
        or "MLH",
        "workflow_name": merged.get("ZIP_WORKFLOW_NAME")
        or os.getenv("ZIP_WORKFLOW_NAME")
        or "[Do not EDIT] Basic Request a Purchase",
        "subsidiary_name": merged.get("ZIP_SUBSIDIARY_NAME")
        or os.getenv("ZIP_SUBSIDIARY_NAME")
        or "Zip - Modern Spend Approvals",
        "requester_email": merged.get("ZIP_REQUESTER_EMAIL") or os.getenv("ZIP_REQUESTER_EMAIL") or "",
    }


def _headers(cfg: dict[str, str]) -> dict[str, str]:
    return {
        "Zip-Api-Key": cfg["api_key"],
        "Zip-Api-Version": cfg["api_version"],
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _unwrap(body: Any) -> Any:
    if isinstance(body, dict):
        if "list" in body:
            return body["list"]
        if "data" in body:
            return body["data"]
        if "objects" in body:
            return body["objects"]
    return body


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for key in ("list", "items", "results", "data", "objects"):
            inner = value.get(key)
            if isinstance(inner, list):
                return inner
        return [value]
    return []


def _name_of(obj: Any) -> str:
    if not isinstance(obj, dict):
        return str(obj or "")
    for key in ("name", "display_name", "legal_name", "title", "email"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _id_of(obj: Any) -> Optional[str]:
    if not isinstance(obj, dict):
        return None
    for key in ("id", "guid", "uuid"):
        val = obj.get(key)
        if isinstance(val, str) and val:
            return val
    return None


class ZipClient:
    def __init__(self) -> None:
        self.cfg = _env()
        if not self.cfg["api_key"] or self.cfg["api_key"] == "REPLACE_ME":
            looked = ", ".join(str(p) for p in _env_paths())
            raise RuntimeError(
                "ZIP_API_KEY is not set. Save backend/.env (Cmd+S) — the file on disk still has "
                f"REPLACE_ME. Looked in: {looked}"
            )
        self._http = httpx.AsyncClient(base_url=self.cfg["base_url"], headers=_headers(self.cfg), timeout=60)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _get(self, path: str, params: Optional[dict] = None) -> Any:
        res = await self._http.get(path, params={k: v for k, v in (params or {}).items() if v is not None})
        if res.status_code >= 400:
            raise RuntimeError(f"Zip GET {path} failed ({res.status_code}): {res.text[:800]}")
        try:
            return res.json()
        except Exception:
            return {"raw": res.text}

    async def _post(self, path: str, data: Any) -> Any:
        res = await self._http.post(path, json={"data": data})
        if res.status_code >= 400:
            raise RuntimeError(f"Zip POST {path} failed ({res.status_code}): {res.text[:800]}")
        try:
            return res.json()
        except Exception:
            return {"raw": res.text}

    async def named_entity(self, path: str, name: str) -> Optional[dict]:
        body = await self._get(path, {"page_size": 50})
        needle = name.lower()
        for item in _as_list(_unwrap(body)):
            if isinstance(item, dict) and needle in _name_of(item).lower():
                return item
        return None

    def vendor_name_for(self, mode: str) -> str:
        return self.cfg["hardware_vendor_name"] if mode == "hardware" else self.cfg["vendor_name"]

    async def pick_vendor(self, mode: str = "food") -> dict:
        body = await self._get("/vendors", {"page_size": 50})
        vendors = [v for v in _as_list(_unwrap(body)) if isinstance(v, dict)]
        if not vendors:
            raise RuntimeError("No Zip vendors on this company. Add one in the Zip dashboard or use the HTN shared vendors.")
        needle = self.vendor_name_for(mode).lower()
        match = next((v for v in vendors if needle in _name_of(v).lower()), None)
        match = match or next((v for v in vendors if v.get("status") != 5), vendors[0])
        vid = _id_of(match)
        if not vid:
            raise RuntimeError(f"Zip vendor '{_name_of(match)}' has no id")
        if match.get("status") in (5, "5"):
            res = await self._http.patch(f"/vendors/{vid}", json={"data": {"status": 1}})
            if res.status_code >= 400:
                raise RuntimeError(f"Could not activate vendor '{_name_of(match)}' ({res.status_code})")
        return match

    async def resolve_vendor(self, item: dict) -> dict:
        """The catalog already picked the cheaper vendor; honour it.

        Food quotes from the seeded catalog carry the winning vendor, so the
        request goes wherever the basket said it would. Anything without one
        (hardware, OMNI estimates) falls back to the mode default.
        """
        vid = item.get("vendor_id")
        if vid:
            return {"id": vid, "name": item.get("vendor") or ""}
        return await self.pick_vendor(item.get("mode") or "food")

    async def pick_requester_id(self) -> Optional[str]:
        email = (self.cfg["requester_email"] or "").lower()
        try:
            body = await self._get("/users", {"page_size": 50})
        except RuntimeError:
            return None
        users = [u for u in _as_list(_unwrap(body)) if isinstance(u, dict)]
        if email:
            hit = next((u for u in users if email in str(u.get("email") or "").lower()), None)
            if hit:
                return _id_of(hit)
        return _id_of(users[0]) if users else None

    def _priced(self, item: dict) -> dict:
        name = (item.get("name") or "item").replace("_", " ")
        product = item.get("product") or name
        raw_rate = item.get("rate")
        try:
            rate = f"{max(0.01, float(raw_rate)):.2f}" if raw_rate not in (None, "") else "3.99"
        except (TypeError, ValueError):
            rate = "3.99"
        return {"product": product, "rate": rate}

    def _sourcing(self, item: dict, vendor: dict, rate: str) -> str:
        """Where it is coming from, e.g. Walmart WMT-EGGS at $4.27."""
        bits = " ".join(p for p in (_name_of(vendor), item.get("sku")) if p)
        return f" {bits} at ${rate}." if bits else ""

    async def create_request(self, item: dict, vendor: Optional[dict] = None) -> dict:
        workflow = await self.named_entity("/workflows", self.cfg["workflow_name"])
        workflow_id = _id_of(workflow) if workflow else None
        if not workflow_id:
            raise RuntimeError(
                f"Zip workflow '{self.cfg['workflow_name']}' not found. "
                "Open the same Zip company as this API key and check the workflow name."
            )
        mode = item.get("mode") or "food"
        vendor = vendor or await self.resolve_vendor(item)
        subsidiary = await self.named_entity("/subsidiaries", self.cfg["subsidiary_name"])
        qty = item.get("quantity") or 1
        unit = item.get("unit") or "unit"
        name = item.get("name") or "item"
        goal = (item.get("goal") or "").strip() or "the current task"
        priced = self._priced(item)
        recipe = goal.replace("_", " ").strip()
        recipe = recipe[:1].upper() + recipe[1:] if recipe else ("Hardware order" if mode == "hardware" else "Fridge restock")
        if mode == "hardware":
            desc = (
                f"OMNI Hardware Agent: need {qty} {unit} of {name} for the build \"{recipe}\". "
                f"Typical SKU: {priced['product']} at ${priced['rate']}."
            )
        else:
            sourcing = self._sourcing(item, vendor, priced["rate"]) or f" ${priced['rate']}."
            desc = (
                f"OMNI Fridge Agent — missing {qty} {unit} of {name} for \"{recipe}\". "
                f"Store pack: {priced['product']},{sourcing}"
            )
        payload = {
            "workflow_id": workflow_id,
            "currency": self.cfg["currency"],
            "name": f"{recipe}: {priced['product']}",
            "description": desc,
            "total_amount": priced["rate"],
            "vendor_id": _id_of(vendor),
        }
        sub_id = _id_of(subsidiary) if subsidiary else None
        if sub_id:
            payload["subsidiary_id"] = sub_id
        requester_id = await self.pick_requester_id()
        if requester_id:
            payload["requester_id"] = requester_id
        return await self._post("/requests", payload)

    async def create_purchase_order(self, item: dict, vendor: dict) -> dict:
        qty = item.get("quantity") or 1
        unit = item.get("unit") or "unit"
        name = item.get("name") or "item"
        goal = item.get("goal") or "the current task"
        priced = self._priced(item)
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:24] or "item"
        po_number = f"OMNI-{slug}-{uuid.uuid4().hex[:6].upper()}"
        payload = {"vendor_id": _id_of(vendor), "currency": self.cfg["currency"], "po_number": po_number}
        try:
            raw = await self._post("/purchase_orders", payload)
        except RuntimeError:
            payload.pop("po_number", None)
            raw = await self._post("/purchase_orders", payload)
        po = _unwrap(raw)
        po = po if isinstance(po, dict) else {}
        po_id = _id_of(po)
        if po_id:
            if not po.get("po_number"):
                try:
                    updated = await self._http.patch(
                        f"/purchase_orders/update/{po_id}", json={"data": {"po_number": po_number}}
                    )
                    if updated.status_code < 400:
                        inner = _unwrap(updated.json())
                        if isinstance(inner, dict):
                            po = inner
                            raw = updated.json()
                except Exception:
                    pass
            line = {
                "line_type": 0,
                "description": f"{priced['product']} ({qty} {unit} of {name}) — missing for \"{goal}\"",
                "quantity": "1",
                "rate": priced["rate"],
            }
            await self._post(f"/purchase_orders/{po_id}/line_items", [line])
        if isinstance(raw, dict):
            raw = {**raw, "po_number": po.get("po_number") or po_number, "id": po_id}
        return raw if isinstance(raw, dict) else {"raw": raw, "po_number": po_number}

    async def purchase_item(self, item: dict) -> dict:
        vendor = await self.resolve_vendor(item)
        kind = "request"
        try:
            raw = await self.create_request(item, vendor)
        except RuntimeError as err:
            msg = str(err)
            if "405" not in msg and "Method not supported" not in msg:
                raise
            kind = "purchase_order"
            raw = await self.create_purchase_order(item, vendor)

        entity = _unwrap(raw)
        entity = entity if isinstance(entity, dict) else {}
        status = entity.get("status") or entity.get("state") or "submitted"
        if isinstance(status, int):
            status = REQUEST_STATUS.get(status, str(status))
        if not status or status == "none":
            status = "submitted"
        po_number = entity.get("po_number") or (raw.get("po_number") if isinstance(raw, dict) else None)
        return {
            "name": item.get("name"),
            "status": str(status).lower() if isinstance(status, str) else "submitted",
            "kind": kind,
            "vendor": _name_of(vendor) or self.vendor_name_for(item.get("mode") or "food"),
            "request_id": _id_of(entity) if kind == "request" else None,
            "request_number": (
                entity.get("number") or entity.get("request_number") or entity.get("name")
                if kind == "request"
                else po_number
            ),
            "po_number": po_number,
            "amount": self._priced(item)["rate"],
            "product": self._priced(item)["product"],
            "raw": raw,
        }


async def call_zip(item: dict) -> dict:
    client = ZipClient()
    try:
        return await client.purchase_item(item)
    finally:
        await client.aclose()
