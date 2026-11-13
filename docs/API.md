# Family Chores — Backend API contract

This is the contract the web UI is built against. The backend is Supabase Postgres, and every call is a Postgres function invoked through `supabase.rpc()`. There are **no tables** the browser can read or write, and **no Supabase Auth**.

- **Project URL:** `https://qtvfcdeuvdzaasmkqkpl.supabase.co`
- **Browser key (publishable, safe to ship):** `sb_publishable_snOQLinjpR-2HkA85GcntQ_YpPFH0nB`
- **Schema source:** [`supabase/schema.sql`](../supabase/schema.sql). Re-running it drops and recreates all data.
- **Never** put a `service_role` or secret key in the frontend. The app does not need one.

---

## 1. Concepts

| Concept | Notes |
|---|---|
| **Profiles** | Four fixed profiles: Dad and Mom (`role: "parent"`), Akin (kid, 11, phone) and Niko (kid, 6, iPad). They are listed by `list_profiles()` with no login. Use `id` (uuid) in calls and `slug` (`dad`/`mom`/`akin`/`niko`) for stable UI keys. |
| **Code (PIN)** | Exactly 4 digits (`^[0-9]{4}$`), sent as a **string**, so leading zeros matter. Profiles start with no code (`has_pin: false`). The first time a profile is picked, the UI asks the user to choose a code and calls `set_initial_pin`. |
| **Session token** | `login` / `set_initial_pin` return `token`, a 64-character hex string. Store it in `localStorage` keyed per profile, e.g. `chores.token.<profile_id>`. Pass it as `p_token` to **every** other RPC. Sessions last 30 days and slide: active use extends them. The server derives the caller and role from the token and **never** trusts a role or profile id sent by the client. |
| **Lockout** | After 5 wrong codes in a row, the profile is locked for 5 min. Each further lockout doubles (10, 20, 40 min …, max 24 h). A successful login resets the counters. Parents get a `pin_locked` notification. A parent can clear a lock with `reset_pin`. |
| **Chore** | A definition written by a parent: title, description, points, assignee kids, `repeat` = `none` / `daily` / `weekly` (+ `weekdays`), and `due_date` (one-off only). |
| **Instance** | One kid's to-do for one chore on one day; this is what kids see and tick. The server generates **recurring** instances for each scheduled day up to *today* (Pacific/Auckland), and never future days. A **one-off** chore gets one instance per kid when it is created. |
| **Instance status** | `open` → (kid completes) `submitted` → (parent) `approved` ✅ or `rejected` ↩︎ (kid can redo → `submitted`). An `open` instance whose due day has passed becomes `lapsed`. A `rejected` one lapses too, but only from the day after the rejection. Lapsed instances stay visible and earn no points. One-off chores without a `due_date` never lapse. |
| **Points & dollars** | Balance = sum of the ledger. Points are credited **only** when a parent approves. Settings hold the rate: `rate_points` points = `rate_dollars` NZD (default **10 points = $1.00**). Every `dollars` field is computed server-side and rounded to cents. |
| **Wish list** | Each kid has their own items. An item has `price_dollars` (converted at the current rate, rounded **up** to whole points) and/or `points_cost` (wins if both are set). `cost_points` is the effective cost. `eligible` = the item is active and `available_points >= cost_points`. |
| **Available points** | `points − pending_redeem_points`. Points tied up in pending redeem requests can't be requested twice. |
| **Redeem request** | A kid asks for an eligible item → parents get notified → parent approves (points deducted, item `redeemed`) or declines (nothing deducted; the item stays active). The kid can cancel while it is pending. |
| **Notifications** | In-app only, per profile. Parents get `chore_submitted`, `redeem_requested`, `pin_locked`. Kids get `chore_assigned`, `chore_approved`, `chore_rejected`, `redeem_approved`, `redeem_declined`, `points_bonus`, `points_adjusted`, `wish_added`, `pin_reset`. When a parent reviews a chore or decides a redeem, the matching parent notifications are marked read automatically for **both** parents. |
| **Visibility** | Kids only ever see and act on their own instances, balance, ledger, wishes and requests. If a kid passes another kid's id, they get `forbidden`; if they pass another kid's object id, they get `not_found`. Parents see everything. |
| **Dates** | Every `date` is `YYYY-MM-DD` in Pacific/Auckland (the `settings.timezone`). Timestamps are ISO-8601 with offset (UTC). `whoami().settings.today` is the server's notion of today, so use it rather than the device clock. |

