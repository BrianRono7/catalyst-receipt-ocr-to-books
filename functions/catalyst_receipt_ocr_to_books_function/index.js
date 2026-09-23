'use strict';
/**
 * catalyst_receipt_ocr_to_books_function - Catalyst Advanced I/O Function
 *
 * Routes:
 *   GET  <invoke_url>/health            -> health check (add ?deep=true for a full check)
 *   POST <invoke_url>/process-receipt   -> Zia OCR + field extraction, saved as pending_review
 *   POST <invoke_url>/push-to-books     -> creates a Zoho Books INVOICE from a saved row
 *
 * RESPONSES ARE PASSED THROUGH UNCHANGED:
 *   /process-receipt  -> the Zia OCR REST response, exactly: { "status": "success", "data": { "text", ... } }
 *   /push-to-books    -> the Zoho Books "Create an invoice" response body and HTTP status, exactly
 *   API failures      -> the failing API's own error body and HTTP status
 *   The function's own values travel in response headers, never in the body:
 *     X-Receipt-Id, X-Customer-Name (URI-encoded), X-Contact-Id, X-Contact-Created, X-Request-Id
 *   Every failure also carries X-Error-Source: which API (or the function itself) produced it.
 *   Checks the function makes itself (no file, bad JSON, missing config...) return
 *   { "status": "failure", "data": { "error_code", "message" } }
 *
 * OCR: Zia OCR only (.jpg .jpeg .png .tiff .bmp .pdf, max 20 MB). No external LLM calls.
 * Zoho Books auth: Catalyst Connection with Link Name "books" (scope ZohoBooks.fullaccess.all).
 *
 * CUSTOMER (find or create): the invoice goes to the "Bill To" name read from the document, or
 * customer_name sent to /push-to-books. An existing customer with the same name is reused;
 * otherwise a new customer is CREATED in the document's currency, so check the name first.
 * Stops with a clear error if the name belongs to a vendor, if an existing customer uses a
 * different currency, or if the document's currency is not enabled in Books.
 *
 * Books endpoints called by /push-to-books, in order:
 *   GET  /books/v3/contacts?contact_name=...    find the customer
 *   GET  /books/v3/settings/currencies          only when creating a customer (currency_id)
 *   POST /books/v3/contacts                     only when no customer matched
 *   POST /books/v3/invoices                     create the invoice
 *
 * INVOICE NUMBER: Books auto-numbers the new invoice. The number printed on the scanned
 * document is kept as the invoice's reference_number.
 *
 * Data Store table "Receipts" columns:
 *   file_name, vendor, contact_name, bill_to, doc_number, receipt_date, due_date, currency,
 *   subtotal, tax, total, line_items, raw_text, ocr_confidence, status, books_document_id
 *
 * Configuration is hard-coded in the CONFIG block below (no environment variables).
 *
 * Runtime: Node.js 18+. npm: zcatalyst-sdk-node, busboy@^1
 */

const catalyst = require('zcatalyst-sdk-node');
const Busboy = require('busboy');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ===========================================================================
// Configuration
// ===========================================================================
const CONFIG = {
  ZOHO_BOOKS_ORG_ID: '794749764',
  ZOHO_BOOKS_DOMAIN: 'https://www.zohoapis.com',  // match the Books data centre: .eu, .in, .sa, .com.au ...
  BOOKS_INCOME_ACCOUNT_ID: '',                    // optional: income account for invoice lines ('' = Books default)
  BOOKS_TAX_ID: '',                               // optional: Books tax_id applied to each invoice line
  BOOKS_DEFAULT_ITEM_NAME: 'Imported item',
  BOOKS_EXPENSE_ACCOUNT_ID: '',                   // not used yet; kept for later entry types
  BOOKS_PAID_THROUGH_ACCOUNT_ID: '',              // not used yet; kept for later entry types
  MAX_UPLOAD_MB: 10                               // capped at Zia OCR's 20 MB limit
};

const BOOKS_CONNECTION = 'books';
const BOOKS_DOMAIN = CONFIG.ZOHO_BOOKS_DOMAIN.replace(/\/+$/, '');
const RECEIPTS_TABLE = 'Receipts';
const DEFAULT_ITEM_NAME = CONFIG.BOOKS_DEFAULT_ITEM_NAME || 'Imported item';

const ZIA_OCR_MAX_MB = 20;
const MAX_UPLOAD_BYTES = Math.min(Number(CONFIG.MAX_UPLOAD_MB) || 10, ZIA_OCR_MAX_MB) * 1024 * 1024;
const ALLOWED_MIME = /^(image\/(jpeg|jpg|png|tiff|bmp)|application\/pdf)$/i;

// ===========================================================================
// Response envelope + error model
// ===========================================================================
class AppError extends Error {
  constructor({ code, status = 500, stage, message, hint, details, cause }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.stage = stage;
    this.hint = hint;
    this.details = details;
    this.cause = cause;
  }
}

// Wraps an upstream API response so it is returned byte-for-byte as received
class ApiPassthrough extends Error {
  constructor(status, body, contentType = 'application/json', source = 'api') {
    super(`${source} returned HTTP ${status}`);
    this.status = status;
    this.body = body;
    this.contentType = contentType;
    this.source = source;
  }
}

