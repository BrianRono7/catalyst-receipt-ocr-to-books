'use strict';
/**
 * catalyst_receipt_ocr_to_books_function - Catalyst Advanced I/O Function
 *
 * Routes:
 *   GET  <invoke_url>/health            -> health check (add ?deep=true for a full check)
 *   POST <invoke_url>/process-receipt   -> Zia OCR + regex structuring, save as pending_review
 *   POST <invoke_url>/push-to-books     -> post an approved receipt row to Zoho Books
 *
 * OCR: Zia OCR (Catalyst's built-in service) only. No external LLM calls are made
 * anywhere in this function — structuring of the recognized text into vendor/date/
 * total/tax fields is done with regex against the raw OCR text.
 *
 * Zoho Books auth uses the Catalyst Connection with Link Name "books"
 * (Console > Cloud Scale > Connections, scope ZohoBooks.fullaccess.all).
 * Catalyst stores and refreshes the token; this code only asks for credentials.
 *
 * Environment variables:
 *   ZOHO_BOOKS_ORG_ID              (required)
 *   BOOKS_EXPENSE_ACCOUNT_ID       (required)
 *   BOOKS_PAID_THROUGH_ACCOUNT_ID  (required)
 *   ZOHO_BOOKS_DOMAIN              (optional, default https://www.zohoapis.com)
 *   BOOKS_TAX_ID                   (optional, Books tax_id to apply; amount treated as tax-inclusive)
 *
 * Runtime: Node.js 18+ (uses global fetch, for the Books API call only).
 */

const catalyst = require('zcatalyst-sdk-node');
const Busboy = require('busboy');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BOOKS_CONNECTION = 'books';
const BOOKS_DOMAIN = (process.env.ZOHO_BOOKS_DOMAIN || 'https://www.zohoapis.com').replace(/\/+$/, '');

module.exports = async (req, res) => {
  const app = catalyst.initialize(req);

  if (req.url.includes('/health')) {
    return handleHealthCheck(req, res, app);
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { success: false, error: 'Use POST.' });
  }
  if (req.url.includes('/push-to-books')) {
    return handlePushToBooks(req, res, app);
  }
  if (req.url.includes('/process-receipt')) {
    return handleProcessReceipt(req, res, app);
  }
  return sendJson(res, 404, { success: false, error: 'Unknown route. Use /process-receipt or /push-to-books.' });
};