---

## 2. Calling convention (supabase-js v2)

```html
<script type="module">
  import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
  const supabase = createClient(
    'https://qtvfcdeuvdzaasmkqkpl.supabase.co',
    'sb_publishable_snOQLinjpR-2HkA85GcntQ_YpPFH0nB',
    { auth: { persistSession: false, autoRefreshToken: false } } // we don't use Supabase Auth
  );

  // Generic wrapper: throws ApiError with a stable `code`
  class ApiError extends Error { constructor(code, detail) { super(code); this.code = code; this.detail = detail; } }
  async function api(fn, params = {}) {
    const { data, error } = await supabase.rpc(fn, params);
    if (error) throw new ApiError(error.message, error.details); // error.message IS the code, e.g. "forbidden"
    return data;
  }
  // Authenticated call helper
  const call = (fn, params = {}) => api(fn, { p_token: session.token, ...params });
</script>
```

Rules:

- **Parameter names are exact**, including the `p_` prefix. Omit an optional parameter to get its default. Send JSON `null` only where the docs say null is meaningful.
- Arrays are JSON arrays (`p_assignees: [uuid, …]`, `p_weekdays: [1,3,5]`, `p_statuses: ['submitted']`).
- Dates are strings `'2026-11-20'`. Numbers for money go as JSON numbers (`4.5`).
- **Errors (everything except `login` / `set_initial_pin`)**: HTTP 400 with `{ code: "P0001", message: "<error_code>", details: "<human detail or empty>" }`. Switch on `error.message`. Wrong function or parameter names give HTTP 404 with `code: "PGRST202"`, which is a frontend bug.
- **`invalid_session` from any call** → the token is expired or revoked. Delete the stored token and send the user back to the code screen for that profile.
- **`login` and `set_initial_pin` never throw for expected failures.** They return `{ ok: false, error: "...", ... }`. This is deliberate, so that failed-attempt counters persist.

### Error codes

