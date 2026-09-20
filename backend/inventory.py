"""MLH hardware-lab stock, used only in hardware mode.

backend/inventory_seed.json is the starting stock. The live counts are kept in
backend/data/inventory.json (copied from the seed on first use) so orders that
take parts out of stock survive a server restart.

Items with source "special" (special-request gear) can't be requested through the
form, so they are never offered or reserved. Makerspace items can be ordered.
"""

import json
import math
import re
import shutil
import threading
from pathlib import Path
from typing import Optional

BACKEND_DIR = Path(__file__).parent
SEED_FILE = BACKEND_DIR / "inventory_seed.json"
STOCK_FILE = BACKEND_DIR / "data" / "inventory.json"

_lock = threading.Lock()


def _load() -> list[dict]:
    if not STOCK_FILE.exists():
        STOCK_FILE.parent.mkdir(exist_ok=True)
        shutil.copyfile(SEED_FILE, STOCK_FILE)
    items = json.loads(STOCK_FILE.read_text())
    # Items added to the seed later show up in an existing stock file too.
    known = {i["name"] for i in items}
    added = [i for i in json.loads(SEED_FILE.read_text()) if i["name"] not in known]
    if added:
        items = sorted(items + added, key=lambda i: i["name"].lower())
        _save(items)
    return items


def _save(items: list[dict]) -> None:
    STOCK_FILE.write_text(json.dumps(items, indent=1))


def _stem(word: str) -> str:
    if word.isdigit() or len(word) <= 3:
        return word
    if word.endswith("ies"):
        return word[:-3] + "y"
    return word[:-1] if word.endswith("s") and not word.endswith("ss") else word


def _tokens(name: str) -> set[str]:
    spaced = re.sub(r"(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)", " ", name.lower())  # "32GB" -> "32 gb"
    return {_stem(w) for w in re.sub(r"[^a-z0-9]+", " ", spaced).split()}


def orderable(item: dict) -> bool:
    return item.get("source") != "special"


# Common names the model uses for parts the lab stocks under another name. Only
# tried when the name isn't a direct match.
ALIASES = [
    (r"breadboard", "Full-Size Breadboards"),
    (r"jumper", "Jumper Wires (Male-to-Male)"),
    (r"hc-?sr\s?04|ultrasonic", "Ultrasonic Distance Sensor"),
    (r"l298|motor driv|motor controller|h-?bridge", "Motor Drive Module"),
    (r"9\s?v.*batter|batter.*9\s?v", "9V Batteries"),
    (r"chassis", "Plastic Chassis Kit"),
    (r"servo", "Micro Servos"),
    (r"wheel", "Robot Wheels"),
    (r"usb.*power supply|power supply.*usb|usb.*adapter.*power|usb.*charger", "12.5 W Micro USB Power Supply"),
]


def _by_name(pool: list[dict], name: str) -> Optional[dict]:
    return next((i for i in pool if i["name"].lower() == name.lower()), None)


def _match(items: list[dict], name: str) -> Optional[dict]:
    """Find the catalog item for a name the model or user used: exact name, then the
    longest catalog name whose words all appear in it ("Raspberry Pi Camera Module v2"),
    then a known alias, then the closest name by shared rare words."""
    want = name.strip().lower()
    pool = [i for i in items if orderable(i)]
    exact = _by_name(pool, name)
    if exact:
        return exact
    words = _tokens(name)
    hits = [i for i in pool if _tokens(i["name"]) <= words]
    if hits:
        return max(hits, key=lambda i: len(_tokens(i["name"])))
    for pattern, target in ALIASES:
        if re.search(pattern, want):
            found = _by_name(pool, target)
            if found:
                return found
    # Weighted Dice over words; rare words count more, words the catalog never uses are ignored.
    freq: dict[str, int] = {}
    for i in pool:
        for w in _tokens(i["name"]):
            freq[w] = freq.get(w, 0) + 1
    weight = lambda w: math.log(1 + len(pool) / freq[w])
    query = {w for w in words if w in freq}
    if not query:
        return None
    best, best_score = None, 0.0
    for i in pool:
        cand = _tokens(i["name"])
        shared = sum(weight(w) for w in query & cand)
        score = 2 * shared / (sum(weight(w) for w in query) + sum(weight(w) for w in cand))
        if score > best_score:
            best, best_score = i, score
    return best if best_score >= 0.6 else None


def catalog_names() -> list[str]:
    """Every orderable part's name, with no stock counts (so the model can't tell what's short)."""
    with _lock:
        return [i["name"] for i in _load() if orderable(i)]


def list_items() -> list[dict]:
    with _lock:
        return _load()


def find(name: str) -> Optional[dict]:
    with _lock:
        return _match(_load(), name)


def need(quantity) -> int:
    try:
        return max(1, math.ceil(float(quantity)))
    except (TypeError, ValueError):
        return 1


def reserve_all(lines: list[tuple[str, object]]) -> tuple[list[dict], list[dict]]:
    """All-or-nothing checkout. `lines` is [(name, quantity)]. If every line can be
    covered, takes them all out of stock and returns (matched items, []). Otherwise
    changes nothing and returns ([], problems) with one {name, reason} per short line."""
    with _lock:
        items = _load()
        matched, problems, wanted = [], [], {}
        for name, quantity in lines:
            item = _match(items, name)
            if not item:
                problems.append({"name": name, "reason": f"{name} is not in the MLH inventory"})
                continue
            matched.append(item)
            wanted[item["name"]] = wanted.get(item["name"], 0) + need(quantity)
        for item in {m["name"]: m for m in matched}.values():
            have, want = item["available"], wanted[item["name"]]
            if have <= 0:
                problems.append({"name": item["name"], "reason": f"{item['name']} is out of stock"})
            elif have < want:
                problems.append({"name": item["name"], "reason": f"Only {have} {item['name']} left, but you need {want}"})
        if problems:
            return [], problems
        for item in items:
            if item["name"] in wanted:
                item["available"] -= wanted[item["name"]]
        _save(items)
        left = {i["name"]: i["available"] for i in items}
        return [{"name": m["name"], "remaining": left[m["name"]]} for m in matched], []


def release(name: str, quantity) -> None:
    """Put back a reservation (e.g. the Zip request failed)."""
    qty = need(quantity)
    with _lock:
        items = _load()
        item = _match(items, name)
        if item:
            item["available"] += qty
            _save(items)


def reset() -> list[dict]:
    with _lock:
        shutil.copyfile(SEED_FILE, STOCK_FILE)
        return _load()
