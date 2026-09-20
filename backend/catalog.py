"""Answers "which pack would we buy for this name, and where is it cheapest?".

Reads catalog.json, the ledger of products and vendor items that
catalog_seed.py created in Zip. Food mode prices from here first and only falls
back to an OMNI guess for names the catalog has never heard of.

Matching has to be forgiving: OMNI names ingredients however it likes ("eggs",
"large eggs", "2 whole eggs"), so each entry carries aliases and anything still
unmatched goes through difflib.
"""

from __future__ import annotations

import json
import re
from difflib import get_close_matches
from pathlib import Path
from typing import Optional

CATALOG_PATH = Path(__file__).parent / "catalog.json"

# Words that describe the amount rather than the thing, so "2 cups of flour"
# and "flour" match the same entry.
_NOISE = {
    "a", "an", "the", "of", "some", "fresh", "whole", "large", "small", "medium",
    "cup", "cups", "tbsp", "tsp", "tablespoon", "tablespoons", "teaspoon",
    "teaspoons", "oz", "ounce", "ounces", "lb", "lbs", "pound", "pounds", "g",
    "gram", "grams", "kg", "ml", "l", "litre", "liter", "can", "cans", "bag",
    "bags", "packet", "pack", "bottle", "slice", "slices", "clove", "cloves",
    "head", "bunch",
}


def normalize(name: str) -> str:
    """Strips quantities and packaging words: "2 cups of All-Purpose Flour" -> "all purpose flour"."""
    words = [w for w in re.split(r"[^a-z0-9%]+", (name or "").lower()) if w and not w.isdigit()]
    kept = [w for w in words if w not in _NOISE] or words
    return " ".join(kept)


def _variants(text: str) -> set[str]:
    """Singular/plural both, so "lime" finds the "limes" entry and vice versa."""
    out = {text}
    if text.endswith("es"):
        out.add(text[:-2])
    if text.endswith("s"):
        out.add(text[:-1])
    else:
        out.update({text + "s", text + "es"})
    return {v for v in out if v}


class Catalog:
    def __init__(self, path: Path = CATALOG_PATH) -> None:
        self.path = path
        self._mtime: Optional[float] = None
        self.entries: dict[str, dict] = {}
        self.index: dict[str, str] = {}  # normalized name/alias -> entry key
        self.load()

    def load(self) -> None:
        try:
            self.entries = json.loads(self.path.read_text())
            self._mtime = self.path.stat().st_mtime
        except (FileNotFoundError, json.JSONDecodeError):
            self.entries = {}
            self._mtime = None
        self.index = {}
        for key, entry in self.entries.items():
            for label in [key, entry.get("pack", ""), *entry.get("aliases", [])]:
                norm = normalize(label)
                if not norm:
                    continue
                for variant in _variants(norm):
                    self.index.setdefault(variant, key)

    def _reload_if_changed(self) -> None:
        # The seed script can add entries while the server is running.
        try:
            mtime = self.path.stat().st_mtime
        except FileNotFoundError:
            return
        if mtime != self._mtime:
            self.load()

    def match(self, name: str) -> Optional[str]:
        self._reload_if_changed()
        norm = normalize(name)
        if not norm or not self.index:
            return None
        for variant in _variants(norm):
            if variant in self.index:
                return self.index[variant]
        # "chocolate chips" should still reach the chocolate entry, but a short
        # alias must not swallow a different ingredient: "oil" appears inside
        # "truffle oil", which is not canola oil, so require the overlap to be
        # most of the name rather than any substring at all.
        contained = [
            label
            for label in self.index
            if (label in norm or norm in label) and min(len(label), len(norm)) / max(len(label), len(norm)) >= 0.4
        ]
        if contained:
            return self.index[min(contained, key=len)]
        close = get_close_matches(norm, list(self.index), n=1, cutoff=0.82)
        return self.index[close[0]] if close else None

    def quote(self, name: str) -> Optional[dict]:
        """Cheapest offer for a name, shaped like an /api/prices quote."""
        key = self.match(name)
        entry = self.entries.get(key) if key else None
        offers = sorted(entry.get("offers", []), key=lambda o: float(o["rate"])) if entry else []
        if not offers:
            return None
        best = offers[0]
        return {
            "product": entry["pack"],
            "rate": best["rate"],
            "vendor": best["vendor"],
            "vendor_id": best["vendor_id"],
            "vendor_item_id": best["vendor_item_id"],
            "sku": best["sku"],
            "source": "catalog",
        }


catalog = Catalog()
