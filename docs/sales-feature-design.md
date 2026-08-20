# Sales (Carry Store) — Design Doc

Status: **Draft for review** · Owners: Anzhem, Windex · Last updated: 2026-08-20

A public storefront for selling raid carries. Buyers browse upcoming raids, reserve
an armor type or a specific item (or grab a cheaper "Vault Express" roll spot), see
their deposit and total in real time, and leave a BattleTag. Council contacts them in
game to take the deposit and run the raid. Guild members get a personal referral link
so their sales are attributed and they earn a cut.

This doc covers the business model, the architecture decision (one app, not two), the
data model, and the changes required to the existing loot-tracker app to support a
public + optional-login world.

---

## 1. Goals & non-goals

**Goals**
- A public `/sales` storefront that requires **no login** to browse or sign up.
- Reserve model: exclusive **armor-type reserves**, premium **single-item reserves**, and **Vault Express** roll spots.
- Set prices up front (no per-ad negotiation); the ad's cut is a % applied only when a referral is present.
- Referral attribution via short opaque codes tied to guild members, plus a per-seller stats page.
- Reuse the existing **Item DB** (season-scoped, guild-wide) for the reserve/roll catalog and the storefront.

**Non-goals (for now)**
- No in-app payments. Gold is traded in game, by hand, by council. The site records intent and shows amounts.
- No automatic loot assignment. The app captures reserves and shows council a reserve map; the actual handoff is manual (same as the rest of the loot flow).
- No refunds on Heroic if an item doesn't drop (see §2.4). Configurable per sale.
- Schedule automation (parsing Raid-Helper posts) is a **later** phase and needs the bot repo.

---

## 2. Business model

### 2.1 Reserve tiers

Two reserve tiers plus the open tier, in **fulfillment priority order**:

| Priority | Type | What it buys | Exclusivity | Price |
|----------|------|--------------|-------------|-------|
| 1 (highest) | **Item reserve** | A specific rare item (trinket, ring, cloak, neck, etc.) — you get it if it drops. | One buyer per item per sale | Premium (per-item) |
| 2 | **Armor reserve** | An entire armor class (Cloth / Leather / Mail / Plate). **All** drops of that type go to you, ahead of any Vault Express buyer of the same armor. | One buyer per armor type per sale (so at most 4) | Base reserve price |
| 3 (lowest) | **Vault Express** | A roll spot on anything **not** claimed by an item or armor reserve. | Non-exclusive (fills remaining seats) | Cheapest |

The waterfall is the whole point: an item reserve beats an armor reserve beats a Vault
Express roll. Because item reserves target accessory-slot items (trinket/ring/cloak/neck),
which are armor-type-agnostic in the Item DB (`armor_type = 'Accessory'`), item and armor
reserves rarely overlap — but when they do (e.g. a reserved plate tier chest), the item
reserve wins.

### 2.2 The "first four" rule

- A raid lead sets **max signups** for a sale.
- The **first four signups must be armor reserves** — one per armor type — so the four
  armor classes get locked before the cheaper open spots sell. (Four reserves ↔ four
  armor types is not a coincidence; armor reserves are exclusive per type.)
- **Item reserves** are premium add-ons available regardless of the first-four gate.
- On the **last day before the sale**, the raid lead can drop the first-four requirement so
  people can buy Vault Express without a reserve just to fill the raid.

> **Open question (§7):** can item reserves and Vault Express be purchased before all four
> armor reserves are filled, or is the raid strictly reserve-first until the last-day toggle?
> Assumed: item reserves anytime; Vault Express gated by the toggle.

### 2.3 Pricing & the ad cut

- **Set prices up front**, per sale: one price each for armor reserve and Vault Express, and
  a per-item price for each reservable item. No negotiation — this removes the "ad as
  salesman" middleman that the old Astra model required.
- **Deposit** = a configurable % of the price, shown at checkout as the amount to lock the
  spot in.
- **Ad cut** = a configurable %, applied to the seller's earnings **only when the signup
  carries a referral code**. Direct signups (no ref) mean the guild keeps the full margin.
  Same buyer price either way; only the internal split changes.

### 2.4 Refunds

- Heroic default: **no refund** if a reserved item doesn't drop (the buyer is paying for a
  chance/priority, not a guarantee). Modeled as a per-sale `refund_policy` so Mythic or
  special runs can differ.

### 2.5 Buyer contact

- Checkout collects a **BattleTag** (required). It's a plain text field — **not** a Discord
  login. BattleTag lets council send the in-game invite directly. Council friends the buyer
  for the run and removes them after.

