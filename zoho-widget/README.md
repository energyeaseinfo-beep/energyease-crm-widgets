# EnergyEase Action Panels — Zoho CRM Widget

Live action-items widget for Zoho CRM. Replaces the static HTML dashboard's Tab 1 (Cashflow & Action Items) with a CRM-embedded widget that pulls deal data live via the Zoho Embedded App SDK.

## What it shows

- **Cash summary tiles** — outstanding invoices, to-invoice-now, in-execution value, future 2nd invoice, total still to receive
- **Action panels per stage** — Closed Won, Scheduled Execution, Project Started, Project Done — with tag-aware classification (invoice todo / payment overdue / Cetelem pending / on track)
- **Click any deal** to open it directly in CRM
- **Click any amount** (invoice mode) for a breakdown of the deal: where the value comes from, every InvoiceXpress document with links to the PDF and the Faturas record, and the calculation
- **In stage**: days since the deal entered its current stage, from Zoho's Stage History (loaded after the dashboard is visible; Green Fund deals only when their list is opened)

## How it works

The widget runs as an iframe inside Zoho CRM. It uses `ZOHO.CRM.API.getAllRecords({Entity: "Deals", ...})` to fetch deals — no separate auth needed; it inherits the CRM session.

Cash figures come from the Faturas module (InvoiceXpress documents, synced hourly by the CRM function "EE Faturas Sync") when the current user can read it. Otherwise the widget falls back to tags: the sync tags ("Invoice to send", "Awaiting payment", "Payment overdue", "1st payment received", "paid 100%") and the older manual payment tags.

## Files

- `index.html` — entry, loads SDK + app.js
- `js/app.js` — fetch + classify + render logic
- `css/styles.css` — UI styling

## Hosting

Hosted on GitHub Pages. The published URL is registered as a Zoho CRM widget with `hosting.type = external`.

## Dev / local testing

Open `index.html` directly in a browser — you'll see the SDK-not-loaded error message. The widget only works embedded inside CRM.

## Updating

Edit files locally → `git push` → GitHub Pages redeploys → next page load in CRM picks up the change.

## Owner

Florian de Haan, EnergyEase Lda.
