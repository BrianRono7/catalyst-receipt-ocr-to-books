# Catalyst Receipt OCR → Zoho Books

Automates extracting vendor, date, totals, and line items from scanned receipts and
invoices, with a human review step, then posts the approved result into Zoho Books
as an Expense — built on Zoho Catalyst (Zia OCR + Serverless Functions + Datastore).

## How it works

```
Client uploads receipt (image/PDF)
        │
        ▼
Catalyst Advanced I/O Function (receiptProcessor)
   1. Zia OCR → raw text + confidence
   2. Structure raw text → {vendor, date, total, tax, line_items[]}
        │
        ▼
Datastore table "Receipts" (status: pending_review)
        │
        ▼
Human reviews/edits (review UI)
        │
        ▼
Catalyst Function (pushToBooks) → Zoho Books API → creates Expense
```

Zia OCR only returns raw recognized text, not structured fields, so this project
adds a structuring step on top. Two modes are supported:

- **`regex`** (default) — free, no external dependency, reliably extracts totals
  and dates but not line items.
- **`llm`** — sends OCR text to an LLM (e.g. Claude) for robust structured
  extraction including line items. Requires your own LLM API key.

A review step sits between extraction and posting to Books on purpose — OCR/parsing
will occasionally misread amounts, and catching that before it hits your books is
worth the one extra click.

## Repo structure

```
functions/
  receiptProcessor/   # Advanced I/O function: OCR + structuring
  pushToBooks/         # Basic I/O function: posts an approved row to Zoho Books
README.md
```

## 1. Create the Datastore table

In the Catalyst console → Cloud Scale → Datastore, create a table named **`Receipts`**:

| Column               | Type    | Notes                                                            |
|-----------------------|---------|------------------------------------------------------------------|
| file_name             | Text    |                                                                    |
| vendor                | Text    |                                                                    |
| receipt_date          | Text    | store as `YYYY-MM-DD`                                             |
| currency              | Text    |                                                                    |
| subtotal              | Decimal |                                                                    |
| tax                   | Decimal |                                                                    |
| total                 | Decimal |                                                                    |
| line_items            | Text    | JSON string of `[{description, quantity, unit_price, amount}]`   |
| raw_text              | Text    | full OCR output, useful for debugging                             |
| ocr_confidence        | Decimal |                                                                    |
| status                | Text    | `pending_review` → `posted_to_books`                              |
| books_expense_id      | Text    | filled in after posting to Books                                  |

## 2. Deploy the functions

```bash
catalyst init                     # if you haven't already initialized a project
# copy this repo's functions/ folder into your project's functions/ folder
catalyst deploy --only functions
```

- `receiptProcessor` — deploy and note its Invocation URL from the console
  (Serverless → Functions → receiptProcessor).
- `pushToBooks` — called after a human approves a row.

## 3. Environment variables

Set these in Catalyst console → Settings → Environment Variables.

**OCR structuring (optional, LLM mode only):**
- `STRUCTURING_MODE` = `llm` (omit, or set to `regex`, to skip this and the key below)
- `ANTHROPIC_API_KEY` = your own Anthropic API key

**Zoho Books push:**
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET` — from a self-client registered at
  https://api-console.zoho.com (matching your Books org's data center)
- `ZOHO_REFRESH_TOKEN` — generated once via Zoho's OAuth consent flow, scope
  `ZohoBooks.expenses.CREATE,ZohoBooks.expenses.READ`
- `ZOHO_BOOKS_ORG_ID` — Zoho Books → Settings → Organization Profile
- `ZOHO_ACCOUNTS_DOMAIN` — e.g. `https://accounts.zoho.com` (adjust for your DC: `.eu`, `.in`, `.com.au`, etc.)
- `ZOHO_BOOKS_DOMAIN` — e.g. `https://www.zohoapis.com` (match the same DC)
- `BOOKS_EXPENSE_ACCOUNT_ID` — chart-of-accounts expense category to post against
- `BOOKS_PAID_THROUGH_ACCOUNT_ID` — bank/cash account the expense was paid from

## 4. Upload flow (client side)

```js
const formData = new FormData();
formData.append('file', selectedFile); // File object from an <input type="file">

const res = await fetch(
  'https://<project-domain>.development.catalystserverless.com/server/receiptProcessor/execute',
  { method: 'POST', body: formData }
);
const result = await res.json();
// result.receipt_id, result.extracted -> show these fields in a review form
```

## 5. Review, then post to Books

Show `result.extracted` in a form so a human can correct anything before posting.
Save edits back to the `Receipts` row, then call:

```js
await fetch(
  'https://<project-domain>.development.catalystserverless.com/server/pushToBooks/execute',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ receipt_id: result.receipt_id })
  }
);
```

## Roadmap / possible upgrades

- Auto-trigger `receiptProcessor` on file upload to Stratus via an Event
  Listener/Signals rule, instead of the client calling it directly.
- Switch to `llm` structuring mode for better line-item accuracy.
- Duplicate detection — hash the file or OCR text and check Datastore before
  inserting.
- Support Zoho Books' `bills` endpoint (in addition to `expenses`) for supplier
  invoices rather than receipts.