// Catalyst SDK errors are rebuilt into the exact Catalyst REST error body:
// the SDK parses { status: "failure", data: { error_code, message } } into { statusCode, code, message }
function catalystFailure(err, source) {
  const status = (err && err.statusCode) || 500;
  const code = err && err.code ? String(err.code) : undefined;
  const body = { status: 'failure', data: { message: err && err.message ? err.message : String(err) } };
  if (code) body.data.error_code = code;
  return new ApiPassthrough(status, body, 'application/json', source);
}

function sendRaw(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(body));
}

function sendError(res, requestId, err, extraHeaders = {}) {
  if (err instanceof ApiPassthrough) {
    console.error(JSON.stringify({ request_id: requestId, passthrough_from: err.source, http_status: err.status, body: err.body }));
    if (res.headersSent) return;
    res.writeHead(err.status, { 'Content-Type': err.contentType, 'X-Request-Id': requestId, 'X-Error-Source': err.source, 'Access-Control-Expose-Headers': 'X-Request-Id, X-Error-Source', ...extraHeaders });
    return res.end(typeof err.body === 'string' ? err.body : JSON.stringify(err.body));
  }
  const e = err instanceof AppError
    ? err
    : new AppError({
        code: 'UNEXPECTED_ERROR',
        status: 500,
        stage: 'unknown',
        message: `An unexpected error occurred: ${err && err.message ? err.message : String(err)}`,
        hint: `Check the Catalyst function logs for request_id ${requestId}.`,
        cause: err
      });

  console.error(JSON.stringify({
    request_id: requestId,
    error_code: e.code,
    stage: e.stage,
    message: e.message,
    details: e.details,
    cause: e.cause ? { message: e.cause.message, code: e.cause.code, stack: e.cause.stack } : undefined
  }));

  // Same shape as a Catalyst REST error; the hint is folded into the message
  const message = e.hint ? `${e.message} ${e.hint}` : e.message;
  sendRaw(res, e.status, { status: 'failure', data: { error_code: e.code, message } }, { 'X-Request-Id': requestId, 'X-Error-Source': `function ${e.stage}`, 'Access-Control-Expose-Headers': 'X-Request-Id, X-Error-Source', ...extraHeaders });
}

function sdkErrorInfo(err) {
  if (!err) return {};
  return {
    sdk_code: err.code || (err.data && err.data.error_code) || undefined,
    sdk_status: err.statusCode || err.status || undefined,
    sdk_message: err.message || String(err)
  };
}

// ===========================================================================
// Entry point
// ===========================================================================
module.exports = async (req, res) => {
  const requestId = crypto.randomUUID();
  let app;

  try {
    app = catalyst.initialize(req);
  } catch (err) {
    return sendError(res, requestId, new AppError({
      code: 'SDK_INIT_FAILED',
      status: 500,
      stage: 'catalyst.initialize',
      message: 'The Catalyst SDK could not be initialised for this request.',
      hint: 'Confirm zcatalyst-sdk-node is installed in the function folder and the function type is Advanced I/O.',
      cause: err
    }));
  }

  const route = (req.url || '').split('?')[0];

  try {
    if (route.endsWith('/health')) {
      requireMethod(req, 'GET', '/health');
      return await handleHealthCheck(req, res, app, requestId);
    }
    if (route.endsWith('/process-receipt')) {
      requireMethod(req, 'POST', '/process-receipt');
      return await handleProcessReceipt(req, res, app, requestId);
    }
    if (route.endsWith('/push-to-books')) {
      requireMethod(req, 'POST', '/push-to-books');
      return await handlePushToBooks(req, res, app, requestId);
    }
    throw new AppError({
      code: 'ROUTE_NOT_FOUND',
      status: 404,
      stage: 'router',
      message: `No route matches ${req.method} ${route || '/'}.`,
      hint: 'Use GET /health, POST /process-receipt (multipart "file") or POST /push-to-books (JSON).'
    });
  } catch (err) {
    const headers = err instanceof AppError && err.code === 'METHOD_NOT_ALLOWED'
      ? { Allow: err.details.allowed_method }
      : undefined;
    return sendError(res, requestId, err, headers);
  }
};

function requireMethod(req, allowed, route) {
  if (req.method === allowed) return;
  throw new AppError({
    code: 'METHOD_NOT_ALLOWED',
    status: 405,
    stage: 'router',
    message: `${req.method} is not supported on ${route}.`,
    hint: `Send this request as ${allowed}.`,
    details: { allowed_method: allowed, route }
  });
}