---

## 3. Architecture decision: one app, split the auth boundary

**Decision: keep everything in the single existing Cloudflare Worker + D1, and make login
lazy — do not build a second app that syncs data through KV.**

### Why

- **Auth is already per-router, not global.** `src/web/server/index.js` applies
  `sessionMiddleware()` globally (it *reads* a session but doesn't *require* one) and mounts
  each route group separately; `requireAuth` is opted into inside each router. A public
  `/api/sales` router that simply doesn't call `requireAuth` on its public endpoints is a
  purely additive change — the loot routers are untouched.
- **The client gates per-route, not at the root.** `App.jsx` wraps individual routes in
  `ProtectedRoute` / `OfficerRoute` / `GlobalOfficerRoute`. Adding an *unwrapped* `/sales`
  route sits alongside them without moving anything.
- **The Item DB already lives in the same D1**, season-scoped and guild-wide. Sales reserves,
  prices, signups, and attribution are relational and want to JOIN against `item_db`,
  `seasons`, and member identity. That's exactly what D1/SQLite is for.
- **KV is the wrong tool** for this: key-value, eventually consistent, no joins. A second app
  would mean copying item data across a sync boundary and reinventing a query layer to avoid
  the relational database we already have. It buys nothing and adds sync-bug surface.

So we split the **auth line** inside the one app, not the app itself. Login becomes
**on-demand**: public `/sales` needs no session; hitting an internal action (a seller's own
dashboard, a raid lead's sale config) triggers Discord OAuth and the session persists across
the whole app.

### OAuth note (settles the msg 73–76 thread)

Base OAuth (`identify`) returns a Discord **identity with no roles**; the app then does a
separate guild-member lookup on our server to resolve roles from the roster. A non-member
*can* complete OAuth and get an identity — the app rejects them because they aren't in our
guild. Implication for sales: **buyers are never routed through login at all.** It would be
friction with no payoff, and our login is member-only by design.

---

## 4. Auth & routing model

`sessionMiddleware` stays global (harmless — sets/reads the cookie). `requireAuth` stays
opt-in per route.

| Route | Auth | Purpose |
|-------|------|---------|
| `/` | **Public** (enriched when logged in) | Landing / marketing; renders the member dashboard inline when a session exists |
| `/sales` | **Public** | Storefront: list of open sales |
| `/sales/:saleId` | **Public** | A sale's storefront + checkout (accepts `?ref=CODE`) |
| `/sales/me` | Member (lazy login) | Seller dashboard: my ref link, attributed signups, earnings |
| `/sales/manage` | Sales manager / officer | Create/edit sales, set prices, mark reservable items, view signups + reserve map |
| `/bis`, `/council`, `/roster`, `/loot-*`, `/import` | Member/Officer (unchanged) | Existing loot tracker |
| `/admin/*` | Officer / Global officer (unchanged) | Existing admin |

API mirror: `/api/sales/*` public reads + signup POST with no auth; `/api/sales/me` and
`/api/sales/manage/*` behind `requireAuth` (+ a role check).

**One required change to existing behavior:** the client `*` fallback currently redirects
everyone to `/` (protected) which force-bounces to `/login`. It must instead let public
paths resolve, so an unauthenticated visitor lands on the public landing, not a login wall.

---

## 5. Changes to the existing `/loot` structure

The sales feature turns the app from "a members-only tool" into "a public site with a
members area." That reframing touches a few things beyond just adding routes.

### 5.1 Public shell + lazy login (client)

- Add a **public landing** at `/` that renders marketing + a Sales CTA + a "Member login"
  button when logged out, and the existing dashboard when logged in. Keeps URLs stable and
  satisfies "move login into root but make it on-demand" (msgs 48, 56–61).
- Introduce a lightweight `PublicLayout` (header with **Sales** and **Login**, no member nav)
  vs. the existing member `Layout`. The static advertising header link (msgs 87–90) lives in
  `PublicLayout` and routes to `/sales`.
- `useMe()` already tolerates a logged-out state (returns `user: null`); public pages use it
  to decide what to show rather than to gate.

### 5.2 Server: public vs protected split

- New `salesRouter` mounted at `/api/sales`. Public endpoints (list sales, get a sale, submit
  a signup) apply **no** `requireAuth`. Member/manager endpoints apply `requireAuth` plus a
  role check.
- No change to the existing routers.

### 5.3 "Shared" admin/config vs loot-specific admin

The instinct to "move some admin/config out of `/loot` into a shared spot" is right, but in
this codebase it's mostly **information architecture, not data migration** — the shared data
already lives in guild-wide D1 tables, and the access split already mirrors the boundary:

- **Guild-wide (shared) admin** — already gated by `GlobalOfficerRoute`: **Item DB**,
  **Seasons**, **Global Config**, **Default BIS**. Sales depends on Item DB + Seasons, so
  these are genuinely shared infrastructure, not loot-specific.
- **Team-scoped (loot) admin** — gated by `OfficerRoute`: Team Config, Roster, RCLC map, loot
  import/history.

Proposed reorganization:
- Present a top-level **Admin** area with two clearly separated groups — **Guild** (Item DB,
  Seasons, Global Config, **Sales config/defaults**) and **Team** (everything loot-specific)
  — instead of one flat `/admin/*` list. This is a nav/grouping change; the routes and role
  guards can stay where they are.
- Add **Sales management** under the Guild group (or a dedicated `sales_manager` role — see
  §7), since a sale's catalog is the guild-wide Item DB and its prices are guild-level.
- No table moves. `item_db` and `seasons` are already the shared source of truth for both
  features.

### 5.4 Season scoping

Sales reference a season (the Item DB catalog is season-scoped). New sales tables get a
`season_id` FK, following the established migration pattern (`0005_seasons`). A sale also
pins an `instance` + `difficulty`, so its catalog = `item_db WHERE season_id + instance +
difficulty`.

### 5.5 Docs: fix the stack drift in CLAUDE.md

`CLAUDE.md` still describes the stack as **Express + express-session on Railway**. The real
stack is **Cloudflare Workers + Hono + D1 (SQLite) + React/Vite**, deployed via wrangler.
Before sales adds a batch of new routes, update CLAUDE.md so the next contributor (human or
Claude) starts from the correct model, and add a short "public vs member" section describing
the auth boundary introduced here.

---

## 6. Data model (new tables)

All new tables are D1, season-scoped where relevant, following existing conventions
(integer PKs, `season_id` FKs, partial unique indexes for exclusivity).

### `sales` — one scheduled carry raid
```
id                INTEGER PK
season_id         INTEGER FK -> seasons(id)
team_id           INTEGER FK -> teams(id)   -- nullable if sales are guild-wide (see §7)
instance          TEXT      -- e.g. "The Venomous Abyss"
difficulty        TEXT      -- Heroic | Mythic
raid_date         TEXT      -- ISO datetime
max_signups       INTEGER
reserve_slots     INTEGER   -- default 4 (the armor-type reserves)
price_armor       INTEGER   -- gold, base armor-reserve price
price_vault       INTEGER   -- gold, Vault Express price
deposit_pct       INTEGER   -- % of price to lock in
ad_cut_pct        INTEGER   -- seller's % when a ref is present
refund_policy     TEXT      -- 'none' (Heroic default) | ...
vault_open        INTEGER   -- 0 = reserve-first; 1 = last-day override, Vault Express open
status            TEXT      -- Draft | Open | Closed | Completed | Cancelled
raid_lead_id      TEXT      -- Discord id
created_at        TEXT
```

### `sale_reservable_items` — which rare items are single-item-reservable, and their price
```
sale_id     INTEGER FK -> sales(id)
item_id     TEXT       -- matches item_db.item_id (season/instance-scoped)
price       INTEGER    -- premium price for this item
PRIMARY KEY (sale_id, item_id)
```
Raid lead curates this per sale from the Item DB catalog. (Alternative: a global "reservable"
flag on `item_db` + a default premium — but per-sale curation is more flexible and keeps the
shared Item DB clean.)

### `sale_signups` — one buyer / one seat
```
id            INTEGER PK
sale_id       INTEGER FK -> sales(id)
signup_type   TEXT       -- ArmorReserve | ItemReserve | VaultExpress
armor_type    TEXT       -- Cloth|Leather|Mail|Plate  (ArmorReserve only)
item_id       TEXT       -- (ItemReserve only)
buyer_contact TEXT       -- BattleTag
buyer_name    TEXT       -- optional display
ref_code      TEXT       -- nullable; attribution
price         INTEGER    -- snapshot at signup
deposit       INTEGER    -- snapshot at signup
status        TEXT       -- Pending | DepositPaid | Confirmed | Fulfilled | NoShow | Cancelled
notes         TEXT
created_at    TEXT
```

**Exclusivity via partial unique indexes** (same pattern as the roster name fix):
```
-- one armor reserve per armor type per sale
CREATE UNIQUE INDEX idx_sale_armor_reserve
  ON sale_signups(sale_id, armor_type)
  WHERE signup_type = 'ArmorReserve' AND status NOT IN ('Cancelled','NoShow');

-- one buyer per reservable item per sale
CREATE UNIQUE INDEX idx_sale_item_reserve
  ON sale_signups(sale_id, item_id)
  WHERE signup_type = 'ItemReserve' AND status NOT IN ('Cancelled','NoShow');
```

### `ad_codes` — referral attribution
```
ref_code    TEXT PK   -- short opaque code (e.g. 6 chars), server-issued
discord_id  TEXT      -- the guild member who owns it
display_name TEXT
created_at  TEXT
```
Minted the first time a member opens `/sales/me`. Attribution stats and earnings are derived
by grouping `sale_signups.ref_code`. Codes are opaque and server-issued, so attribution can't
be spoofed by editing the URL (unlike a typed name), and buyers never authenticate.

### Reuse of existing tables
- **`item_db`** — the reserve/roll catalog. Armor reserves derive from `armor_type`; the
  Vault Express pool and the reservable-item picker are `item_db` filtered by the sale's
  season + instance + difficulty. The storefront/buybox renders directly from this data
  (Wowhead tooltips already wired in the client's `ItemSelect`).
- **`seasons`** — season scoping for the catalog.
- **member identity** — `ad_codes.discord_id` is guild-level (any member can sell), so it
  references Discord identity rather than a per-team `roster.id`.

---

## 7. Open decisions

1. **Sales scope: guild-wide or per-team?** Carries are often a guild-level operation, but a
   sale is tied to a specific raid (which belongs to a team). This decides whether `sales`
   carries a non-null `team_id` and whether sale management lives under team or guild admin.
   *Leaning: guild-wide sales with a per-sale raid-lead assignment; `team_id` optional.*
2. **Signup sequencing:** are item reserves / Vault Express purchasable before all four armor
   reserves are filled, or strictly reserve-first until the last-day toggle? *Assumed: item
   reserves anytime; Vault Express gated by `vault_open`.*
3. **Who can manage sales?** Reuse `GlobalOfficer`, or add a dedicated `sales_manager` role so
   sellers/leads aren't necessarily officers?
4. **Per-item pricing UX:** flat premium for any item reserve, or per-item prices curated in
   `sale_reservable_items`? *Leaning: per-item, curated per sale.*
5. **Landing page:** does `/` become a public landing (with the dashboard shown when logged
   in), or do we keep `/` as the member dashboard and add a separate public `/sales`-rooted
   entry? *Leaning: public `/` that enriches when authenticated.*

---

## 8. Phasing

**Phase 1 — Storefront + signups (no new infra)**
- Public shell + lazy login; `PublicLayout`; fix the `*` fallback.
- `sales`, `sale_signups`, `sale_reservable_items`, `ad_codes` tables (one migration).
- Public `/sales` list + `/sales/:id` storefront with the reserve/Vault-Express picker, live
  deposit + total, BattleTag checkout, `?ref=` attribution.
- Seller dashboard `/sales/me` (ref link + attributed signups + earnings).
- Raid-lead management `/sales/manage` (create sale, set prices, curate reservable items,
  view signups + reserve map).
- Static header ad link → `/sales`.

**Phase 2 — Storefront polish (the buybox)**
- Item-DB shop-front UI: browse the catalog with tooltips, per-item reserve pricing, the
  "checkout" buybox showing deposit + total in real time.
- Seller stats/leaderboard flourishes.

**Phase 3 — Later**
- Bot listens for Raid-Helper posts and parses them into the sale schedule (needs the bot
  repo). Automates schedule creation from existing Discord activity.

---

## 9. Summary

- **One app, one D1.** Split the auth boundary (public vs member), don't split the codebase
  or sync through KV.
- **Login is lazy and member-only.** Buyers never authenticate; sellers/leads log in on
  demand.
- **Two reserve tiers + Vault Express**, exclusivity enforced with partial unique indexes,
  fulfillment as an item→armor→open waterfall.
- **Attribution via opaque server-issued ref codes** tied to guild members — spoof-resistant,
  buyer-frictionless, and keeps us "self-advertising."
- **Reuse the Item DB and Seasons** as shared infrastructure; reorganize admin into
  Guild-shared vs Team groups without moving data.
- **Fix CLAUDE.md's stack drift** before building.
