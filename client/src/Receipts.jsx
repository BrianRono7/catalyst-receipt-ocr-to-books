import { useState } from "react";

// Catalyst Advanced I/O function base path. When this app is hosted in the same
// Catalyst project (Web Client Hosting), the relative path works with no CORS setup.
const API_BASE = "/server/catalyst_receipt_ocr_to_books_function";

const DOC_TYPES = [
  ["expense", "Expense"],
  ["bill", "Bill"],
  ["purchase_order", "Purchase order"],
  ["payment_made", "Payment made"],
  ["invoice", "Invoice"],
  ["quote", "Quote"],
  ["sales_order", "Sales order"],
  ["credit_note", "Credit note"],
  ["payment_received", "Payment received"],
];

const ACCEPT = ".jpg,.jpeg,.png,.tiff,.tif,.bmp,.pdf";

async function callApi(url, options) {
  const res = await fetch(url, options);
  const raw = await res.text();
  let body = raw;
  try { body = JSON.parse(raw); } catch { /* keep raw text */ }
  return { ok: res.ok, status: res.status, body, raw, headers: res.headers };
}

function errorMessage(result) {
  const b = result.body;
  if (b && typeof b === "object") {
    return (b.data && b.data.message) || b.message || `Request failed (HTTP ${result.status}).`;
  }
  return `Request failed (HTTP ${result.status}).`;
}

function pretty(body) {
  return typeof body === "string" ? body : JSON.stringify(body, null, 2);
}

