"""Seeds the grocery catalog into Zip as products priced at all four vendors.

Food mode prices from this catalog instead of asking OMNI to guess, so the
basket shows a real pack at a real price and orders from whichever of Loblaws,
Metro, Walmart and Costco is cheapest for that item.

Re-runnable, and it has to be: Zip exposes no way to list products or vendor
items (GET needs explicit guids) and no way to delete them, so anything created
twice is stuck there forever. Every id we create is recorded in catalog.json and
re-runs skip whatever is already in it.

    python backend/catalog_seed.py --dry-run     # show what would be created
    python backend/catalog_seed.py               # create the missing items
    python backend/catalog_seed.py --refresh-prices   # push edited prices to Zip
    python backend/catalog_seed.py --vendor Costco    # one vendor only

Hardware/MLH is deliberately not part of this: that mode keeps using OMNI
estimates.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import re
from pathlib import Path
from typing import Optional

from zip_client import ZipClient, _as_list, _id_of, _name_of, _unwrap


LEDGER_PATH = Path(__file__).parent / "catalog.json"

# Not under data/ on purpose: that directory is gitignored, and the team shares
# one Zip company, so an uncommitted ledger means the next person to run this
# creates a second copy of every item.

VENDORS = ("Loblaws", "Metro", "Walmart", "Costco")

VENDOR_SKU_PREFIX = {"Loblaws": "LOB", "Metro": "MET", "Walmart": "WMT", "Costco": "CST"}

# How each vendor prices against the item's reference price. The bands overlap,
# so the discounters win most items but not all of them — which is the point,
# the basket has to actually compare rather than always pick one store.
VENDOR_BAND = {
    "Loblaws": (0.88, 1.08),
    "Metro": (0.89, 1.10),
    "Walmart": (0.85, 1.01),
    "Costco": (0.83, 1.03),
}


def item(name: str, pack: str, unit: str, base: float, *aliases: str) -> dict:
    """One catalog staple. `base` is its typical shelf price before vendor spread."""
    return {"name": name, "pack": pack, "unit": unit, "base": base, "aliases": list(aliases)}


# Wide on purpose: every name the catalog knows is a name OMNI does not have to
# guess a price for. Ordered roughly by aisle.
CATALOG: list[dict] = [
    # Baking
    item("flour", "All-purpose flour, 5 lb bag", "cups", 6.49, "all purpose flour", "ap flour", "white flour", "plain flour"),
    item("sugar", "Granulated white sugar, 2 kg", "cups", 4.99, "white sugar", "granulated sugar", "caster sugar"),
    item("brown sugar", "Golden brown sugar, 1 kg", "cups", 3.99, "light brown sugar", "dark brown sugar"),
    item("powdered sugar", "Icing sugar, 1 kg", "cups", 3.99, "icing sugar", "confectioners sugar"),
    item("baking powder", "Baking powder, 225 g", "tsp", 4.29),
    item("baking soda", "Baking soda, 500 g", "tsp", 2.49, "bicarbonate of soda"),
    item("yeast", "Instant dry yeast, 3 x 8 g", "packets", 2.49, "active dry yeast", "instant yeast"),
    item("cornstarch", "Corn starch, 454 g", "tbsp", 3.49, "corn starch", "cornflour"),
    item("vanilla extract", "Pure vanilla extract, 100 ml", "tsp", 8.99, "vanilla", "vanilla essence"),
    item("cocoa powder", "Unsweetened cocoa powder, 250 g", "cups", 7.49, "cocoa", "unsweetened cocoa", "cacao powder"),
    item("dark chocolate", "Dark chocolate baking bar, 200 g", "g", 5.99, "chocolate", "baking chocolate", "chocolate chips", "semi sweet chocolate"),
    item("marshmallows", "Mini marshmallows, 250 g", "cups", 3.29, "mini marshmallows"),
    item("condensed milk", "Sweetened condensed milk, 300 ml", "cans", 3.49, "sweetened condensed milk"),
    # Dairy and eggs
    item("eggs", "Large eggs, dozen", "whole", 5.49, "egg", "large eggs", "dozen eggs"),
    item("milk", "2% milk, 4 L", "cups", 6.29, "2% milk", "whole milk", "dairy milk"),
    item("butter", "Salted butter, 454 g", "tbsp", 7.49, "salted butter", "unsalted butter"),
    item("heavy cream", "Whipping cream 35%, 473 ml", "cups", 5.49, "whipping cream", "double cream", "35% cream"),
    item("sour cream", "Sour cream, 500 ml", "cups", 4.49, "crema"),
    item("yogurt", "Plain Greek yogurt, 750 g", "cups", 6.49, "greek yogurt", "plain yogurt"),
    item("cream cheese", "Cream cheese brick, 250 g", "g", 5.49, "philadelphia"),
    item("cheddar cheese", "Shredded cheddar cheese, 320 g", "cups", 7.49, "cheese", "shredded cheese", "cheddar", "grated cheese"),
    item("mozzarella", "Shredded mozzarella, 320 g", "cups", 7.49, "mozzarella cheese", "pizza cheese"),
    item("parmesan", "Grated parmesan, 250 g", "cups", 8.49, "parmigiano", "parmesan cheese"),
    item("ice cream", "Vanilla ice cream, 1.5 L", "cups", 6.99, "vanilla ice cream"),
    # Meat and fish
    item("ground beef", "Lean ground beef, 1 lb", "lb", 8.99, "beef", "minced beef", "hamburger meat", "mince"),
    item("chicken breast", "Boneless chicken breast, 1 kg", "lb", 15.99, "chicken", "chicken breasts", "boneless chicken"),
    item("sausages", "Italian sausages, 500 g", "whole", 7.99, "sausage", "italian sausage"),
    item("bacon", "Sliced bacon, 375 g", "slices", 8.49, "streaky bacon", "back bacon"),
    item("shrimp", "Frozen raw shrimp, 340 g", "whole", 12.99, "prawns", "raw shrimp"),
    item("salmon", "Atlantic salmon fillet, 340 g", "fillets", 13.99, "salmon fillet", "fresh salmon"),
    item("tofu", "Firm tofu, 454 g", "g", 3.99, "firm tofu", "bean curd"),
    # Bakery
    item("bread", "White sandwich bread, 675 g", "slices", 3.79, "sandwich bread", "white bread", "loaf"),
    item("hamburger buns", "Hamburger buns, 8 pack", "whole", 4.29, "burger buns", "buns"),
    item("bagels", "Plain bagels, 6 pack", "whole", 4.49, "bagel"),
    item("pita bread", "Greek pita bread, 6 pack", "whole", 4.49, "pita", "flatbread"),
    item("tortillas", "Flour tortillas, 10 pack", "whole", 4.99, "flour tortillas", "corn tortillas", "taco shells", "tortilla"),
    item("pizza dough", "Fresh pizza dough, 500 g", "g", 3.99, "dough", "pizza base"),
    # Dry goods
    item("pasta", "Spaghetti, 900 g", "g", 3.49, "spaghetti", "linguine", "penne", "fettuccine"),
    item("rice", "Long grain white rice, 2 kg", "cups", 8.99, "white rice", "basmati rice", "jasmine rice"),
    item("ramen noodles", "Instant ramen, 5 pack", "packets", 4.29, "ramen", "instant noodles"),
    item("oats", "Large flake oats, 1 kg", "cups", 5.49, "rolled oats", "oatmeal", "porridge oats"),
    item("cereal", "Breakfast cereal, 525 g", "cups", 6.49, "corn flakes", "breakfast cereal"),
    item("almonds", "Whole almonds, 400 g", "cups", 8.99, "raw almonds"),
    item("tortilla chips", "Tortilla chips, 300 g", "cups", 4.49, "nachos", "corn chips"),
    # Cans and jars
    item("canned tomatoes", "Diced tomatoes, 796 ml can", "cans", 2.49, "diced tomatoes", "crushed tomatoes", "canned tomato"),
    item("tomato paste", "Tomato paste, 156 ml", "tbsp", 1.49),
    item("pasta sauce", "Marinara pasta sauce, 650 ml", "cups", 4.49, "marinara", "tomato sauce", "spaghetti sauce"),
    item("black beans", "Black beans, 540 ml can", "cans", 2.29, "canned black beans"),
    item("chickpeas", "Chickpeas, 540 ml can", "cans", 2.29, "garbanzo beans"),
    item("chicken broth", "Chicken broth, 900 ml", "cups", 3.49, "chicken stock", "broth", "stock"),
    item("coconut milk", "Coconut milk, 400 ml can", "cans", 2.79, "canned coconut milk"),
    item("salsa", "Medium salsa, 418 ml", "cups", 4.49, "tomato salsa"),
    item("pickles", "Dill pickles, 1 L", "whole", 4.99, "dill pickles", "gherkins"),
    item("olives", "Pitted green olives, 375 ml", "whole", 4.99, "green olives"),
    # Oils, sauces, spices
    item("vegetable oil", "Canola oil, 1 L", "tbsp", 5.49, "canola oil", "cooking oil", "oil", "sunflower oil"),
    item("olive oil", "Extra virgin olive oil, 1 L", "tbsp", 14.99, "evoo", "extra virgin olive oil"),
    item("sesame oil", "Toasted sesame oil, 250 ml", "tsp", 6.99, "toasted sesame oil"),
    item("soy sauce", "Soy sauce, 500 ml", "tbsp", 4.99, "light soy sauce"),
    item("rice vinegar", "Rice vinegar, 500 ml", "tbsp", 3.99, "vinegar", "white vinegar"),
    item("hot sauce", "Hot sauce, 148 ml", "tsp", 3.29, "sriracha", "tabasco", "chili sauce"),
    item("ketchup", "Tomato ketchup, 1 L", "tbsp", 5.49, "tomato ketchup"),
    item("mustard", "Yellow mustard, 400 ml", "tbsp", 3.49, "dijon mustard", "yellow mustard"),
    item("mayonnaise", "Mayonnaise, 890 ml", "tbsp", 6.99, "mayo"),
    item("honey", "Liquid honey, 500 g", "tbsp", 8.99, "liquid honey"),
    item("peanut butter", "Peanut butter, 1 kg", "tbsp", 6.49, "pb"),
    item("jam", "Strawberry jam, 500 ml", "tbsp", 4.99, "strawberry jam", "jelly", "preserves"),
    item("hazelnut spread", "Hazelnut chocolate spread, 725 g", "tbsp", 7.99, "nutella", "chocolate spread"),
    item("maple syrup", "Pure maple syrup, 500 ml", "tbsp", 12.99, "syrup", "pancake syrup"),
    item("simple syrup", "Simple syrup, 375 ml", "oz", 6.99, "sugar syrup", "gomme syrup"),
    item("curry paste", "Red curry paste, 114 g", "tbsp", 4.29, "thai curry paste"),
    item("taco seasoning", "Taco seasoning mix, 24 g", "packet", 2.49, "taco spice", "taco mix"),
    item("salt", "Table salt, 1 kg", "tsp", 2.29, "table salt", "kosher salt", "sea salt"),
    item("black pepper", "Ground black pepper, 100 g", "tsp", 5.49, "pepper", "peppercorns", "ground pepper"),
    item("cinnamon", "Ground cinnamon, 95 g", "tsp", 4.29, "ground cinnamon"),
    item("paprika", "Ground paprika, 100 g", "tsp", 4.49, "smoked paprika"),
    item("chili powder", "Chili powder, 90 g", "tsp", 4.29, "chilli powder"),
    item("cumin", "Ground cumin, 100 g", "tsp", 4.99, "ground cumin"),
    item("oregano", "Dried oregano, 28 g", "tsp", 3.49, "dried oregano"),
    # Produce
    item("lettuce", "Iceberg lettuce, 1 head", "cups", 3.49, "iceberg lettuce", "romaine", "salad greens"),
    item("spinach", "Baby spinach, 312 g", "cups", 5.49, "baby spinach"),
    item("tomatoes", "Roma tomatoes, 1 lb", "whole", 4.29, "tomato", "roma tomatoes", "plum tomatoes"),
    item("onions", "Yellow onions, 2 lb bag", "whole", 3.99, "onion", "yellow onion", "white onion"),
    item("green onions", "Green onions, 1 bunch", "whole", 2.29, "scallions", "spring onions"),
    item("garlic", "Garlic bulbs, 3 pack", "cloves", 2.99, "garlic cloves", "fresh garlic"),
    item("ginger", "Fresh ginger root, 200 g", "tbsp", 2.99, "ginger root", "fresh ginger"),
    item("potatoes", "Yellow potatoes, 5 lb bag", "whole", 6.49, "potato", "russet potatoes"),
    item("carrots", "Carrots, 2 lb bag", "whole", 3.49, "carrot", "baby carrots"),
    item("celery", "Celery, 1 bunch", "stalks", 3.99, "celery stalks"),
    item("bell peppers", "Bell peppers, 3 pack", "whole", 5.99, "red pepper", "green pepper", "sweet pepper", "bell pepper"),
    item("jalapenos", "Jalapeño peppers, 3 pack", "whole", 2.49, "jalapeno", "chili peppers", "hot peppers"),
    item("mushrooms", "White mushrooms, 227 g", "cups", 3.49, "white mushrooms", "cremini"),
    item("broccoli", "Broccoli crown, 1 head", "cups", 3.49, "broccoli crown"),
    item("avocados", "Avocados, 4 pack", "whole", 6.49, "avocado"),
    item("limes", "Limes, 4 pack", "whole", 3.49, "lime", "lime juice", "fresh lime"),
    item("lemons", "Lemons, 4 pack", "whole", 3.99, "lemon", "lemon juice"),
    item("apples", "Gala apples, 3 lb bag", "whole", 6.49, "apple", "gala apples"),
    item("bananas", "Bananas, 1 bunch", "whole", 2.49, "banana"),
    item("oranges", "Navel oranges, 4 lb bag", "whole", 7.49, "orange", "navel oranges"),
    item("strawberries", "Strawberries, 454 g", "cups", 5.99, "strawberry", "fresh strawberries"),
    item("blueberries", "Blueberries, 340 g", "cups", 5.49, "blueberry", "fresh blueberries"),
    item("cilantro", "Fresh cilantro, 1 bunch", "cups", 2.49, "coriander", "fresh cilantro"),
    item("basil", "Fresh basil, 1 pack", "leaves", 3.99, "fresh basil"),
    item("mint", "Fresh mint, 1 pack", "leaves", 3.49, "fresh mint", "mint leaves"),
    item("frozen corn", "Frozen corn kernels, 750 g", "cups", 3.99, "corn", "corn kernels"),
    item("frozen peas", "Frozen green peas, 750 g", "cups", 3.99, "peas", "green peas"),
    # Drinks
    item("coffee", "Ground coffee, 875 g", "cups", 16.99, "ground coffee"),
    item("tea", "Orange pekoe tea, 72 bags", "bags", 5.49, "tea bags", "black tea"),
    item("orange juice", "Orange juice, 1.75 L", "cups", 5.49, "oj", "juice"),
    item("cranberry juice", "Cranberry cocktail, 1.89 L", "cups", 5.49, "cranberry cocktail"),
    item("coca-cola", "Coca-Cola, 12 x 355 ml cans", "cans", 9.99, "coke", "cola", "coca cola", "soda"),
    item("lemon-lime soda", "Lemon-lime soda, 12 x 355 ml", "cans", 9.99, "sprite", "7up", "lemon lime soda"),
    item("sparkling water", "Sparkling water, 12 x 355 ml", "cans", 6.99, "club soda", "soda water", "seltzer"),
    item("tonic water", "Tonic water, 4 x 250 ml", "cans", 4.99, "tonic"),
    item("ginger beer", "Ginger beer, 4 x 330 ml", "cans", 6.49, "ginger ale"),
    item("ice", "Bag of ice, 5 lb", "bag", 3.99, "ice cubes", "bagged ice", "crushed ice"),
    # Liquor
    item("vodka", "Smirnoff vodka, 750 ml", "oz", 26.95, "premium vodka", "smirnoff"),
    item("gin", "London dry gin, 750 ml", "oz", 31.95, "dry gin"),
    item("rum", "White rum, 750 ml", "oz", 27.95, "white rum"),
    item("tequila", "Blanco tequila, 750 ml", "oz", 34.95, "blanco tequila"),
    item("whiskey", "Rye whisky, 750 ml", "oz", 29.95, "whisky", "bourbon", "rye"),
    item("triple sec", "Triple sec, 750 ml", "oz", 18.95, "cointreau", "orange liqueur"),
    item("bitters", "Aromatic bitters, 200 ml", "dashes", 12.95, "angostura bitters"),
    item("beer", "Lager, 6 x 355 ml", "cans", 14.95, "lager", "pale ale"),
    item("white wine", "Dry white wine, 750 ml", "oz", 15.95, "sauvignon blanc", "chardonnay"),
    item("red wine", "Red wine, 750 ml", "oz", 16.95, "cabernet", "merlot", "pinot noir"),
]


def slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def sku_for(vendor: str, name: str) -> str:
    return f"{VENDOR_SKU_PREFIX.get(vendor, vendor[:3].upper())}-{slug(name).upper()}"


def price_for(entry: dict, vendor: str) -> str:
    """Each vendor's price for an item, stable across runs and machines.

    Hashing the name and vendor rather than drawing at random keeps the numbers
    reproducible, so a re-run with --refresh-prices is a no-op instead of
    quietly repricing the whole catalog.
    """
    lo, hi = VENDOR_BAND[vendor]
    digest = hashlib.md5(f"{entry['name']}|{vendor}".encode()).hexdigest()[:8]
    spread = int(digest, 16) / 0xFFFFFFFF
    return f"{max(0.49, round(entry['base'] * (lo + spread * (hi - lo)), 2)):.2f}"


def load_ledger() -> dict:
    try:
        return json.loads(LEDGER_PATH.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def save_ledger(ledger: dict) -> None:
    LEDGER_PATH.write_text(json.dumps(ledger, indent=2, sort_keys=True) + "\n")


async def vendor_ids(client: ZipClient, wanted: tuple[str, ...]) -> dict[str, str]:
    body = await client._get("/vendors", {"page_size": 100})
    found: dict[str, str] = {}
    for vendor in _as_list(_unwrap(body)):
        if not isinstance(vendor, dict):
            continue
        name = _name_of(vendor)
        for want in wanted:
            if want.lower() in name.lower() and (vid := _id_of(vendor)):
                found[want] = vid
                # A vendor added in the dashboard arrives inactive, and an
                # inactive vendor cannot be put on a request.
                if vendor.get("status") in (5, "5"):
                    res = await client._http.patch(f"/vendors/{vid}", json={"data": {"status": 1}})
                    if res.status_code >= 400:
                        raise RuntimeError(f"Could not activate vendor '{name}' ({res.status_code})")
                    print(f"  activated vendor {name}")
    missing = [w for w in wanted if w not in found]
    if missing:
        raise RuntimeError(f"Vendors not found on this Zip company: {', '.join(missing)}")
    return found


async def create_product(client: ZipClient, entry: dict) -> str:
    raw = await client._post("/products", {"name": entry["pack"], "description": f"{entry['name']} for the OMNI fridge agent"})
    pid = _id_of(_unwrap(raw))
    if not pid:
        raise RuntimeError(f"Zip did not return a product id for {entry['name']}")
    return pid


async def create_vendor_item(client: ZipClient, product_id: str, vendor: str, vid: str, entry: dict) -> dict:
    price = price_for(entry, vendor)
    raw = await client._post(
        "/vendor_items",
        {
            "vendor_id": vid,
            "product_id": product_id,
            "supplier_part_number": sku_for(vendor, entry["name"]),
            "rate_cents": round(float(price) * 100),
            "currency": client.cfg["currency"],
            # ACTIVE is rejected without purchasing_group_ids, and those cannot
            # be listed through the API. DRAFT is fine: requests carry their own
            # vendor and amount, they do not read this catalog back.
            "status": "DRAFT",
        },
    )
    item = _unwrap(raw)
    return {
        "vendor": vendor,
        "vendor_id": vid,
        "vendor_item_id": _id_of(item),
        "sku": sku_for(vendor, entry["name"]),
        "rate": price,
    }


async def refresh_price(client: ZipClient, offer: dict, price: str) -> bool:
    """Pushes an edited price onto an existing vendor item."""
    res = await client._http.patch(
        f"/vendor_items/{offer['vendor_item_id']}",
        json={"data": {"rate_cents": round(float(price) * 100), "currency": client.cfg["currency"]}},
    )
    if res.status_code >= 400:
        print(f"    ! could not update {offer['sku']}: {res.status_code} {res.text[:120]}")
        return False
    offer["rate"] = price
    return True


async def seed(vendors: tuple[str, ...], dry_run: bool, refresh: bool) -> None:
    ledger = load_ledger()
    client = ZipClient()
    try:
        ids = await vendor_ids(client, vendors)
        print(f"Zip: {client.cfg['base_url']}")
        print("Vendors: " + ", ".join(f"{name} ({vid[:8]})" for name, vid in ids.items()))
        print(f"Ledger: {LEDGER_PATH} ({len(ledger)} entries)\n")

        created_products = created_items = updated = skipped = 0
        for entry in CATALOG:
            key = entry["name"]
            record = ledger.get(key) or {}
            offers = {o["vendor"]: o for o in record.get("offers", [])}
            todo = [v for v in vendors if v not in offers]

            if not todo and not refresh:
                skipped += 1
                continue

            if dry_run:
                if todo:
                    print(f"  would create {key}: {entry['pack']} at {', '.join(todo)}")
                for vendor in vendors:
                    offer = offers.get(vendor)
                    if refresh and offer and offer["rate"] != price_for(entry, vendor):
                        print(f"  would reprice {offer['sku']}: {offer['rate']} -> {price_for(entry, vendor)}")
                continue

            if refresh:
                for vendor in vendors:
                    offer = offers.get(vendor)
                    want = price_for(entry, vendor)
                    if offer and offer["rate"] != want and await refresh_price(client, offer, want):
                        print(f"  repriced {offer['sku']} -> ${want}")
                        updated += 1

            product_id = record.get("product_id")
            if todo:
                if not product_id:
                    product_id = await create_product(client, entry)
                    created_products += 1
                for vendor in todo:
                    offers[vendor] = await create_vendor_item(client, product_id, vendor, ids[vendor], entry)
                    created_items += 1
                    print(f"  {key}: {offers[vendor]['sku']} ${offers[vendor]['rate']} ({vendor})")

            ledger[key] = {
                "product_id": product_id,
                "pack": entry["pack"],
                "unit": entry["unit"],
                "aliases": entry["aliases"],
                "offers": sorted(offers.values(), key=lambda o: float(o["rate"])),
            }
            # Saved per item: ids cannot be recovered from Zip (no list endpoint)
            # and cannot be deleted, so losing one would mean a duplicate.
            save_ledger(ledger)

        verb = "would create" if dry_run else "created"
        print(
            f"\n{verb} {created_products} products and {created_items} vendor items; "
            f"{updated} repriced, {skipped} already seeded."
        )
    finally:
        await client.aclose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="print what would change, create nothing")
    parser.add_argument("--refresh-prices", action="store_true", help="push edited prices to existing items")
    parser.add_argument("--vendor", action="append", choices=list(VENDORS), help="limit to one vendor (repeatable)")
    args = parser.parse_args()
    asyncio.run(seed(tuple(args.vendor or VENDORS), args.dry_run, args.refresh_prices))


if __name__ == "__main__":
    main()
