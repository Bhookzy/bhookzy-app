# Bhookzy.com — pure-veg food ordering platform (Ranchi)

Your original single-file site, upgraded into a production-ready platform **without changing its look**: same branding, layout and 270-dish menu — now backed by a real database, a secure admin dashboard and WhatsApp order hand-off.

| Part | What it is |
|---|---|
| **Customer site** (`/`) | Your design, faster and more accessible. Cart → server-priced bill → order saved in the database → WhatsApp opens with the full order message to **+91 91100 62453**. |
| **Admin dashboard** (`/admin`) | Orders, sales analytics, menu & restaurants, coupons, customers, delivery & website settings, team roles, activity log. Works on a phone. |
| **API + database** | Node.js (Express) + **PostgreSQL**. Prices are always re-calculated on the server. |

## 60-second start (local)

```bash
npm install
cp .env.example .env          # then edit DATABASE_URL (and set DATABASE_SSL=disable for a local Postgres)
npm run create-admin          # creates YOUR owner login (password typed hidden, never stored in code)
npm start                     # → http://localhost:3000   and   http://localhost:3000/admin
```
The first start creates all tables and loads the starter menu automatically. Full steps: **[docs/SETUP.md](docs/SETUP.md)**.

## Documents

- [docs/SETUP.md](docs/SETUP.md) — local setup, first admin, Supabase/Neon, daily use, Razorpay later
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Render / Railway / VPS (+ Docker), HTTPS, backups
- [docs/MIGRATING_FROM_OLD_SITE.md](docs/MIGRATING_FROM_OLD_SITE.md) — bring over orders, customers and menu edits from the old site
- [docs/TESTING_CHECKLIST.md](docs/TESTING_CHECKLIST.md) — manual test list (+ `npm test` for the 39 automated tests)
- [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) — what was fixed from the old site and how the new one is protected

## Commands

| Command | Does |
|---|---|
| `npm start` | Run the site (applies migrations; loads starter menu on an empty database) |
| `npm run dev` | Same, auto-restart on code changes |
| `npm run create-admin` | Create an owner account (interactive) |
| `npm run migrate` / `npm run seed` | Run migrations / add any missing starter data (note: re-adds starter dishes you deleted) |
| `node server/scripts/import-legacy.js file.json [--dry-run]` | Import data from the old site |
| `npm run build:css` | Rebuild Tailwind CSS (only if you change page classes) |
| `npm test` | 39 automated tests (needs a throw-away Postgres — see TESTING_CHECKLIST) |

## Project layout

```
server/            Express app: routes/ (public API), admin/ (admin API), lib/ (pricing, orders, analytics, WhatsApp, exports), migrations/, scripts/
public/index.html  Customer site (markup + public/js/*.js)
public/admin/      Admin dashboard (index.html + vanilla JS modules, no inline scripts)
public/assets/     Built Tailwind CSS (app.css, admin.css)
data/menu.seed.json  Your 270 dishes (loaded once into an empty database)
tests/             Automated tests
```

## Add these two images

Put **`logo.jpg`** and **`chaapdihatti.jpg`** (the files your old page referenced) into the `public/` folder, or upload new ones in Admin → Settings → Website look / Restaurants.