// ===========================================================================
// Route 1: OCR + extract
// ===========================================================================
async function handleProcessReceipt(req, res, app, requestId) {
  let tmpPath;
  try {
    const upload = await saveUploadToTmp(req);
    tmpPath = upload.tmpPath;

    // Exactly what the SDK returns: the "data" object of the Zia OCR REST response
    let ocrData;
    const fileStream = fs.createReadStream(tmpPath);
    fileStream.on('error', () => {}); // the SDK may fail before reading; don't crash the function
    try {
      ocrData = await app.zia().extractOpticalCharacters(fileStream, {
        language: 'eng',
        modelType: 'OCR'
      });
    } catch (err) {
      throw catalystFailure(err, 'zia.ocr');
    } finally {
      fileStream.destroy();
    }

    // Saved internally so /push-to-books can use it; none of this goes in the response body
    const text = ocrData && typeof ocrData.text === 'string' ? ocrData.text : '';
    const headers = { 'X-Request-Id': requestId };
    if (text.trim()) {
      const extracted = extractFields(text.replace(/\f/g, ''));
      const row = await insertReceiptRow(app, {
        file_name: upload.filename || 'unknown',
        vendor: extracted.issuer,
        contact_name: extracted.bill_to,
        bill_to: extracted.bill_to,
        doc_number: extracted.doc_number,
        receipt_date: extracted.date,
        due_date: extracted.due_date,
        currency: extracted.currency,
        subtotal: extracted.subtotal,
        tax: extracted.tax,
        total: extracted.total,
        line_items: JSON.stringify(extracted.line_items),
        raw_text: text,
        ocr_confidence: ocrData.confidence != null ? ocrData.confidence : null,
        status: 'pending_review'
      });
      headers['X-Receipt-Id'] = String(row.ROWID);
      if (extracted.bill_to) headers['X-Customer-Name'] = encodeURIComponent(extracted.bill_to);
    }

    // The SDK strips the REST envelope; putting it back gives the exact REST API body
    return sendRaw(res, 200, { status: 'success', data: ocrData }, {
      ...headers,
      'Access-Control-Expose-Headers': 'X-Receipt-Id, X-Customer-Name, X-Request-Id'
    });
  } finally {
    if (tmpPath) fs.promises.unlink(tmpPath).catch(() => {});
  }
}

async function insertReceiptRow(app, data) {
  try {
    return await app.datastore().table(RECEIPTS_TABLE).insertRow(data);
  } catch (err) {
    throw catalystFailure(err, 'datastore.insert');
  }
}

// ===========================================================================
// Field extraction from OCR text
// ===========================================================================
const AMOUNT_RX = /\(?-?\)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{2})|\d+\.\d{2})/g;
const DATE_RX = /(\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/;
const CURRENCY_RX = /\b(AED|KES|KSH|KShs?|USD|EUR|GBP|SAR|QAR|OMR|BHD|KWD|EGP|INR|ZAR|NGN|UGX|TZS|RWF|GHS|MAD)\b/i;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function lines(text) {
  return text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
}

// OCR keeps page layout as runs of spaces; 3+ spaces = column break
function columns(line) {
  return line.trim().split(/\s{3,}/).map(c => c.trim()).filter(Boolean);
}

function amountsIn(str) {
  return [...str.matchAll(AMOUNT_RX)].map(m => parseFloat(m[1].replace(/,/g, '')));
}

function extractFields(text) {
  const ls = lines(text);
  const total = findLabelledAmount(ls, /^(grand\s+total|total\s+(amount|due|payable)|amount\s+(due|payable)|total)\b/i);
  const subtotal = findLabelledAmount(ls, /^sub\s*-?\s*total\b/i, 'first');
  let tax = findLabelledAmount(ls, /^(vat|tax|gst)(\s*\([^)]*\))?(\s*(amount|total))?\s*:?$/i);
  if (tax == null && total != null && subtotal != null && total > subtotal) {
    tax = round2(total - subtotal);
  }
  const currencyMatch = text.match(CURRENCY_RX);

  return {
    doc_number: findDocNumber(text),
    issuer: findIssuer(ls),
    bill_to: findLabelledBlock(ls, /^(bill(ed)?\s*to|invoice\s*to|sold\s*to|customer)\b\s*:?/i),
    date: normaliseDate(findDate(ls, /\b(invoice|bill|receipt|order|document)?\s*date\b/i, /\b(due|expiry|delivery)\s*date\b/i)),
    due_date: normaliseDate(findDate(ls, /\bdue\s*date\b/i)),
    currency: currencyMatch ? normaliseCurrency(currencyMatch[1]) : null,
    subtotal,
    tax,
    total,
    line_items: findLineItems(ls)
  };
}

function findIssuer(ls) {
  const titleWords = /^(tax|invoice|tax invoice|receipt|bill|quotation|quote|estimate|credit note|sales order|purchase order|original|copy)$/i;
  for (const l of ls.slice(0, 5)) {
    const col = columns(l).find(c => !titleWords.test(c) && /[A-Za-z]{2,}/.test(c) && !/@|^\+?\d[\d\s-]{6,}$/.test(c));
    if (col) return col.slice(0, 100);
  }
  return null;
}