export default function ReceiptToBooks() {
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const [scan, setScan] = useState(null);       // { ok, status, body, receiptId, docType }
  const [docType, setDocType] = useState("expense");
  const [contactName, setContactName] = useState("");
  const [push, setPush] = useState(null);       // { ok, status, body, contactCreated }
  const [error, setError] = useState("");

  function pickFile(f) {
    if (!f) return;
    setFile(f);
    setScan(null);
    setPush(null);
    setError("");
  }

  async function runScan() {
    if (!file) return;
    setBusy("scan");
    setError("");
    setPush(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await callApi(`${API_BASE}/process-receipt`, { method: "POST", body: fd });
      const receiptId = r.headers.get("X-Receipt-Id");
      const guessed = r.headers.get("X-Doc-Type");
      setScan({ ...r, receiptId, docType: guessed });
      if (guessed) setDocType(guessed);
      if (!r.ok) setError(errorMessage(r));
      else if (!receiptId) setError("The text was read, but nothing was saved for posting. The file may contain no readable text.");
    } catch (e) {
      setError(`Could not reach the function at ${API_BASE}. Check the function name and that it is deployed.`);
    } finally {
      setBusy("");
    }
  }

  async function runPush() {
    if (!scan || !scan.receiptId) return;
    setBusy("push");
    setError("");
    try {
      const payload = { receipt_id: scan.receiptId, doc_type: docType };
      if (contactName.trim()) payload.contact_name = contactName.trim();
      const r = await callApi(`${API_BASE}/push-to-books`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setPush({ ...r, contactCreated: r.headers.get("X-Contact-Created") === "true" });
      if (!r.ok) setError(errorMessage(r));
    } catch (e) {
      setError(`Could not reach the function at ${API_BASE}.`);
    } finally {
      setBusy("");
    }
  }

  const ocrText = scan && scan.ok && scan.body && scan.body.data ? scan.body.data.text : "";
  const posted = push && push.ok;

  return (
    <div className="rtb">
      <style>{css}</style>

      <header className="rtb-head">
        <h1>Receipt to Zoho Books</h1>
        <p>Scan a receipt or invoice, check the document type, then post it to Books.</p>
      </header>

      <main className="rtb-grid">
        <section className="rtb-panel">
          <h2><span className="rtb-step">1</span>Scan the document</h2>

          <label
            className={`rtb-drop${dragging ? " is-over" : ""}${file ? " has-file" : ""}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); pickFile(e.dataTransfer.files[0]); }}
          >
            <input type="file" accept={ACCEPT} onChange={e => pickFile(e.target.files[0])} />
            {file ? (
              <>
                <strong>{file.name}</strong>
                <span>{(file.size / 1024 / 1024).toFixed(2)} MB. Click to choose a different file.</span>
              </>
            ) : (
              <>
                <strong>Drop a receipt here, or click to choose</strong>
                <span>JPG, PNG, TIFF, BMP or PDF, up to 20 MB</span>
              </>
            )}
          </label>

          <button className="rtb-btn" onClick={runScan} disabled={!file || busy !== ""}>
            {busy === "scan" ? "Scanning…" : "Scan document"}
          </button>

          <h2 className={!scan || !scan.receiptId ? "is-muted" : ""}>
            <span className="rtb-step">2</span>Post to Zoho Books
          </h2>

          <div className={`rtb-form${!scan || !scan.receiptId ? " is-disabled" : ""}`}>
            <label>
              Document type
              <select value={docType} onChange={e => setDocType(e.target.value)} disabled={!scan || !scan.receiptId || posted}>
                {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              {scan && scan.docType && <small>Detected as {DOC_TYPES.find(d => d[0] === scan.docType)?.[1] || scan.docType}. Change it if that's wrong.</small>}
            </label>

            <label>
              Customer or vendor name <em>(optional)</em>
              <input
                type="text"
                value={contactName}
                onChange={e => setContactName(e.target.value)}
                placeholder="Leave blank to use the name read from the document"
                disabled={!scan || !scan.receiptId || posted}
              />
              <small>A name not already in Books will be created as a new contact.</small>
            </label>

            <button className="rtb-btn" onClick={runPush} disabled={!scan || !scan.receiptId || busy !== "" || posted}>
              {busy === "push" ? "Posting…" : posted ? "Posted to Books" : "Post to Books"}
            </button>
          </div>

          {error && <div className="rtb-alert is-error" role="alert">{error}</div>}
          {posted && (
            <div className="rtb-alert is-ok" role="status">
              {push.body.message || "Posted to Books."}
              {push.contactCreated && " A new contact was created."}
            </div>
          )}
        </section>

        <section className="rtb-output">
          <div className="rtb-paper">
            <h3>Text read from the document</h3>
            {ocrText
              ? <pre>{ocrText}</pre>
              : <p className="rtb-empty">Scan a document to see the text Zia read from it.</p>}
          </div>

          {scan && (
            <details className="rtb-raw" open={!scan.ok}>
              <summary>Scan response · HTTP {scan.status}{scan.receiptId ? ` · receipt ${scan.receiptId}` : ""}</summary>
              <pre>{pretty(scan.body)}</pre>
            </details>
          )}
          {push && (
            <details className="rtb-raw" open>
              <summary>Books response · HTTP {push.status}</summary>
              <pre>{pretty(push.body)}</pre>
            </details>
          )}
        </section>
      </main>
    </div>
  );
}

const css = `
@import url('https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;600;700&family=JetBrains+Mono:wght@400&display=swap');

.rtb {
  --ink: #1B2A41;
  --slate: #5B6B7F;
  --line: #D5DDE6;
  --bg: #EEF2F6;
  --paper: #FFFFFF;
  --teal: #0F7C7E;
  --teal-dark: #0A5E60;
  --red: #B42318;
  --green: #1F7A4D;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  font-family: 'Public Sans', system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.5;
  padding: 32px 20px 48px;
  box-sizing: border-box;
}
.rtb *, .rtb *::before, .rtb *::after { box-sizing: inherit; }

.rtb-head { max-width: 1120px; margin: 0 auto 28px; }
.rtb-head h1 { font-size: 2rem; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.01em; }
.rtb-head p { margin: 0; color: var(--slate); }

.rtb-grid {
  max-width: 1120px; margin: 0 auto;
  display: grid; grid-template-columns: minmax(300px, 420px) 1fr; gap: 24px; align-items: start;
}
@media (max-width: 860px) { .rtb-grid { grid-template-columns: 1fr; } }

.rtb-panel { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 24px; }
.rtb-panel h2 { font-size: 1.125rem; margin: 0 0 14px; display: flex; align-items: center; gap: 10px; }
.rtb-panel h2 + * { margin-top: 0; }
.rtb-panel h2:not(:first-child) { margin-top: 28px; padding-top: 24px; border-top: 1px solid var(--line); }
.rtb-panel h2.is-muted { color: var(--slate); }
.rtb-step {
  width: 26px; height: 26px; border-radius: 50%; background: var(--ink); color: #fff;
  display: inline-grid; place-items: center; font-size: 0.8125rem; font-weight: 700;
}
.is-muted .rtb-step { background: var(--line); color: var(--slate); }

.rtb-drop {
  display: flex; flex-direction: column; gap: 4px; text-align: center; cursor: pointer;
  border: 2px dashed var(--line); border-radius: 10px; padding: 28px 16px; margin-bottom: 14px;
  transition: border-color .15s, background .15s;
}
.rtb-drop input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.rtb-drop strong { font-weight: 600; word-break: break-word; }
.rtb-drop span { color: var(--slate); font-size: 0.875rem; }
.rtb-drop:hover, .rtb-drop.is-over { border-color: var(--teal); background: #F2FAFA; }
.rtb-drop.has-file { border-style: solid; border-color: var(--teal); }
.rtb-drop:focus-within { outline: 3px solid var(--teal); outline-offset: 2px; }

.rtb-form { display: flex; flex-direction: column; gap: 16px; }
.rtb-form.is-disabled { opacity: .55; }
.rtb-form label { display: flex; flex-direction: column; gap: 6px; font-weight: 600; font-size: 0.9375rem; }
.rtb-form em { font-style: normal; font-weight: 400; color: var(--slate); }
.rtb-form small { font-weight: 400; color: var(--slate); font-size: 0.8125rem; }
.rtb-form select, .rtb-form input {
  font: inherit; font-weight: 400; padding: 10px 12px; border: 1px solid var(--line);
  border-radius: 8px; background: #fff; color: var(--ink);
}
.rtb-form select:focus, .rtb-form input:focus { outline: 3px solid var(--teal); outline-offset: 1px; border-color: var(--teal); }

.rtb-btn {
  width: 100%; font: inherit; font-weight: 600; padding: 12px 16px; border: 0; border-radius: 8px;
  background: var(--teal); color: #fff; cursor: pointer;
}
.rtb-btn:hover:not(:disabled) { background: var(--teal-dark); }
.rtb-btn:focus-visible { outline: 3px solid var(--ink); outline-offset: 2px; }
.rtb-btn:disabled { background: var(--line); color: var(--slate); cursor: not-allowed; }

.rtb-alert { margin-top: 18px; padding: 12px 14px; border-radius: 8px; font-size: 0.9375rem; }
.rtb-alert.is-error { background: #FDECEA; color: var(--red); border-left: 4px solid var(--red); }
.rtb-alert.is-ok { background: #E8F5EE; color: var(--green); border-left: 4px solid var(--green); }

.rtb-output { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.rtb-paper {
  background: var(--paper); border: 1px solid var(--line); border-radius: 4px;
  box-shadow: 0 1px 0 var(--line), 0 12px 24px -18px rgba(27, 42, 65, .35);
  padding: 20px 22px; min-height: 320px;
  background-image: repeating-linear-gradient(transparent 0 27px, #F1F4F8 27px 28px);
}
.rtb-paper h3 { margin: 0 0 12px; font-size: 1rem; }
.rtb-paper pre, .rtb-raw pre {
  font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 0.8125rem; line-height: 1.55;
  margin: 0; overflow-x: auto; white-space: pre;
}
.rtb-empty { color: var(--slate); margin: 0; }

.rtb-raw { background: var(--ink); color: #E6EDF5; border-radius: 10px; overflow: hidden; }
.rtb-raw summary { cursor: pointer; padding: 12px 16px; font-weight: 600; font-size: 0.9375rem; }
.rtb-raw summary:focus-visible { outline: 3px solid var(--teal); outline-offset: -3px; }
.rtb-raw pre { padding: 0 16px 16px; max-height: 360px; overflow: auto; }

@media (prefers-reduced-motion: reduce) { .rtb-drop { transition: none; } }
`;