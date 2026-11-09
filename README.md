# R Ledger — Local Trading Journal

A local, self-contained trading journal dashboard with overview analytics, a trade log,
a screenshot gallery, and a daily performance calendar.

It starts **empty**. Add trades manually or import your Excel/CSV journal, and everything
is stored privately in your browser on your computer.

> Runs entirely in your browser: no account, no backend, and no trading data leaves
> your device.

---

## Quick start

1. Open the hosted app: <https://podyokira.github.io/r-ledger/>
2. Or open `index.html` directly in a modern browser (Chrome, Edge, Firefox).

No install, no account, no server required.

Optional: run it from a tiny local server instead:

```powershell
cd path\to\r-ledger
python -m http.server 8080
```

Then visit <http://localhost:8080>.

> Data is tied to the address you open. `file://.../index.html` and
> `http://localhost:8080` are different browser origins with separate storage.
> Pick one and stick with it.

### Files

```
index.html               the app
assets/styles.css        design system and layout
assets/app.js            analytics, charts, import/export, storage
assets/xlsx.full.min.js  bundled Excel parser (works offline)
assets/inter-...woff2    bundled font
```

Keep the `assets` folder next to `index.html`.

---

## Adding data

### Option A — Add trades manually

Use **+ Add trade** in the top right. Each entry supports:

- date (required)
- outcome: TP / SL / BE / No trade / unspecified
- realized RR (e.g. `3`, `-1`, `0`)
- max RR (optional)
- time (optional)
- screenshot URL, or upload a chart image from your computer
- a free-form note

Trades can be edited (pencil) or deleted (bin) from **Trade log**.
You can also click any day in **Calendar** to add a trade on that date.

### Option B — Import Excel or CSV

Click **Import Excel** and choose `.xlsx`, `.xls`, or `.csv`.

The importer scans every sheet and looks for a header row that contains **Date** and
**RR** (or **Max RR**). Column names are flexible:

| Field | Accepted headers |
|---|---|
| Date | `Date` |
| Day | `Day`, `Weekday` (optional — calculated if missing) |
| Outcome | `TP/SL`, `Status`, `Outcome`, `Result` |
| Realized RR | `RR` |
| Max RR | `Max RR`, `Maximum RR` |
| Time | `Time`, `Entry Time` |
| Screenshot | `Screenshot`, `Image`, `Screenshot Link`, `Link`, `Image URL` |
| Note | `Note`, `Notes`, `Comment`, `Comments` |

Notes:

- **Import replaces the current journal.** Export/backup first if you need the old data.
- Every dated row is imported, including rows with no outcome/RR (blank template rows).
  Use **Show blank template rows** to show or hide those.
- Outcomes are normalized: `TP`, `Take profit`, `Win` → TP; `SL`, `Stop loss` → SL;
  `BE`, `Break-even` → BE; `No trade` → NO TRADE. Anything else is kept as “Other”.
- Excel date serials, real dates, `YYYY-MM-DD`, `MM/DD/YYYY` and most recognizable
  date strings are supported.
- Excel time fractions (e.g. `0.3125`) become `07:30`. Time can also be `HH:MM`.
- Screenshot cells must contain a URL (`https://...`) or a cell hyperlink.
  Uploaded image files are added from the trade form, not from Excel.
- Use the **Export → Download import template** button for a ready CSV template.

---

## Screenshots

- Paste an image URL, or click **Choose image…** to upload a file.
- Uploaded images are stored in the browser's IndexedDB, so they survive reloads.
- Click any gallery card or **View image ↗** link to open the full-screen viewer.
  Navigate with `←` / `→`, close with `Esc`.
- Broken external links show an “Image unavailable” placeholder.

---

## Export & backup

**Export** opens the data menu:

| Action | What it does |
|---|---|
| **Export trades as CSV** | Spreadsheet-friendly copy of all trades. Uploaded images are noted as `(uploaded image)` and are not embedded. |
| **Download a full backup** | JSON backup including trades, notes and uploaded images (embedded). Use this to move to another browser/computer. |
| **Restore from backup** | Replaces the journal with a JSON backup. |
| **Download import template** | CSV with the expected headers and one example row. |

**Reset data** permanently deletes all trades, notes and uploaded images from this browser.

Storage notes:

- Trades and settings live in `localStorage` under `rledger.local.journal.v1`.
- Uploaded screenshots live in IndexedDB database `rledger.local.images`.
- Clearing browser site data, using private/incognito mode, or a different browser/origin
  will lose local data. Download a JSON backup regularly.

---

## What the dashboard computes

- **Recorded trades** = TP + SL entries
- **Win rate** = TP / (TP + SL)
- **Net realized R** = sum of all numeric RR values
- **Average R / trade** = net R / numeric RR entries
- **Max R drawdown** = largest peak-to-trough fall in the chronological cumulative-R sequence
- **Streaks** = longest consecutive TP or SL run
- **Monthly performance** = sum of numeric RR per month
- **RR captured vs. maximum RR** = scatter of realized RR against recorded Max RR
- **Calendar** = daily sum of RR and number of records, respecting the filters

Journal analytics are descriptive, not financial advice.

---

## Tips

- Filters (year, month, outcome, search) apply to every page and every metric.
- Search matches dates, day names, month names, outcome, sheet name, RR, Max RR, time and notes.
- The page is deep-linkable: `index.html#trades`, `#gallery`, `#calendar`.
- Works offline once the files are local (the font and Excel parser are bundled).