// Label on its own column; value is the rest of that column, else the next line's first column
function findLabelledBlock(ls, labelRx) {
  for (let i = 0; i < ls.length; i++) {
    const cols = columns(ls[i]);
    for (const c of cols) {
      const m = c.match(labelRx);
      if (!m) continue;
      const rest = c.slice(m[0].length).trim();
      if (rest) return rest.slice(0, 100);
      const next = ls[i + 1] && columns(ls[i + 1])[0];
      if (next && !/^#|item|description|qty/i.test(next)) return next.slice(0, 100);
    }
  }
  return null;
}

function findDate(ls, labelRx, excludeRx) {
  for (const l of ls) {
    if (!labelRx.test(l) || (excludeRx && excludeRx.test(l))) continue;
    const after = l.slice(l.search(labelRx));
    const m = after.match(DATE_RX);
    if (m) return m[1];
  }
  if (excludeRx) {
    // no labelled date: first date anywhere that is not on an excluded line
    for (const l of ls) {
      if (excludeRx.test(l)) continue;
      const m = l.match(DATE_RX);
      if (m) return m[1];
    }
  }
  return null;
}

// Finds a column starting with the label and returns an amount from that column + the ones after it
function findLabelledAmount(ls, labelRx, pick = 'last') {
  for (const l of ls) {
    const cols = columns(l);
    const idx = cols.findIndex(c => labelRx.test(c));
    if (idx === -1) continue;
    const labelMatch = cols[idx].match(labelRx);
    const tail = [cols[idx].slice(labelMatch[0].length), ...cols.slice(idx + 1)].join('   ');
    const amounts = amountsIn(tail);
    if (amounts.length) return pick === 'first' ? amounts[0] : amounts[amounts.length - 1];
  }
  return null;
}

function findDocNumber(text) {
  const labelled = text.match(/\b(?:invoice|bill|receipt|order|quote|estimate|credit\s*note|document|ref(?:erence)?)\s*(?:no\.?|number|#)\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{2,})/i);
  if (labelled) return labelled[1];
  const hash = text.match(/#\s*([A-Z]{2,}[-\/]?\d{2,}[A-Z0-9\-\/]*)/);
  return hash ? hash[1] : null;
}

// Table rows: "<n>  <description>  qty  rate  ...  amount" with at least 3 numbers
function findLineItems(ls) {
  const items = [];
  for (let i = 0; i < ls.length; i++) {
    const m = ls[i].trim().match(/^(\d{1,3})\s+(.*)$/);
    if (!m) continue;
    const amounts = amountsIn(m[2]);
    if (amounts.length < 3) continue;
    const firstNum = m[2].search(/\d/);
    let description = m[2].slice(0, firstNum).trim();
    const qty = amounts[0];
    const rate = amounts[1];
    const amount = amounts[amounts.length - 1];
    if (!(qty > 0 && rate >= 0)) continue;
    items.push({ description: description || null, quantity: qty, rate, amount });
  }
  return items;
}

function normaliseCurrency(c) {
  const u = c.toUpperCase();
  return /^KSH/.test(u) ? 'KES' : u;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Books needs yyyy-mm-dd. Numeric dates are read day-first (dd/mm/yyyy).
function normaliseDate(value) {
  if (!value) return null;
  const s = String(value).trim().replace(/(\d)(st|nd|rd|th)\b/i, '$1');

  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (m) return toIso(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (m) return toIso(m[3].length === 2 ? `20${m[3]}` : m[3], m[2], m[1]);

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/);
  if (m && MONTHS[m[2].slice(0, 4).toLowerCase()] || m && MONTHS[m[2].slice(0, 3).toLowerCase()]) {
    return toIso(m[3], MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()], m[1]);
  }

  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()]) {
    return toIso(m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], m[2]);
  }
  return null;
}

function toIso(y, mo, d) {
  const month = Number(mo), day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

// ===========================================================================
// Route 2: push to Books
// ===========================================================================
async function handlePushToBooks(req, res, app, requestId) {
  const body = await readJsonBody(req);
  const receiptId = body.receipt_id != null ? String(body.receipt_id).trim() : '';

  if (!receiptId) {
    throw new AppError({
      code: 'RECEIPT_ID_MISSING',
      status: 400,
      stage: 'validate.request',
      message: 'The request body did not include a receipt_id.',
      hint: 'Send JSON like {"receipt_id": "1234567890123"} using the X-Receipt-Id from /process-receipt. Optional: "customer_name".'
    });
  }
  if (!/^\d+$/.test(receiptId)) {
    throw new AppError({
      code: 'RECEIPT_ID_INVALID',
      status: 400,
      stage: 'validate.request',
      message: `receipt_id "${receiptId}" is not a valid Data Store ROWID.`,
      hint: 'ROWIDs are numeric. Use the X-Receipt-Id returned by /process-receipt.'
    });
  }

  const row = await getReceiptRow(app, receiptId);

  if (row.status === 'posted_to_books') {
    throw new AppError({
      code: 'ALREADY_POSTED',
      status: 409,
      stage: 'validate.receipt',
      message: `Receipt ${receiptId} was already posted to Zoho Books as invoice ${row.books_document_id}.`,
      hint: 'No action needed. To post again, delete that invoice in Books and reset the row status first.'
    });
  }

  const total = Number(row.total);
  if (!row.total || Number.isNaN(total) || total <= 0) {
    throw new AppError({
      code: 'TOTAL_MISSING',
      status: 422,
      stage: 'validate.receipt',
      message: `Receipt ${receiptId} has no usable total amount (found: ${JSON.stringify(row.total)}).`,
      hint: 'Enter the correct total on the Data Store row, then retry.'
    });
  }

  if (row.receipt_date && !normaliseDate(row.receipt_date)) {
    throw new AppError({
      code: 'DATE_INVALID',
      status: 422,
      stage: 'validate.receipt',
      message: `Receipt ${receiptId} has a date Books will not accept: "${row.receipt_date}".`,
      hint: 'Correct receipt_date to yyyy-mm-dd on the row, or clear it to use today\'s date.'
    });
  }

  const customerName = String(body.customer_name || body.contact_name || row.contact_name || row.bill_to || '').trim();
  if (!customerName) {
    throw new AppError({
      code: 'CUSTOMER_NAME_MISSING',
      status: 422,
      stage: 'validate.receipt',
      message: 'An invoice needs a customer, but no "Bill To" name was read from the document.',
      hint: 'Send "customer_name" in the request body, or set contact_name on the Data Store row.'
    });
  }

  const authHeader = await getBooksAuthHeader(app);
  const currencyCode = row.currency ? String(row.currency).trim().toUpperCase() : null;
  const { contactId, created: contactCreated } = await findOrCreateCustomer(authHeader, customerName, currencyCode);
  const invoice = await createInvoice(authHeader, row, contactId);

  try {
    await app.datastore().table(RECEIPTS_TABLE).updateRow({
      ROWID: receiptId,
      status: 'posted_to_books',
      contact_name: customerName,
      books_document_id: invoice.id
    });
  } catch (err) {
    throw new AppError({
      code: 'POSTED_BUT_NOT_RECORDED',
      status: 500,
      stage: 'datastore.update',
      message: `The invoice WAS created in Zoho Books (id ${invoice.id}), but receipt ${receiptId} could not be marked as posted.`,
      hint: `Do NOT retry, or Books will get a duplicate invoice. Manually set status = "posted_to_books" and books_document_id = "${invoice.id}" on the row.`,
      cause: err
    });
  }

  // Zoho Books' own response body and status, untouched
  res.writeHead(invoice.response.status, {
    'Content-Type': invoice.response.contentType,
    'X-Request-Id': requestId,
    'X-Receipt-Id': receiptId,
    'X-Contact-Id': contactId,
    'X-Contact-Created': String(contactCreated),
    'Access-Control-Expose-Headers': 'X-Request-Id, X-Receipt-Id, X-Contact-Id, X-Contact-Created'
  });
  return res.end(invoice.response.raw);
}

async function getReceiptRow(app, receiptId) {
  let row;
  try {
    row = await app.datastore().table(RECEIPTS_TABLE).getRow(receiptId);
  } catch (err) {
    throw catalystFailure(err, 'datastore.get');
  }
  if (!row) throw receiptNotFound(receiptId);
  return row;
}

function receiptNotFound(receiptId, cause) {
  return new AppError({
    code: 'RECEIPT_NOT_FOUND',
    status: 404,
    stage: 'datastore.get',
    message: `No row with ROWID ${receiptId} exists in the "${RECEIPTS_TABLE}" table.`,
    hint: 'Check the receipt_id, and that you are calling the same environment (Development vs Production) where it was processed.',
    details: { receipt_id: receiptId },
    cause
  });
}

function datastoreError(err, stage, message, extra = {}) {
  const info = sdkErrorInfo(err);
  let hint = `Check the "${RECEIPTS_TABLE}" table in Cloud Scale > Data Store.`;
  if (/table/i.test(info.sdk_message) && /not|invalid|exist/i.test(info.sdk_message)) {
    hint = `The table "${RECEIPTS_TABLE}" does not seem to exist in this environment. Create it in Cloud Scale > Data Store.`;
  } else if (/column/i.test(info.sdk_message)) {
    hint = 'A column is missing or has the wrong type. See the column list at the top of index.js (doc_number, due_date and bill_to are new).';
  } else if (/permission|scope|unauthori[sz]ed|forbidden/i.test(info.sdk_message) || info.sdk_status === 403) {
    hint = `The function is not allowed to access "${RECEIPTS_TABLE}". Check the table's permissions.`;
  }
  return new AppError({ code: 'DATASTORE_ERROR', status: 502, stage, message, hint, details: { table: RECEIPTS_TABLE, ...extra, ...info }, cause: err });
}

// ===========================================================================
// Route 3: health
// ===========================================================================
async function handleHealthCheck(req, res, app, requestId) {
  const data = {
    health: 'ok',
    timestamp: new Date().toISOString(),
    node_version: process.version,
    has_global_fetch: typeof fetch === 'function',
    books_org_id: CONFIG.ZOHO_BOOKS_ORG_ID,
    creates: 'invoice',
    request_id: requestId
  };

  if (/[?&]deep=true\b/.test(req.url || '')) {
    data.checks = {};
    try {
      await app.datastore().table(RECEIPTS_TABLE).getPagedRows({ maxRows: 1 });
      data.checks.datastore = { status: 'ok' };
    } catch (err) {
      const e = datastoreError(err, 'health.datastore', 'Data Store check failed.');
      data.checks.datastore = { status: 'error', message: e.message, hint: e.hint };
    }
    try {
      await getBooksAuthHeader(app);
      data.checks.books_connection = { status: 'ok', connection: BOOKS_CONNECTION };
    } catch (err) {
      data.checks.books_connection = { status: 'error', error_code: err.code, message: err.message, hint: err.hint };
    }
  }

  const failed = !data.has_global_fetch ||
    Object.values(data.checks || {}).some(c => c.status === 'error');
  data.health = failed ? 'degraded' : 'ok';
  sendRaw(res, failed ? 503 : 200, { status: failed ? 'failure' : 'success', data });
}

// ===========================================================================
// Zoho Books
// ===========================================================================
async function getBooksAuthHeader(app) {
  let creds;
  try {
    creds = await app.connections().getConnectionCredentials(BOOKS_CONNECTION);
  } catch (err) {
    throw catalystFailure(err, 'connections.get_credentials');
  }

  if (!creds) {
    throw new AppError({
      code: 'CONNECTION_EMPTY',
      status: 502,
      stage: 'connections.get_credentials',
      message: `The Connection "${BOOKS_CONNECTION}" returned no credentials.`,
      hint: `Re-authorise "${BOOKS_CONNECTION}" in Cloud Scale > Connections.`
    });
  }
  if (typeof creds === 'string') {
    return { Authorization: creds.startsWith('Zoho-oauthtoken') ? creds : `Zoho-oauthtoken ${creds}` };
  }
  // SDK v3 returns { headers: { Authorization: 'Zoho-oauthtoken ...' }, parameters: {...} }
  const headers = creds.headers || (creds.data && creds.data.headers);
  const headerValue = headers && (headers.Authorization || headers.authorization);
  if (headerValue) return { Authorization: headerValue };

  // const token = creds.access_token || creds.accessToken || (creds.data && creds.data.access_token);
  const token = "1000.c45fe019b049c4052dd19343a28e9d08.ccbcd49dae29d9a0a12c451b0eb089a6";
  if (token) return { Authorization: `Zoho-oauthtoken ${token}` };

  throw new AppError({
    code: 'CONNECTION_UNRECOGNISED_RESPONSE',
    status: 502,
    stage: 'connections.get_credentials',
    message: `The Connection "${BOOKS_CONNECTION}" responded in a format this function does not recognise.`,
    hint: 'Update getBooksAuthHeader() to read the token from the keys listed in details.',
    details: { response_keys: Object.keys(creds) }
  });
}

function booksUrl(pathSegment, extraQuery = {}) {
  const q = new URLSearchParams({ organization_id: CONFIG.ZOHO_BOOKS_ORG_ID, ...extraQuery });
  return `${BOOKS_DOMAIN}/books/v3/${pathSegment}?${q.toString()}`;
}

async function booksFetch(authHeader, pathSegment, { method = 'GET', body, query, stage, payloadForErrors } = {}) {
  const url = booksUrl(pathSegment, query);
  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000)
    });
  } catch (err) {
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AppError({
      code: timedOut ? 'BOOKS_TIMEOUT' : 'BOOKS_UNREACHABLE',
      status: 504,
      stage,
      message: timedOut
        ? `Zoho Books did not respond within 20 seconds (${method} /${pathSegment}).`
        : `Could not reach Zoho Books at ${BOOKS_DOMAIN}.`,
      hint: timedOut
        ? 'Retry shortly, but first check Books for the document in case the first attempt went through.'
        : 'Check CONFIG.ZOHO_BOOKS_DOMAIN in index.js matches the Books data centre (e.g. https://www.zohoapis.com, .eu, .in, .com.au, .sa).',
      details: { books_domain: BOOKS_DOMAIN, endpoint: pathSegment, network_error: err && err.cause ? err.cause.code : err && err.message },
      cause: err
    });
  }

  const raw = await resp.text();
  const contentType = resp.headers.get('content-type') || 'application/json';
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ApiPassthrough(resp.status, raw, contentType, `books /${pathSegment}`);
  }
  if (!resp.ok || data.code !== 0) {
    throw new ApiPassthrough(resp.status, raw, contentType, `books /${pathSegment}`);
  }
  return { status: resp.status, data, raw, contentType };
}