// ---------------------------------------------------------------------------
// Route 1: OCR + structure a receipt
// ---------------------------------------------------------------------------
async function handleProcessReceipt(req, res, app) {
  const table = app.datastore().table('Receipts');
  let tmpPath;

  try {
    const upload = await saveUploadToTmp(req);
    tmpPath = upload.tmpPath;

    const ocrResult = await app.zia().extractOpticalCharacters(fs.createReadStream(tmpPath), {
      language: 'eng',
      modelType: 'OCR'
    });

    if (!ocrResult || !ocrResult.text) {
      return sendJson(res, 422, { success: false, error: 'No text detected in the uploaded file.' });
    }

    const structured = structureWithRegex(ocrResult.text);

    const row = await table.insertRow({
      file_name: upload.filename || 'unknown',
      vendor: structured.vendor,
      receipt_date: normaliseDate(structured.date),
      currency: structured.currency,
      subtotal: structured.subtotal,
      tax: structured.tax,
      total: structured.total,
      line_items: JSON.stringify(structured.line_items || []),
      raw_text: ocrResult.text,
      ocr_confidence: ocrResult.confidence,
      status: 'pending_review'
    });

    return sendJson(res, 200, {
      success: true,
      receipt_id: row.ROWID,
      extracted: structured,
      ocr_confidence: ocrResult.confidence
    });
  } catch (err) {
    console.error('process-receipt error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Route 2: push an approved receipt to Zoho Books
// ---------------------------------------------------------------------------
async function handlePushToBooks(req, res, app) {
  const table = app.datastore().table('Receipts');

  try {
    const { receipt_id } = (await readJsonBody(req)) || {};
    if (!receipt_id) {
      return sendJson(res, 400, { success: false, error: 'receipt_id is required.' });
    }

    const row = await table.getRow(receipt_id);
    if (!row) {
      return sendJson(res, 404, { success: false, error: 'Receipt not found.' });
    }
    if (row.status === 'posted_to_books') {
      return sendJson(res, 409, {
        success: false,
        error: 'Receipt already posted to Books.',
        books_expense_id: row.books_expense_id
      });
    }
    if (!row.total) {
      return sendJson(res, 422, { success: false, error: 'Receipt has no total amount; cannot push to Books.' });
    }

    const expense = await createBooksExpense(app, row);

    await table.updateRow({
      ROWID: receipt_id,
      status: 'posted_to_books',
      books_expense_id: expense.expense_id
    });

    return sendJson(res, 200, { success: true, books_expense_id: expense.expense_id });
  } catch (err) {
    console.error('push-to-books error:', err);
    return sendJson(res, 500, { success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// Route 3: health check
// ---------------------------------------------------------------------------
async function handleHealthCheck(req, res, app) {
  const requiredEnvVars = ['ZOHO_BOOKS_ORG_ID', 'BOOKS_EXPENSE_ACCOUNT_ID', 'BOOKS_PAID_THROUGH_ACCOUNT_ID'];
  const missingEnv = requiredEnvVars.filter(n => !process.env[n]);

  const health = {
    success: true,
    status: 'ok',
    timestamp: new Date().toISOString(),
    node_version: process.version,
    env: missingEnv.length ? 'incomplete' : 'ok',
    missing_env_vars: missingEnv
  };

  const isDeep = req.url.includes('deep=true');
  if (!isDeep) {
    health.status = missingEnv.length ? 'degraded' : 'ok';
    return sendJson(res, missingEnv.length ? 503 : 200, health);
  }

  health.checks = {};

  try {
    await app.datastore().table('Receipts').getPagedRows({ maxRows: 1 });
    health.checks.datastore = 'ok';
  } catch (err) {
    health.checks.datastore = `error: ${err.message}`;
  }

  try {
    await getBooksAuthHeader(app);
    health.checks.books_connection = 'ok';
  } catch (err) {
    health.checks.books_connection = `error: ${err.message}`;
  }

  const anyFailed = missingEnv.length > 0 || Object.values(health.checks).some(v => v.startsWith('error'));
  health.status = anyFailed ? 'degraded' : 'ok';
  return sendJson(res, anyFailed ? 503 : 200, health);
}

// ---------------------------------------------------------------------------
// Zoho Books via the "books" Connection
// ---------------------------------------------------------------------------
async function getBooksAuthHeader(app) {
  const creds = await app.connections().getConnectionCredentials(BOOKS_CONNECTION);

  if (!creds) {
    throw new Error(`Connection "${BOOKS_CONNECTION}" returned no credentials. Check it is live in the console.`);
  }

  if (typeof creds === 'string') {
    return { Authorization: creds.startsWith('Zoho-oauthtoken') ? creds : `Zoho-oauthtoken ${creds}` };
  }

  const headers = creds.headers || (creds.data && creds.data.headers);
  const headerValue = headers && (headers.Authorization || headers.authorization);
  if (headerValue) return { Authorization: headerValue };

  const token = creds.access_token || creds.accessToken || (creds.data && creds.data.access_token);
  if (token) return { Authorization: `Zoho-oauthtoken ${token}` };

  throw new Error(`Unrecognised credentials shape from connection "${BOOKS_CONNECTION}": keys=${Object.keys(creds).join(',')}`);
}

async function createBooksExpense(app, row) {
  requireEnv(['ZOHO_BOOKS_ORG_ID', 'BOOKS_EXPENSE_ACCOUNT_ID', 'BOOKS_PAID_THROUGH_ACCOUNT_ID']);

  const authHeader = await getBooksAuthHeader(app);

  const payload = {
    account_id: process.env.BOOKS_EXPENSE_ACCOUNT_ID,
    paid_through_account_id: process.env.BOOKS_PAID_THROUGH_ACCOUNT_ID,
    date: normaliseDate(row.receipt_date) || new Date().toISOString().slice(0, 10),
    amount: Number(row.total),
    reference_number: (row.file_name || '').slice(0, 100),
    description: `Auto-imported from receipt OCR. Vendor: ${row.vendor || 'unknown'}`
  };

  if (process.env.BOOKS_TAX_ID) {
    payload.tax_id = process.env.BOOKS_TAX_ID;
    payload.is_inclusive_tax = true;
  }

  const url = `${BOOKS_DOMAIN}/books/v3/expenses?organization_id=${encodeURIComponent(process.env.ZOHO_BOOKS_ORG_ID)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    throw new Error(`Zoho Books returned non-JSON response (HTTP ${resp.status}).`);
  }

  if (!resp.ok || data.code !== 0) {
    throw new Error(`Zoho Books API error (HTTP ${resp.status}): ${data.message || JSON.stringify(data)}`);
  }
  return data.expense;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function requireEnv(names) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) throw new Error(`Missing environment variables: ${missing.join(', ')}`);
}

// Writes the uploaded "file" field to /tmp so Zia gets a proper file stream
function saveUploadToTmp(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let pending = null;

    busboy.on('file', (fieldname, file, info) => {
      if (pending || fieldname !== 'file') {
        file.resume(); // ignore extra/unexpected files
        return;
      }
      const filename = info && info.filename;
      const tmpPath = path.join(os.tmpdir(), `receipt_${Date.now()}_${path.basename(filename || 'upload')}`);
      pending = new Promise((ok, fail) => {
        const out = fs.createWriteStream(tmpPath);
        file.pipe(out);
        out.on('finish', () => ok({ tmpPath, filename }));
        out.on('error', fail);
      });
    });

    busboy.on('error', reject);
    busboy.on('finish', () => {
      if (!pending) return reject(new Error('No file found in request. Expected field name "file".'));
      pending.then(resolve, reject);
    });

    req.pipe(busboy);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

// Books needs yyyy-mm-dd. Assumes day-first for slash/dash/dot dates (dd/mm/yyyy).
function normaliseDate(value) {
  if (!value) return null;
  const s = String(value).trim();

  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return toIso(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return toIso(year, m[2], m[1]);
  }
  return null;
}

function toIso(y, mo, d) {
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Only structuring method used in this function: regex over the Zia OCR text.
// Reliable for totals/tax/date; line items are left empty since receipt layouts
// vary too much for pattern matching alone.
function structureWithRegex(text) {
  const totalMatch = text.match(/\b(grand total|total|amount due)\b[^\d]{0,15}([\d,]+\.\d{2})/i);
  const taxMatch = text.match(/\b(tax|vat|gst)\b[^\d]{0,15}([\d,]+\.\d{2})/i);
  const dateMatch = text.match(/\b(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2})\b/);
  const vendor = text.split('\n').map(l => l.trim()).find(l => l.length > 2) || null;

  return {
    vendor,
    date: dateMatch ? dateMatch[1] : null,
    currency: null,
    subtotal: null,
    tax: taxMatch ? parseFloat(taxMatch[2].replace(/,/g, '')) : null,
    total: totalMatch ? parseFloat(totalMatch[2].replace(/,/g, '')) : null,
    line_items: []
  };
}