| code | Meaning | Typical UI |
|---|---|---|
| `invalid_session` | Token missing, wrong, expired, logged out, or revoked (reset/change of code) | Drop token → code screen |
| `forbidden` | Caller's role can't do this (kid calling a parent RPC, a parent calling a kid-only RPC, a kid reading another kid's data) | Hide the control; show "Ask a parent" |
| `not_found` | Id doesn't exist **or isn't visible to the caller** | Refresh the list |
| `invalid_status` | Wrong state for the action (e.g. completing a lapsed or approved instance, approving twice, deciding a non-pending request). `details` says the current status. | Refresh |
| `invalid_pin_format` | Code isn't exactly 4 digits | Inline validation |
| `wrong_pin` | (`change_pin` only) current code wrong | Inline |
| `invalid_title`, `invalid_points`, `invalid_repeat`, `invalid_assignees`, `invalid_weekdays`, `invalid_due_date`, `repeat_change_not_allowed` | Chore form validation (see `details`) | Inline |
| `note_required` | Reject / adjust needs a non-empty note | Inline |
| `invalid_photo`, `photo_too_large` | Photo mime/base64 bad, or > 600 KB decoded | Re-compress / retry |
| `invalid_kid` | Kid id missing/not a kid (parents must pass `p_kid` for some calls) | Bug / pick a kid |
| `invalid_rate` | Settings out of range | Inline |
| `invalid_link`, `invalid_cost` | Wish form validation | Inline |
| `request_pending` | Wish already has a pending redeem request (can't request again or edit) | Show "Waiting for parents" |
| `insufficient_points` | Not enough available points (request) or balance (approval) | Show points needed |
| `invalid_decision` | `p_approve` missing | Bug |

Text inputs are trimmed, and empty strings become null. Limits: titles are capped at 120 characters, notes at 500, descriptions at 2000 and links at 1000; the server truncates anything longer.

---

## 3. Shared object shapes

**Profile**
```json
{ "id": "uuid", "slug": "akin", "name": "Akin", "role": "kid", "age": 11, "device": "phone",
  "avatar": "🧒", "color": "#16a34a", "has_pin": true, "locked_until": null }
```
`locked_until` is a timestamp only while the profile is currently locked; otherwise it is null.

**Chore**
```json
{ "id": "uuid", "title": "Feed the cat", "description": "Half a scoop", "points": 20, "dollars": 2.00,
  "repeat": "weekly", "weekdays": [1,3,5], "start_date": "2026-11-13", "due_date": null,
  "archived": false, "archived_at": null, "created_at": "…", "updated_at": "…",
  "assignees": [ { "id": "uuid", "name": "Akin" } ] }
```
`weekdays` uses ISO numbering (1 = Mon … 7 = Sun). It is `[]` for `daily`/`none`.

**Instance**
```json
{ "id": "uuid", "chore_id": "uuid", "kid_id": "uuid", "kid_name": "Akin",
  "title": "Feed the cat", "description": "…", "repeat": "daily",
  "points": 20, "dollars": 2.00, "period_date": "2026-11-13", "due_date": "2026-11-13",
  "status": "open|submitted|approved|rejected|lapsed",
  "kid_note": null, "submitted_at": null, "reviewed_at": null, "reviewed_by_name": null,
  "review_note": null, "lapsed_at": null, "has_photo": false,
  "can_complete": true, "chore_archived": false }
```
- `period_date` is the day the instance belongs to. For one-offs it is the creation day.
- `due_date` is null for a one-off with no deadline.
- `can_complete` = status is `open` or `rejected` and the chore is not archived.
- `review_note` holds the parent's feedback (on a rejection, the reason).

**Wish**
```json
{ "id": "uuid", "kid_id": "uuid", "kid_name": "Akin", "title": "Lego set", "link": "https://…",
  "price_dollars": 4.50, "points_cost": null, "cost_points": 45, "cost_dollars": 4.50,
  "status": "active|redeemed", "created_at": "…", "redeemed_at": null,
  "available_points": 50, "eligible": true, "points_needed": 0,
  "pending_request": null | { "id": "uuid", "points": 45, "created_at": "…" } }
```
- `available_points` excludes other pending requests but not this item's own, so `eligible` stays true while this item's request is pending.
- When `pending_request` is set, show "Waiting for parents" instead of the Redeem button.

**Redeem request**
```json
{ "id": "uuid", "wish_id": "uuid", "wish_title": "Lego set", "wish_link": "https://…",
  "kid_id": "uuid", "kid_name": "Akin", "points": 45, "dollars": 4.50,
  "status": "pending|approved|declined|cancelled", "kid_note": "Please!",
  "decision_note": null, "decided_by_name": null, "decided_at": null, "created_at": "…",
  "kid_balance": 50 }
```
`points` and `dollars` are snapshots taken at request time.

**Notification**
```json
{ "id": "uuid", "kind": "chore_submitted", "title": "Akin finished: Feed the cat", "body": "Photo attached. Tap to review.",
  "instance_id": "uuid|null", "redeem_id": "uuid|null", "wish_id": "uuid|null",
  "actor_id": "uuid|null", "actor_name": "Akin", "created_at": "…", "read_at": null, "unread": true }
```
`title` and `body` are display-ready. Use `kind` plus the ref ids for icons and deep links: `instance_id` goes to the approval/chore view, and `redeem_id`/`wish_id` go to the wish or request view.

**Balance row**
```json
{ "kid_id": "uuid", "name": "Akin", "avatar": "🧒", "color": "#16a34a",
  "points": 50, "dollars": 5.00, "pending_redeem_points": 45,
  "available_points": 5, "available_dollars": 0.50,
  "awaiting_approval_points": 20, "awaiting_approval_count": 1 }
```

**Ledger row**
```json
{ "id": "uuid", "kid_id": "uuid", "kid_name": "Akin", "delta": -45, "dollars": -4.50,
  "kind": "chore|redeem|bonus|adjust", "note": "Lego set", "instance_id": null,
  "redeem_id": "uuid", "created_by_name": "Dad", "created_at": "…" }
```
`note` is the chore title for `chore` rows, the wish title for `redeem` rows, and the parent's note for bonus/adjust rows.

---

## 4. RPC reference

"Who" means the caller's role, which comes from the token. **Any** means any signed-in profile.

### 4.1 Profiles & sign-in

#### `list_profiles()` → `Profile[]`
- **Who:** anyone, no token needed. Used for the account picker, ordered Dad, Mom, Akin, Niko.
- Use `has_pin` to choose between the **set code** and **enter code** screens, and `locked_until` to show a lock countdown.

#### `set_initial_pin(p_profile uuid, p_pin text)` → `LoginResult`
- **Who:** anyone, but it only works while that profile has **no** code. It sets the code and signs the profile in.
- `LoginResult` success: `{ ok: true, token, expires_at, profile: Profile }`.
- Failure (no throw): `{ ok:false, error:"pin_already_set" | "invalid_pin_format" | "not_found" }`.
- UI: ask for the code twice and compare client-side before calling.

#### `login(p_profile uuid, p_pin text)` → `LoginResult`
- **Who:** anyone.
- Success is the same shape as above.
- Failure (no throw):
  - `{ ok:false, error:"wrong_pin", attempts_left: 1..4 }`
  - `{ ok:false, error:"locked", locked_until }`. This is returned on the 5th wrong try and for every attempt while locked, even with the right code.
  - `{ ok:false, error:"pin_not_set" }` → show the set-code screen.
  - `{ ok:false, error:"invalid_pin_format" }` (not counted as an attempt)
  - `{ ok:false, error:"not_found" }`
- bcrypt makes a login take roughly 0.3–1 s. Show a spinner.

#### `logout(p_token text)` → `boolean`
- **Who:** any. Deletes that session. Returns `false` if the session was already gone. It never throws.

#### `whoami(p_token text)` → `{ profile: Profile, settings: Settings, unread_count: int }`
- **Who:** any. Call on app start for each stored token to validate it. Throws `invalid_session`.

#### `change_pin(p_token, p_current_pin text, p_new_pin text)` → `true`
- **Who:** any (own code). Signs out the profile's *other* sessions.
- Errors: `invalid_pin_format`, `wrong_pin`. A wrong current code here does **not** count toward lockout.

#### `reset_pin(p_token, p_profile uuid, p_new_pin text = null)` → `Profile`
- **Who:** parent. Works on any profile, including the other parent or themselves.
- With `p_new_pin` omitted or null, the code is cleared (`has_pin:false`) and the person sets a new one next time they pick their name. With a 4-digit `p_new_pin`, the code is set to that value.
- Always clears the lockout and signs the target out of all sessions (except the caller's current session).
- The target gets a `pin_reset` notification if it isn't the caller.
- Errors: `forbidden`, `not_found`, `invalid_pin_format`.

### 4.2 Settings

`Settings` = `{ rate_points: int, rate_dollars: number, currency: "NZD", timezone: "Pacific/Auckland", today: "YYYY-MM-DD", updated_at }`.
`whoami` returns the same object without `updated_at`.

#### `get_settings(p_token)` → `Settings`
**Who:** any.

#### `update_settings(p_token, p_rate_points int, p_rate_dollars numeric)` → `Settings`
- **Who:** parent. Meaning: `p_rate_points` points = `p_rate_dollars` NZD, e.g. `(10, 1)` or `(100, 5)`.
- Range: points 1–1,000,000; dollars greater than 0 and up to 100,000 (rounded to cents).
- Changing the rate changes every displayed `dollars` value and any wish priced in dollars. Pending requests keep their snapshot.
- Errors: `forbidden`, `invalid_rate`.

### 4.3 Chores (parents)

#### `create_chore(p_token, p_title text, p_points int, p_assignees uuid[], p_description text = null, p_repeat text = 'none', p_weekdays int[] = null, p_due_date date = null, p_start_date date = null)` → `Chore`
- **Who:** parent.
- `p_points` is 1–100,000. `p_assignees` lists one or more kid profile ids.
- `p_repeat`:
  - `'none'`: one instance per assignee is created now. `p_due_date` is optional, must be today or later, and the instance lapses after that day.
  - `'daily'`: an instance every day from `p_start_date` (default today).
  - `'weekly'`: instances on `p_weekdays` (ISO 1–7). If omitted or empty, the weekday of the start date is used.
  - For recurring chores, `p_due_date` must be null.
- Assignees are notified (`chore_assigned`). Past days are **never** backfilled.
- Errors: `forbidden`, `invalid_title`, `invalid_points`, `invalid_repeat`, `invalid_assignees`, `invalid_weekdays`, `invalid_due_date`.

#### `update_chore(p_token, p_chore_id uuid, p_title, p_points, p_assignees, p_description = null, p_repeat = 'none', p_weekdays = null, p_due_date = null, p_start_date = null)` → `Chore`
- **Who:** parent.
- **Full replace:** send every field from the edit form, because omitted optional fields reset to their defaults. Omitting `p_start_date` keeps the existing one.
- You can switch `daily` ↔ `weekly`, but **not** between one-off and recurring (`repeat_change_not_allowed`; create a new chore instead).
- Effects:
  - New points (and, for one-offs, the new due date) apply to instances that are `open`, `submitted` or `rejected`. Approved and lapsed history is unchanged.
  - Removed kids lose their `open` instances from today on (and for one-offs, their open instance).
  - Added kids start today and are notified.
  - Open instances from today on that no longer match the schedule are removed.
- Errors: as create, plus `not_found`, `repeat_change_not_allowed`.

#### `set_chore_archived(p_token, p_chore_id uuid, p_archived boolean = true)` → `Chore`
- **Who:** parent.
- Archiving stops generation and removes `open` instances from today on (and the open instances of a one-off). History stays.
- Unarchiving resumes from today, with no backfill of the archived period. A one-off gets new instances for kids who have none.
- Errors: `forbidden`, `not_found`.

#### `list_chores(p_token, p_include_archived boolean = false)` → `Chore[]`
- **Who:** parent. Active chores come first, newest first.

### 4.4 Instances (the to-do list)

#### `list_instances(p_token, p_from date = today−7, p_to date = today, p_kid uuid = null, p_statuses text[] = null)` → `Instance[]`
- **Who:** any. Kids always get only their own; passing a different `p_kid` gives `forbidden`. Parents get all kids, or one kid with `p_kid`.
- It first generates today's recurring instances and lapses missed ones, so this is the "refresh" call.
- It returns instances whose `period_date` is between `p_from` and `p_to`, **plus** any still-actionable instances (`open`/`submitted`/`rejected`) from earlier, such as an old one-off.
- It is ordered by `period_date` desc, then by status (rejected, open, submitted, approved, lapsed).
- Suggested views:
  - **Kid "Today":** call with no params. Show `can_complete` items as tasks and the others as history.
  - **Parent "To approve":** `p_statuses: ['submitted']`, widened with something like `p_from` = today−60.
  - **History:** wider `p_from`.
- Errors: `forbidden`, `invalid_kid`.

#### `complete_instance(p_token, p_instance_id uuid, p_note text = null, p_photo_base64 text = null, p_photo_mime text = 'image/jpeg')` → `Instance`
- **Who:** kid (own instance only). Allowed when the status is `open` or `rejected` and the chore is not archived. The instance becomes `submitted`.
- Parents get `chore_submitted`.
- The photo is optional (see §5). Sending no photo removes any photo from an earlier submission.
- Errors: `forbidden` (parent calling), `not_found`, `invalid_status`, `invalid_photo`, `photo_too_large`.

#### `get_instance_photo(p_token, p_instance_id uuid)` → `{ instance_id, mime, bytes, base64, created_at }`
- **Who:** parent, or the kid who owns the instance.
- Display with `img.src = \`data:${mime};base64,${base64}\``. Fetch lazily, only when `has_photo` is true and the user opens the item.
- Errors: `not_found` (also returned when there is no photo).

#### `approve_instance(p_token, p_instance_id uuid, p_note text = null)` → `Instance & { kid_balance: int }`
- **Who:** parent. Works from `submitted`, and also from `open` or `rejected`, so a parent can approve a chore done without the app. It can't approve `lapsed` or `approved` instances.
- Credits `points` to the ledger exactly once (enforced by a unique constraint) and notifies the kid (`chore_approved`).
- Errors: `forbidden`, `not_found`, `invalid_status`.

#### `reject_instance(p_token, p_instance_id uuid, p_note text)` → `Instance`
- **Who:** parent. Only from `submitted`. A note is required and is shown to the kid as `review_note` and in the `chore_rejected` notification.
- The kid can redo (`complete_instance` again) until the due day ends. If the rejection happens after the due day, the kid still has the rest of the rejection day.
- Errors: `forbidden`, `not_found`, `invalid_status`, `note_required`.

### 4.5 Points

#### `get_balances(p_token)` → `BalanceRow[]`
- **Who:** any. A kid gets a one-element array with themselves; parents get every kid.

#### `list_ledger(p_token, p_kid uuid = null, p_limit int = 50)` → `LedgerRow[]`
- **Who:** any (kid: own only). Newest first. `p_limit` is 1–500.

#### `adjust_points(p_token, p_kid uuid, p_delta int, p_note text)` → `{ kid_id, points, dollars }`
- **Who:** parent. A positive delta is a `bonus` and a negative one is an `adjust`. `p_delta` must not be 0 and can be at most 100,000 in either direction. The note is required.
- The balance may go negative. The kid is notified.
- Errors: `forbidden`, `invalid_kid`, `invalid_points`, `note_required`.

### 4.6 Wish list & redeeming

#### `list_wishes(p_token, p_kid uuid = null, p_include_closed boolean = false)` → `Wish[]`
- **Who:** any (kid: own only; parent: all kids or `p_kid`).
- Active items come first, sorted by cost. With `p_include_closed`, redeemed items are included. Removed items are never returned.

#### `add_wish(p_token, p_title text, p_link text = null, p_price_dollars numeric = null, p_points_cost int = null, p_kid uuid = null)` → `Wish`
- **Who:** kid (for themselves; `p_kid` must be omitted or their own id) or parent (`p_kid` **required**; the kid is notified with `wish_added`).
- At least one of `p_price_dollars` / `p_points_cost` must be set. `p_link` must start with `http(s)://`.
- Errors: `forbidden`, `invalid_kid`, `invalid_title`, `invalid_link`, `invalid_cost`.

#### `update_wish(p_token, p_wish_id uuid, p_title text, p_link = null, p_price_dollars = null, p_points_cost = null)` → `Wish`
- **Who:** the owning kid or a parent. Full replace. Only `active` items, and only while no request is pending.
- Errors: `not_found`, `invalid_status`, `request_pending`, plus the validation codes.

#### `remove_wish(p_token, p_wish_id uuid)` → `true`
- **Who:** the owning kid or a parent. Only `active` items. It also cancels a pending request.
- Errors: `not_found`, `invalid_status`.

#### `request_redeem(p_token, p_wish_id uuid, p_note text = null)` → `RedeemRequest`
- **Who:** kid (own item). The item must be `active`, have no pending request, and `available_points >= cost_points`.
- Parents get `redeem_requested`. The points are reserved: `available_points` drops.
- Errors: `forbidden`, `not_found`, `invalid_status`, `request_pending`, `insufficient_points` (`details`: "need X, available Y").

#### `cancel_redeem(p_token, p_request_id uuid)` → `RedeemRequest`
- **Who:** kid (own, pending).
- Errors: `not_found`, `invalid_status`.

#### `list_redeem_requests(p_token, p_status text = null, p_kid uuid = null)` → `RedeemRequest[]`
- **Who:** any (kid: own). Pending requests come first, then newest. For the parent inbox, pass `p_status: 'pending'`.

#### `decide_redeem(p_token, p_request_id uuid, p_approve boolean, p_note text = null)` → `RedeemRequest`
- **Who:** parent. The request must be `pending`.
- Approve: requires the kid's balance ≥ `points` (else `insufficient_points`, e.g. after a negative adjustment). It writes a ledger row (`kind:'redeem'`, −points), sets the item to `redeemed`, and notifies the kid (`redeem_approved`).
- Decline: nothing is deducted, the item stays active, and the kid gets `redeem_declined`. The note is shown to the kid.
- Errors: `forbidden`, `not_found`, `invalid_status`, `insufficient_points`, `invalid_decision`.

### 4.7 Notifications

#### `list_notifications(p_token, p_unread_only boolean = false, p_limit int = 50)` → `Notification[]`
- **Who:** any (own only). Newest first. `p_limit` is 1–200.

#### `unread_count(p_token)` → `int`
- **Who:** any. Use for the bell badge. Poll every ~30 s while the app is visible, and on `visibilitychange`. Realtime is not available because the tables are private.

#### `mark_notifications_read(p_token, p_ids uuid[] = null)` → `int` (rows marked)
- **Who:** any (own). With `p_ids` null, all are marked read; otherwise only the listed ids.

---

## 5. Photos (optional proof on completion)

The photo is stored inside the database, behind the RPCs (`app.instance_photos`, max **600 KB decoded**). It never leaves the RPC layer. There is no public bucket and no URL to guess.

The client must downscale and compress before sending:

```js
async function fileToJpegBase64(file, maxSide = 1280, quality = 0.75) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = Object.assign(document.createElement('canvas'),
    { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  for (let q = quality; q >= 0.4; q -= 0.1) {
    const dataUrl = canvas.toDataURL('image/jpeg', q);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    if (b64.length * 3 / 4 <= 600 * 1024) return b64;      // fits
  }
  throw new Error('photo_too_large');
}

// <input type="file" accept="image/*" capture="environment">
const b64 = file ? await fileToJpegBase64(file) : null;
await call('complete_instance', { p_instance_id: id, p_note: note || null,
                                  p_photo_base64: b64, p_photo_mime: 'image/jpeg' });
```

- A `data:image/...;base64,` prefix is also accepted and stripped.
- Allowed mimes: `image/jpeg`, `image/png`, `image/webp`. HEIC from iPhone/iPad must go through the canvas above, which converts it to JPEG.
- Viewing: `const p = await call('get_instance_photo', { p_instance_id }); img.src = \`data:${p.mime};base64,${p.base64}\`;`

---

## 6. Suggested app flow

1. **Start:** `list_profiles()` → a picker with 4 big avatar tiles. If a tile has a valid stored token, `whoami` it and skip the code screen.
2. **Tap a profile:**
   - `has_pin:false` → "Choose your 4-digit code" (enter twice) → `set_initial_pin`.
   - Otherwise → keypad → `login`. Handle `wrong_pin` (shake, "N tries left"), `locked` (countdown until `locked_until`), and `pin_not_set`.
3. **Kid home:**
   - `get_balances` shows points and $ (big), plus "waiting for approval".
   - `list_instances` shows Today: tasks with a ✓ button and an optional camera; rejected items show the parent's note and a Redo button; lapsed items appear greyed as "missed".
   - The Wish list tab uses `list_wishes`: eligible items show a Redeem button, others show a progress bar from `points_needed`.
   - The 🔔 bell uses `unread_count` and `list_notifications`, then `mark_notifications_read`.
   - Niko is 6, so use big tap targets, emoji, and minimal text.
4. **Parent home:**
   - Approvals inbox: `list_instances(p_statuses:['submitted'], p_from:today−60)` plus `list_redeem_requests(p_status:'pending')`.
   - Kids' balances: `get_balances`.
   - Chores CRUD: `list_chores` / `create_chore` / `update_chore` / `set_chore_archived`.
   - Bonus: `adjust_points`. Wish lists: `list_wishes`. Settings (rate): `update_settings`. Codes: `reset_pin`. Plus the 🔔 bell.
5. **Switch user / sign out:** `logout` + clear the stored token → picker.

---

## 7. Security notes (for reviewers)

- Data lives in Postgres schema `app`, which is not exposed by PostgREST. `GET /rest/v1/<table>` returns 404/406.
- Every table has RLS enabled with no policies, and anon/authenticated have no table grants.
- API functions are `SECURITY DEFINER` in `app`, with `search_path = ''` and fully qualified names. The browser reaches them only through `SECURITY INVOKER` SQL wrappers of the same name in `public`.
- Internal `app._*` helpers are not executable by anon.
- Tokens: 256-bit random, and only their SHA-256 is stored. Codes are hashed with bcrypt (cost 10) and lockout escalates.
- **Inherent limit:** a 4-digit code is family-grade protection, not bank-grade.
  - Anyone with the site link can try codes, but the escalating lockout limits that to roughly a few dozen guesses per profile per day.
  - Until a profile's code is set, anyone with the link could set it. Set all four codes right after first deploy; a parent can always `reset_pin`.