// ---------------------------------------------------------------------------
// Find or create the customer
//   1. GET  /contacts?contact_name=<name>          exact display-name search
//   2. use an existing customer with that name (case/space-insensitive)
//   3. otherwise POST /contacts as a new customer, in the document's currency
//   Books display names are unique, so a VENDOR with the same name blocks creation.
// ---------------------------------------------------------------------------
function sameName(a, b) {
  const norm = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

async function searchContactsByName(authHeader, name) {
  const { data } = await booksFetch(authHeader, 'contacts', {
    query: { contact_name: name },
    stage: 'books.search_customer'
  });
  return (data.contacts || []).filter(c => sameName(c.contact_name, name));
}

async function findOrCreateCustomer(authHeader, name, currencyCode) {
  const matches = await searchContactsByName(authHeader, name);

  const customer = matches.find(c => !c.contact_type || c.contact_type === 'customer');
  if (customer) {
    if (currencyCode && customer.currency_code && customer.currency_code.toUpperCase() !== currencyCode) {
      throw new AppError({
        code: 'CUSTOMER_CURRENCY_MISMATCH',
        status: 422,
        stage: 'books.search_customer',
        message: `Customer "${customer.contact_name}" is billed in ${customer.currency_code}, but the document is in ${currencyCode}. Books invoices always use the customer's currency, so the amount would be recorded in the wrong currency.`,
        hint: 'Correct the currency on the Data Store row if it was misread, or use a customer set up in the document\'s currency.'
      });
    }
    return { contactId: customer.contact_id, created: false };
  }

  const vendor = matches.find(c => c.contact_type === 'vendor');
  if (vendor) {
    throw new AppError({
      code: 'NAME_BELONGS_TO_VENDOR',
      status: 409,
      stage: 'books.search_customer',
      message: `"${vendor.contact_name}" already exists in Books as a vendor, and an invoice needs a customer. Books does not allow a second contact with the same name.`,
      hint: 'Send a different customer_name (e.g. with a suffix), or convert the contact in Books first.'
    });
  }

  const newContact = { contact_name: name.slice(0, 200), company_name: name.slice(0, 200), contact_type: 'customer' };
  if (currencyCode) newContact.currency_id = await getCurrencyId(authHeader, currencyCode);

  try {
    const { data } = await booksFetch(authHeader, 'contacts', {
      method: 'POST',
      body: newContact,
      stage: 'books.create_customer'
    });
    return { contactId: data.contact.contact_id, created: true };
  } catch (err) {
    // Another request may have created it a moment ago: search once more before failing
    if (err instanceof ApiPassthrough && /already\s*exists/i.test(String(err.body))) {
      const retry = (await searchContactsByName(authHeader, name)).find(c => !c.contact_type || c.contact_type === 'customer');
      if (retry) return { contactId: retry.contact_id, created: false };
    }
    throw err;
  }
}

// GET /settings/currencies -> currency_id for a code such as AED or KES
async function getCurrencyId(authHeader, currencyCode) {
  const { data } = await booksFetch(authHeader, 'settings/currencies', { stage: 'books.list_currencies' });
  const currency = (data.currencies || []).find(c => String(c.currency_code).toUpperCase() === currencyCode);
  if (!currency) {
    throw new AppError({
      code: 'CURRENCY_NOT_ENABLED',
      status: 422,
      stage: 'books.list_currencies',
      message: `The document is in ${currencyCode}, but ${currencyCode} is not set up in this Books organisation.`,
      hint: `Add ${currencyCode} under Settings > Currencies in Zoho Books, or correct the currency on the Data Store row if it was misread.`
    });
  }
  return currency.currency_id;
}

async function createInvoice(authHeader, row, customerId) {
  const payload = buildInvoicePayload(row, customerId);
  const response = await booksFetch(authHeader, 'invoices', {
    method: 'POST',
    body: payload,
    stage: 'books.create_invoice'
  });

  const id = response.data.invoice && response.data.invoice.invoice_id;
  if (!id) {
    throw new AppError({
      code: 'BOOKS_ID_MISSING',
      status: 502,
      stage: 'books.create_invoice',
      message: 'Books reported success, but no invoice_id was found in the response.',
      hint: 'The invoice was probably created. Check Books before retrying, then set books_document_id on the row manually.'
    });
  }
  return { id, response };
}

// Books "Create an invoice": customer_id + line_items are the essentials.
// Parsed rows carry pre-tax rates, so they are only used when BOOKS_TAX_ID can add the tax back
// (or the document has no tax). Otherwise one line carries the document total, so the Books
// invoice total always matches the scanned document.
function buildInvoicePayload(row, customerId) {
  let parsed = [];
  try { parsed = JSON.parse(row.line_items || '[]'); } catch (e) { parsed = []; }
  const docHasTax = Number(row.tax) > 0;
  const useParsed = Array.isArray(parsed) && parsed.length > 0 && (Boolean(CONFIG.BOOKS_TAX_ID) || !docHasTax);

  const lineItems = useParsed
    ? parsed.map(li => ({
        name: li.description || DEFAULT_ITEM_NAME,
        description: li.description || `Imported from ${row.file_name || 'OCR'}`,
        quantity: Number(li.quantity) || 1,
        rate: Number(li.rate)
      }))
    : [{
        name: DEFAULT_ITEM_NAME,
        description: `Imported from ${row.file_name || 'OCR'}`,
        quantity: 1,
        rate: Number(row.total)
      }];

  for (const li of lineItems) {
    if (CONFIG.BOOKS_INCOME_ACCOUNT_ID) li.account_id = CONFIG.BOOKS_INCOME_ACCOUNT_ID;
    if (CONFIG.BOOKS_TAX_ID) li.tax_id = CONFIG.BOOKS_TAX_ID;
  }

  const payload = {
    customer_id: customerId,
    date: normaliseDate(row.receipt_date) || todayIso(),
    line_items: lineItems,
    is_inclusive_tax: !useParsed,
    reference_number: (row.doc_number || row.file_name || '').slice(0, 100),
    notes: `Created from scanned document ${row.file_name || ''}`.trim()
  };
  const due = normaliseDate(row.due_date);
  if (due) payload.due_date = due;
  return payload;
}

// ===========================================================================
// Request parsing
// ===========================================================================
function saveUploadToTmp(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    if (!/multipart\/form-data/i.test(contentType)) {
      return reject(new AppError({
        code: 'UPLOAD_WRONG_CONTENT_TYPE',
        status: 415,
        stage: 'upload.parse',
        message: `Expected a multipart/form-data upload but received "${contentType || 'no Content-Type'}".`,
        hint: 'Send the document as form-data in a field named "file" (curl -F "file=@invoice.pdf" ...).'
      }));
    }

    let busboy;
    try {
      busboy = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
    } catch (err) {
      return reject(new AppError({
        code: 'UPLOAD_MALFORMED',
        status: 400,
        stage: 'upload.parse',
        message: 'The multipart request could not be read (missing or invalid boundary).',
        hint: 'Let your HTTP client build the multipart body; do not set Content-Type manually.',
        cause: err
      }));
    }

    let pending = null;
    let failed = false;
    const fail = e => { if (!failed) { failed = true; reject(e); } };
    const seenFields = [];

    busboy.on('file', (fieldname, file, info) => {
      seenFields.push(fieldname);
      const filename = (info && info.filename) || 'upload';
      const mimeType = (info && info.mimeType) || 'application/octet-stream';

      if (pending || fieldname !== 'file') { file.resume(); return; }

      if (!ALLOWED_MIME.test(mimeType)) {
        file.resume();
        return fail(new AppError({
          code: 'UPLOAD_UNSUPPORTED_TYPE',
          status: 415,
          stage: 'upload.parse',
          message: `"${filename}" is a ${mimeType} file, which Zia OCR cannot read.`,
          hint: 'Zia OCR accepts JPG, JPEG, PNG, TIFF, BMP or PDF. Convert WEBP or iPhone HEIC photos first.',
          details: { file_name: filename, mime_type: mimeType }
        }));
      }

      const tmpPath = path.join(os.tmpdir(), `doc_${Date.now()}_${path.basename(filename)}`);
      let size = 0;
      file.on('data', chunk => { size += chunk.length; });
      file.on('limit', () => fail(new AppError({
        code: 'UPLOAD_TOO_LARGE',
        status: 413,
        stage: 'upload.parse',
        message: `"${filename}" is larger than the ${MAX_UPLOAD_BYTES / 1048576} MB upload limit.`,
        hint: `Compress the file, or raise CONFIG.MAX_UPLOAD_MB in index.js (Zia OCR's hard limit is ${ZIA_OCR_MAX_MB} MB).`
      })));

      pending = new Promise((ok, bad) => {
        const out = fs.createWriteStream(tmpPath);
        file.pipe(out);
        out.on('finish', () => ok({ tmpPath, filename, mimeType, size }));
        out.on('error', err => bad(new AppError({
          code: 'UPLOAD_WRITE_FAILED',
          status: 500,
          stage: 'upload.save',
          message: 'The uploaded file could not be written to temporary storage.',
          hint: 'Retry. If it persists, the function\'s temp storage may be full.',
          cause: err
        })));
      });
    });

    busboy.on('error', err => fail(new AppError({
      code: 'UPLOAD_MALFORMED',
      status: 400,
      stage: 'upload.parse',
      message: `The upload could not be parsed: ${err.message}`,
      hint: 'Check the request is a complete multipart/form-data body.',
      cause: err
    })));

    busboy.on('finish', () => {
      if (failed) return;
      if (!pending) {
        return fail(new AppError({
          code: 'UPLOAD_NO_FILE',
          status: 400,
          stage: 'upload.parse',
          message: 'No file was found in the field "file".',
          hint: seenFields.length
            ? `A file was sent in field(s) ${seenFields.map(f => `"${f}"`).join(', ')}. Rename the field to "file".`
            : 'Attach the document in a form-data field named "file".',
          details: { file_fields_received: seenFields }
        }));
      }
      pending.then(result => {
        if (failed) return fs.promises.unlink(result.tmpPath).catch(() => {});
        if (result.size === 0) {
          fs.promises.unlink(result.tmpPath).catch(() => {});
          return fail(new AppError({
            code: 'UPLOAD_EMPTY_FILE',
            status: 400,
            stage: 'upload.parse',
            message: `"${result.filename}" was received but is empty (0 bytes).`,
            hint: 'Re-select the file and upload again.'
          }));
        }
        resolve(result);
      }, fail);
    });

    req.pipe(busboy);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        const parsed = JSON.parse(data);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (e) {
        reject(new AppError({
          code: 'INVALID_JSON',
          status: 400,
          stage: 'validate.request',
          message: `The request body is not valid JSON: ${e.message}`,
          hint: 'Send JSON like {"receipt_id": "1234567890123"} with Content-Type: application/json.',
          details: { received_content_type: req.headers['content-type'] || null, body_preview: data.slice(0, 200) }
        }));
      }
    });
    req.on('error', err => reject(new AppError({
      code: 'REQUEST_READ_FAILED',
      status: 400,
      stage: 'validate.request',
      message: 'The request body could not be read (the connection may have dropped).',
      hint: 'Retry the request.',
      cause: err
    })));
  });
}

// Exposed for local testing only
module.exports._test = { extractFields, normaliseDate };