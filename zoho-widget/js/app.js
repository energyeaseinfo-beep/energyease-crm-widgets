/* EnergyEase Action Panels widget: runs inside Zoho CRM, fetches deals via Embedded App SDK */

const ACTIVE_STAGES = ["Closed Won", "Scheduled Execution", "Project Started", "Project Done"];
const PIPELINE_FILTER = "Regular";
const FIELDS = "id,Reference_Number,Deal_Name,Stage,Amount,Owner,Modified_Time,Created_Time,Closing_Date,Tag,Pipeline";

const root = document.getElementById("root");
let TODAY = new Date(); // reset on every (re)load so ages stay correct after Refresh

// Subsidy-linked tags: invoicing of these deals usually depends on a programme approval
const SUBSIDY_TAGS = ["Green Fund", "Bairros+Sustentaveis"];

function log(...args) {
  if (window.console) console.log("[EnergyEase Widget]", ...args);
}

function fmtEur(n) {
  if (n === null || n === undefined || isNaN(n)) return "€0";
  return "€" + Math.round(n).toLocaleString("en-US");
}

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Math.floor((TODAY - d) / (1000 * 60 * 60 * 24));
}

// Days since the deal was last changed in CRM (NOT days since an invoice or stage change)
function ageStr(d) {
  const days = daysSince(d.Modified_Time);
  return days === null ? "-" : days + "d";
}

function hasTag(deal, name) {
  return (deal.Tag || []).some(t => (t.name || "").toLowerCase() === name.toLowerCase());
}

function tagNames(deal) {
  return (deal.Tag || []).map(t => (t.name || "").trim());
}

// ---------- Payment terms read from tags ----------
// "Paid 25%", "Paid 45%", "Paid 50%", "paid 100%"  -> share of the contract already paid (highest wins)
// "Cetelem Paid Upfront"                            -> fully paid
// "First 25%", "First 30% sent", "First 50% sent"   -> first invoice sent, with that share
// "5% Discount" (any "<n>% Discount")               -> contract value reduced by n%
function paidShare(d) {
  let best = null;
  tagNames(d).forEach(n => {
    const m = n.match(/^paid\s+(\d{1,3})\s*%$/i);
    if (m) { const v = Math.min(Number(m[1]), 100) / 100; if (best === null || v > best) best = v; }
  });
  if (hasTag(d, "Cetelem Paid Upfront")) best = 1;
  return best;
}
function firstSentShare(d) {
  let share = null;
  tagNames(d).forEach(n => {
    const m = n.match(/^first\s+(\d{1,3})\s*%(\s+sent)?$/i);
    if (m) share = Math.min(Number(m[1]), 100) / 100;
  });
  return share;
}
function discountShare(d) {
  let disc = 0;
  tagNames(d).forEach(n => {
    const m = n.match(/^(\d{1,2}(?:[.,]\d+)?)\s*%\s*discount$/i);
    if (m) disc = Math.max(disc, Number(m[1].replace(",", ".")) / 100);
  });
  return disc;
}
// Tags set every hour by the InvoiceXpress sync (CRM function "EE Faturas Sync").
// Used when the Faturas module is not readable for the current user.
// "1st payment received"                -> first invoice paid (share unknown, assume 50%)
// "Awaiting payment", "Payment overdue" -> invoice sent, not paid yet (final invoice in Project Done)
// "Invoice to send", "Final invoice to send" -> nothing extra to derive
function syncTags(d) {
  return {
    firstPaid: hasTag(d, "1st payment received"),
    sentOpen: hasTag(d, "Awaiting payment") || hasTag(d, "Payment overdue")
  };
}
function paymentTerms(d) {
  const contract = (Number(d.Amount) || 0) * (1 - discountShare(d));
  const sync = syncTags(d);
  let paid = paidShare(d);
  if (paid === null && sync.firstPaid) paid = 0.5;
  const sentShare = firstSentShare(d);
  const fullPaid = paid !== null && paid >= 1;
  const firstPaid = paid !== null;
  const firstSent = sentShare !== null || firstPaid || sync.sentOpen;
  // Share of the contract covered by the first invoice: what was paid, else what was sent, else 50%
  const firstShare = fullPaid ? 1 : (paid !== null ? paid : (sentShare !== null ? sentShare : 0.5));
  return {
    contract, fullPaid, firstPaid, firstSent, firstShare,
    firstAmt: contract * firstShare,
    restAmt: contract * (1 - firstShare),
    lastSent: hasTag(d, "Sent last invoice") || (d.Stage === "Project Done" && sync.sentOpen),
    subsidy: SUBSIDY_TAGS.some(t => hasTag(d, t))
  };
}

function tagPills(deal) {
  return (deal.Tag || [])
    .map(t => `<span class="tag-pill">${escapeHtml(t.name)}</span>`)
    .join("");
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderError(msg, detail) {
  root.innerHTML = `
    <div class="error-state">
      <strong>Couldn't load deals.</strong><br>
      ${escapeHtml(msg)}<br>
      ${detail ? `<small style="opacity:0.7;">${escapeHtml(detail)}</small>` : ""}
    </div>`;
}

// ============== DRILL-DOWN MODAL ==============
window.__drillData = window.__drillData || {};
// tileValue (optional): the amount the tile shows, which can differ from the sum of full deal values
function registerDrill(key, title, subtitle, deals, tileValue) {
  window.__drillData[key] = { title, subtitle, deals, tileValue };
}

function renderDrillRow(d) {
  const owner = (d.Owner && (d.Owner.name || d.Owner.full_name)) || "-";
  const ref = d.Reference_Number || ("#" + (d.id || "").slice(-4));
  const name = d.Deal_Name || "(no name)";
  const stage = d.Stage || "-";
  const amount = d.Amount ? fmtEur(d.Amount) : "-";
  const age = ageStr(d);
  const tagsList = (d.Tag || []).map(t => escapeHtml(t.name)).join(", ") || "-";
  return `<tr class="drill-row" data-deal-id="${escapeHtml(d.id)}" onclick="window.__openDealInCrm('${escapeHtml(d.id)}')">
    <td class="drill-ref">${escapeHtml(ref)}</td>
    <td class="drill-name">${escapeHtml(name)}</td>
    <td>${escapeHtml(owner)}</td>
    <td>${escapeHtml(stage)}</td>
    <td class="num">${amount}</td>
    <td>${age}</td>
    <td class="drill-tags">${tagsList}</td>
  </tr>`;
}

window.__showDrill = function (key) {
  const item = window.__drillData[key];
  if (!item) { log("No drill data for key", key); return; }
  openDrillModal(item.title, item.subtitle, item.deals, item.tileValue);
};

function openDrillModal(title, subtitle, deals, tileValue) {
  let container = document.getElementById("drill-modal-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "drill-modal-container";
    document.body.appendChild(container);
  }
  const sortedDeals = (deals || []).slice().sort((a, b) =>
    new Date(b.Modified_Time || 0) - new Date(a.Modified_Time || 0)
  );
  const totalAmount = sortedDeals.reduce((s, d) => s + (Number(d.Amount) || 0), 0);
  container.innerHTML = `<div class="modal-overlay" onclick="window.__closeDrill(event)">
    <div class="modal-card" onclick="event.stopPropagation()">
      <div class="modal-header">
        <div class="modal-titleblock">
          <h3>${escapeHtml(title)}</h3>
          <div class="modal-subtitle">${escapeHtml(subtitle || '')}</div>
          <div class="modal-stats">
            <span><strong>${sortedDeals.length}</strong> deal${sortedDeals.length === 1 ? '' : 's'}</span>
            ${tileValue !== undefined && tileValue !== null ? `<span>In this tile: <strong>${fmtEur(tileValue)}</strong></span>` : ""}
            <span>Full deal value: <strong>${fmtEur(totalAmount)}</strong></span>
          </div>
        </div>
        <button class="modal-close" onclick="window.__closeDrill()" aria-label="Close">×</button>
      </div>
      <div class="modal-controls">
        <input type="text" class="modal-search" placeholder="🔍 Filter by name, owner, stage, tag…" oninput="window.__filterDrill(this.value)" autofocus>
      </div>
      <div class="modal-body">
        <table class="modal-table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Deal Name</th>
              <th>Owner</th>
              <th>Stage</th>
              <th class="num">Amount</th>
              <th title="Days since the deal was last changed in CRM">Last change</th>
              <th>Tags</th>
            </tr>
          </thead>
          <tbody id="modal-tbody">
            ${sortedDeals.length ? sortedDeals.map(d => renderDrillRow(d)).join('') : '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:20px;">No deals match</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="modal-footer">
        <span class="modal-footer-hint">Click any row to open the deal in Zoho CRM · ESC or click outside to close</span>
      </div>
    </div>
  </div>`;
  container.style.display = "block";
  setTimeout(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        window.__closeDrill();
        document.removeEventListener("keydown", handler);
      }
    };
    document.addEventListener("keydown", handler);
  }, 0);
}

window.__closeDrill = function () {
  const c = document.getElementById("drill-modal-container");
  if (c) c.style.display = "none";
};
window.__filterDrill = function (query) {
  const q = (query || "").toLowerCase();
  document.querySelectorAll("#modal-tbody tr").forEach(tr => {
    const text = tr.textContent.toLowerCase();
    tr.style.display = (!q || text.includes(q)) ? "" : "none";
  });
};
window.__openDealInCrm = function (dealId) {
  if (window.ZOHO && ZOHO.CRM && ZOHO.CRM.UI && ZOHO.CRM.UI.Record) {
    ZOHO.CRM.UI.Record.open({ Entity: "Deals", RecordID: dealId }).catch(e => log("open error", e));
  }
};

function classifyClosedWon(d) {
  const t = paymentTerms(d);
  if (t.fullPaid) return "ok";
  if (t.lastSent) return "payment-overdue"; // final invoice already sent, not yet paid
  // A paid first invoice counts as sent, even if the "First x% sent" tag was never set
  if (t.firstPaid) return "ok";
  if (hasTag(d, "Waiting Cetelem")) return "cetelem-pending";
  if (!t.firstSent) return "invoice-todo";
  return "payment-overdue";
}

function classifyScheduled(d) {
  const t = paymentTerms(d);
  if (t.fullPaid) return "ok";
  if (t.lastSent) return "payment-overdue"; // final invoice already sent, not yet paid
  if (t.firstPaid) return "ok";
  if (!t.firstSent) return "invoice-todo";
  return "payment-overdue";
}

function classifyProjectDone(d) {
  const t = paymentTerms(d);
  if (t.fullPaid) return "ok";
  if (!t.lastSent) return "invoice-todo";
  return "payment-overdue";
}

function invoiceCell(f, d) {
  let txt, tip;
  if (f.overdue > 0) { txt = `${fmtEur(f.overdue)} · ${f.maxDays}d late`; tip = "Open past the due date"; }
  else if (f.open > 0) { txt = `${fmtEur(f.open)} open`; tip = "Invoice sent, not due yet"; }
  else if (f.invoicedNothing || (d.Stage === "Project Done" && f.toInvoice > f.tol)) { txt = `${fmtEur(f.invoicedNothing && d.Stage !== "Project Done" ? f.value * 0.5 : f.toInvoice)} to invoice`; tip = "Not invoiced yet"; }
  else { txt = `${fmtEur(f.paid)} paid`; tip = "Received so far, excl. VAT"; }
  return `<div class="age inv-cell" title="${tip}">${txt}</div>`;
}

function rowHtml(d, cls) {
  const ownerName = (d.Owner && (d.Owner.name || d.Owner.full_name)) || "-";
  const ref = d.Reference_Number || "-";
  return `<div class="action-row ${cls}" data-deal-id="${d.id}">
    <div class="ref">${escapeHtml(ref)}</div>
    <div class="name" title="${escapeHtml(d.Deal_Name)}">${escapeHtml(d.Deal_Name)}</div>
    <div class="owner">${escapeHtml(ownerName)}</div>
    <div class="amount">${fmtEur(d.Amount)}</div>
    ${INVOICE_MODE && INV_FIG.get(d.id) ? invoiceCell(INV_FIG.get(d.id), d) : `<div class="age" title="Days since the deal was last changed in CRM (not since the invoice)">${ageStr(d)}</div>`}
    <div class="tags">${tagPills(d)}</div>
  </div>`;
}

function groupHtml(title, items, cls, drillKey) {
  if (!items.length) return "";
  if (drillKey) registerDrill(drillKey, title, `${items.length} deals in this bucket`, items);
  const clickable = drillKey ? `clickable" onclick="window.__showDrill('${drillKey}')` : "";
  return `<div class="action-group ${cls}">
    <div class="action-group-title ${clickable}"><span>${escapeHtml(title)}</span><span class="group-count">${items.length}</span></div>
    ${items.map(d => rowHtml(d, cls)).join("")}
  </div>`;
}

function panelHtml(stageName, dealsInStage, classifyFn, actionNote) {
  if (!dealsInStage.length) {
    return `<div class="stage-panel">
      <div class="stage-panel-header"><h3>${escapeHtml(stageName)}</h3><span class="count">0 deals</span></div>
      <div class="stage-empty">No deals currently in this stage.</div>
    </div>`;
  }
  const buckets = { "invoice-todo": [], "payment-overdue": [], "awaiting": [], "cetelem-pending": [], "ok": [] };
  dealsInStage.forEach(d => {
    const c = classifyFn(d);
    (buckets[c] || buckets.ok).push(d);
  });
  const todo = buckets["invoice-todo"].length + buckets["payment-overdue"].length + buckets["cetelem-pending"].length;
  const stageKeyName = stageName.replace(/[^a-z0-9]/gi, "_");
  registerDrill(`stage_${stageKeyName}_all`, `${stageName}: all deals`, `${dealsInStage.length} deals in stage · ${todo} need action`, dealsInStage);
  let html = `<div class="stage-panel">
    <div class="stage-panel-header clickable" onclick="window.__showDrill('stage_${stageKeyName}_all')">
      <h3>${escapeHtml(stageName)} <span style="font-weight:400; color:#64748b; font-size:11px;">&middot; ${escapeHtml(actionNote)}</span></h3>
      <span class="count">${dealsInStage.length} deals · ${todo} need action</span>
    </div>`;
  const stageKey = stageName.replace(/[^a-z0-9]/gi, "_");
  html += groupHtml(stageName === "Project Done" ? "Final invoice still to send" : (INVOICE_MODE && stageName === "Other stages" ? "Invoice still to send" : "1st invoice still to send"),
                    buckets["invoice-todo"], "invoice-todo", `stage_${stageKey}_todo`);
  html += groupHtml(INVOICE_MODE ? "Payment overdue" : "Payment not received yet", buckets["payment-overdue"], "payment-overdue", `stage_${stageKey}_overdue`);
  html += groupHtml("Invoice sent, not due yet", buckets["awaiting"], "awaiting", `stage_${stageKey}_awaiting`);
  if (buckets["cetelem-pending"].length) {
    registerDrill(`stage_${stageKey}_cetelem`, `${stageName}: awaiting Cetelem approval`, `${buckets["cetelem-pending"].length} deals awaiting Cetelem decision`, buckets["cetelem-pending"]);
    html += `<div class="action-group">
      <div class="action-group-title clickable" style="color:#1e40af;" onclick="window.__showDrill('stage_${stageKey}_cetelem')"><span>Awaiting Cetelem approval</span><span class="group-count" style="background:#3b82f6;">${buckets["cetelem-pending"].length}</span></div>
      ${buckets["cetelem-pending"].map(d => rowHtml(d, "warn")).join("")}
    </div>`;
  }
  if (buckets.ok.length) html += groupHtml("On track", buckets.ok, "ok", `stage_${stageKey}_ok`);
  html += "</div>";
  return html;
}

function computeCashSummary(deals) {
  // Payment terms per deal come from paymentTerms() (tags): first-invoice share = "Paid x%" or
  // "First x% sent" (default 50%), "paid 100%"/"Cetelem Paid Upfront" = fully paid, "x% Discount"
  // lowers the contract value. Every won deal that is not fully paid contributes its remaining
  // invoice(s) to "still to receive", including Closed Won deals that have not started yet.
  let firstOutstandingValue = 0, firstOutstandingDeals = [];
  let secondOutstandingValue = 0, secondOutstandingDeals = [];
  let toInvoiceFirstValue = 0, toInvoiceFirstDeals = [];
  let toInvoiceSecondValue = 0, toInvoiceSecondDeals = [];
  let inExecutionValue = 0, inExecutionDeals = [];
  let inExecutionReceived = 0;
  let wonNotStartedValue = 0, wonNotStartedReceived = 0, wonNotStartedDeals = [];
  let futureSecond = 0, futureSecondDeals = [];
  let toInvoiceSubsidyValue = 0;

  deals.forEach(d => {
    const stage = d.Stage;
    const t = paymentTerms(d);
    const receivedSoFar = t.fullPaid ? t.contract : (t.firstPaid ? t.firstAmt : 0);

    const addFirstInvoice = () => {
      if (t.fullPaid || t.firstPaid) return;
      if (t.firstSent) { firstOutstandingValue += t.firstAmt; firstOutstandingDeals.push(d); }
      else {
        toInvoiceFirstValue += t.firstAmt; toInvoiceFirstDeals.push(d);
        if (t.subsidy) toInvoiceSubsidyValue += t.firstAmt;
      }
    };
    const addRemainder = () => {
      if (t.fullPaid || t.restAmt <= 0) return;
      if (t.lastSent) { secondOutstandingValue += t.restAmt; secondOutstandingDeals.push(d); }
      else { futureSecond += t.restAmt; futureSecondDeals.push(d); }
    };

    if (stage === "Closed Won") {
      wonNotStartedValue += t.contract; wonNotStartedReceived += receivedSoFar; wonNotStartedDeals.push(d);
      addFirstInvoice();
      addRemainder();
    }
    if (stage === "Scheduled Execution" || stage === "Project Started") {
      inExecutionValue += t.contract; inExecutionReceived += receivedSoFar; inExecutionDeals.push(d);
      addFirstInvoice();
      addRemainder();
    }
    if (stage === "Project Done") {
      if (t.fullPaid) {
        // Fully paid, nothing outstanding.
      } else if (!t.lastSent) {
        toInvoiceSecondValue += t.restAmt; toInvoiceSecondDeals.push(d);
        if (t.subsidy) toInvoiceSubsidyValue += t.restAmt;
      } else {
        secondOutstandingValue += t.restAmt; secondOutstandingDeals.push(d);
      }
    }
  });

  const totalOutstanding = firstOutstandingValue + secondOutstandingValue;
  const totalOutstandingDeals = Array.from(new Set([...firstOutstandingDeals, ...secondOutstandingDeals]));
  const toInvoiceNow = toInvoiceFirstValue + toInvoiceSecondValue;
  const toInvoiceNowDeals = [...toInvoiceFirstDeals, ...toInvoiceSecondDeals];
  const stillToReceive = totalOutstanding + toInvoiceNow + futureSecond;
  const stillToReceiveDeals = Array.from(new Set([
    ...totalOutstandingDeals, ...toInvoiceNowDeals, ...futureSecondDeals
  ]));

  return {
    toInvoiceNow, toInvoiceNowCount: toInvoiceFirstDeals.length + toInvoiceSecondDeals.length,
    toInvoiceFirstCount: toInvoiceFirstDeals.length, toInvoiceSecondCount: toInvoiceSecondDeals.length,
    toInvoiceNowDeals, toInvoiceFirstDeals, toInvoiceSecondDeals, toInvoiceSubsidyValue,
    firstOutstandingValue, firstOutstandingCount: firstOutstandingDeals.length, firstOutstandingDeals,
    secondOutstandingValue, secondOutstandingCount: secondOutstandingDeals.length, secondOutstandingDeals,
    totalOutstanding, totalOutstandingCount: totalOutstandingDeals.length, totalOutstandingDeals,
    inExecutionValue, inExecutionCount: inExecutionDeals.length, inExecutionReceived, inExecutionDeals,
    wonNotStartedValue, wonNotStartedReceived, wonNotStartedDeals,
    futureSecond, futureSecondDeals, stillToReceive, stillToReceiveDeals
  };
}

function outstandingHtml(c) {
  registerDrill("out_first", "1st invoice outstanding", `${c.firstOutstandingCount} deals · 1st invoice sent (per tags) but not yet paid`, c.firstOutstandingDeals, c.firstOutstandingValue);
  registerDrill("out_second", "2nd invoice outstanding", `${c.secondOutstandingCount} deals · final invoice sent (per tags) but not yet paid`, c.secondOutstandingDeals, c.secondOutstandingValue);
  registerDrill("out_total", "Total outstanding invoices", `${c.totalOutstandingCount} deals with an unpaid invoice (1st and final combined)`, c.totalOutstandingDeals, c.totalOutstanding);
  return `<div class="outstanding-box">
    <h2>💸 Cash summary: money outstanding</h2>
    <div class="outstanding-subtitle">Estimated from CRM tags, per deal &middot; amounts excl. VAT (deal value) &middot; click any tile to see the deals behind it</div>
    <div class="outstanding-grid">
      <div class="outstanding-tile first clickable" onclick="window.__showDrill('out_first')">
        <div class="outstanding-label">1st invoice outstanding</div>
        <div class="outstanding-value">${fmtEur(c.firstOutstandingValue)}</div>
        <div class="outstanding-detail">${c.firstOutstandingCount} deal${c.firstOutstandingCount === 1 ? "" : "s"} &middot; 1st-invoice portion only</div>
      </div>
      <div class="outstanding-tile second clickable" onclick="window.__showDrill('out_second')">
        <div class="outstanding-label">2nd invoice outstanding</div>
        <div class="outstanding-value">${fmtEur(c.secondOutstandingValue)}</div>
        <div class="outstanding-detail">${c.secondOutstandingCount} deal${c.secondOutstandingCount === 1 ? "" : "s"} &middot; final-invoice portion only</div>
      </div>
      <div class="outstanding-tile total clickable" onclick="window.__showDrill('out_total')">
        <div class="outstanding-label">Total outstanding</div>
        <div class="outstanding-value">${fmtEur(c.totalOutstanding)}</div>
        <div class="outstanding-detail">${c.totalOutstandingCount} deal${c.totalOutstandingCount === 1 ? "" : "s"} with an unpaid invoice</div>
      </div>
    </div>
    <div class="outstanding-note">
      <strong>How this is calculated:</strong> the first invoice is 50% of the deal unless a tag says otherwise: "Paid x%" or "First x% sent" sets the share (e.g. Paid 45%, First 30% sent). "paid 100%" and "Cetelem Paid Upfront" mean fully paid. "x% Discount" lowers the deal value. "Sent last invoice" means the final invoice is out.<br>
      <strong>Tags only:</strong> these figures are as good as the tags. InvoiceXpress is the source of truth for which invoices are open or overdue.
    </div>
  </div>`;
}

function cashSummaryHtml(c) {
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const subsidyNote = c.toInvoiceSubsidyValue > 0
    ? ` &middot; of which ${fmtEur(c.toInvoiceSubsidyValue)} subsidy-tagged`
    : "";
  registerDrill("cash_to_invoice", "To invoice NOW",
    `${c.toInvoiceFirstCount}× 1st invoice + ${c.toInvoiceSecondCount}× final invoice not sent yet` +
    (c.toInvoiceSubsidyValue > 0 ? ` · ${fmtEur(c.toInvoiceSubsidyValue)} depends on a subsidy programme (Green Fund / Bairros+Sustentaveis tag)` : ""),
    c.toInvoiceNowDeals, c.toInvoiceNow);
  registerDrill("cash_outstanding", "Outstanding invoices", `${c.totalOutstandingCount} deals with an invoice sent (per tags) but not paid`, c.totalOutstandingDeals, c.totalOutstanding);
  registerDrill("cash_wonwait", "Won, not started: contract value", `${c.wonNotStartedDeals.length} Closed Won deals · ${fmtEur(c.wonNotStartedReceived)} already received of ${fmtEur(c.wonNotStartedValue)}`, c.wonNotStartedDeals, c.wonNotStartedValue);
  registerDrill("cash_inexec", "In execution: contract value", `${c.inExecutionCount} ongoing projects · ${fmtEur(c.inExecutionReceived)} already received of ${fmtEur(c.inExecutionValue)} contract value`, c.inExecutionDeals, c.inExecutionValue);
  registerDrill("cash_future", "After project completion", `${c.futureSecondDeals.length} won deals whose final invoice follows completion (fully paid deals excluded)`, c.futureSecondDeals, c.futureSecond);
  registerDrill("cash_total", "Total still to receive", `Outstanding + to invoice now + after completion · ${c.stillToReceiveDeals.length} deals`, c.stillToReceiveDeals, c.stillToReceive);
  return `<div class="cash-summary">
    <div class="cash-tile action clickable" onclick="window.__showDrill('cash_to_invoice')">
      <div class="cash-label">To invoice NOW</div>
      <div class="cash-value">${fmtEur(c.toInvoiceNow)}</div>
      <div class="cash-detail">${c.toInvoiceFirstCount}&times; 1st + ${c.toInvoiceSecondCount}&times; final invoice${subsidyNote}</div>
    </div>
    <div class="cash-tile outstanding clickable" onclick="window.__showDrill('cash_outstanding')">
      <div class="cash-label">Outstanding invoices</div>
      <div class="cash-value">${fmtEur(c.totalOutstanding)}</div>
      <div class="cash-detail">${plural(c.totalOutstandingCount, "deal")} &middot; sent, not paid</div>
    </div>
    <div class="cash-tile won clickable" onclick="window.__showDrill('cash_wonwait')">
      <div class="cash-label">Won, not started</div>
      <div class="cash-value">${fmtEur(c.wonNotStartedValue)}</div>
      <div class="cash-detail">${plural(c.wonNotStartedDeals.length, "deal")} in Closed Won &middot; ${fmtEur(c.wonNotStartedReceived)} received</div>
    </div>
    <div class="cash-tile in-progress clickable" onclick="window.__showDrill('cash_inexec')">
      <div class="cash-label">In execution</div>
      <div class="cash-value">${fmtEur(c.inExecutionValue)}</div>
      <div class="cash-detail">${plural(c.inExecutionCount, "project")} &middot; ${fmtEur(c.inExecutionReceived)} received</div>
    </div>
    <div class="cash-tile future clickable" onclick="window.__showDrill('cash_future')">
      <div class="cash-label">After project completion</div>
      <div class="cash-value">${fmtEur(c.futureSecond)}</div>
      <div class="cash-detail">final invoices of won deals, not due yet</div>
    </div>
    <div class="cash-tile received clickable" onclick="window.__showDrill('cash_total')">
      <div class="cash-label">Total still to receive</div>
      <div class="cash-value">${fmtEur(c.stillToReceive)}</div>
      <div class="cash-detail">outstanding + to invoice + after completion</div>
    </div>
  </div>`;
}

// Green Fund is a pre-won stage (between Quote Sent and Negotiation/Review): the customer said yes,
// but the deal waits for the subsidy programme. Not part of the cash figures above.
function greenFundHtml(gfDeals) {
  if (!gfDeals.length) return "";
  const value = gfDeals.reduce((s, d) => s + (Number(d.Amount) || 0), 0);
  const ipss = gfDeals.filter(d => hasTag(d, "Pending IPSS Verification"));
  const old = gfDeals.filter(d => { const n = daysSince(d.Created_Time); return n !== null && n > 180; });
  registerDrill("gf_all", "Green Fund: waiting for subsidy", `${gfDeals.length} deals · not won yet, not in the cash figures`, gfDeals);
  registerDrill("gf_ipss", "Green Fund: Pending IPSS Verification", `${ipss.length} deals waiting for IPSS verification`, ipss);
  registerDrill("gf_old", "Green Fund: created more than 6 months ago", `${old.length} deals · check whether they are still alive`, old);
  return `<div class="stage-panel gf-panel">
    <div class="stage-panel-header clickable" onclick="window.__showDrill('gf_all')">
      <h3>Green Fund <span style="font-weight:400; color:#64748b; font-size:11px;">&middot; waiting for subsidy, not won yet, not in the cash figures above</span></h3>
      <span class="count">${gfDeals.length} deals &middot; ${fmtEur(value)}</span>
    </div>
    <div class="gf-grid">
      <div class="gf-tile clickable" onclick="window.__showDrill('gf_ipss')">
        <div class="cash-label">Pending IPSS Verification</div>
        <div class="cash-value">${ipss.length}</div>
        <div class="cash-detail">${fmtEur(ipss.reduce((s, d) => s + (Number(d.Amount) || 0), 0))}</div>
      </div>
      <div class="gf-tile clickable" onclick="window.__showDrill('gf_old')">
        <div class="cash-label">Created &gt; 6 months ago</div>
        <div class="cash-value">${old.length}</div>
        <div class="cash-detail">${fmtEur(old.reduce((s, d) => s + (Number(d.Amount) || 0), 0))}</div>
      </div>
    </div>
  </div>`;
}

// ======================================================================
// INVOICE MODE: figures from the Faturas module (synced from InvoiceXpress)
// Same rules as the sync function that sets the payment tags.
// ======================================================================
const FATURAS_MODULE = "Faturas";
let INVOICE_MODE = false;   // true when the Faturas module could be read
let INV_FIG = new Map();     // deal id -> invoiceFigures, for the rows
const SKIP_STATUS = new Set(["Canceled", "Draft"]);
const num = v => Number(v) || 0;

function dealRef(d) { return d.Reference_Number || ("#" + String(d.id || "").slice(-4)); }

// Per-deal invoice figures (all amounts excl. VAT)
function invoiceFigures(d, docs) {
  docs = (docs || []).filter(f => !SKIP_STATUS.has(f.Payment_Status));
  const disc = discountShare(d);
  const qvals = new Set();
  let net = 0, paid = 0, open = 0, overdue = 0, maxDays = 0;
  docs.forEach(f => {
    net += num(f.Amount_excl_VAT);
    open += num(f.Open_excl_VAT);
    const days = num(f.Days_Overdue);
    if (days > 0) { overdue += num(f.Open_excl_VAT); maxDays = Math.max(maxDays, days); }
    if (f.Document_Type !== "Credit note") {
      const tot = num(f.Total_incl_VAT);
      if (tot) paid += num(f.Paid_incl_VAT) * num(f.Amount_excl_VAT) / tot;
      qvals.add(num(f.Quote_Value));
    }
  });
  const quoteBased = Array.from(qvals).reduce((s, v) => s + v, 0);
  const value = (qvals.size ? quoteBased : num(d.Amount)) * (1 - disc);
  const tol = Math.max(1, 0.01 * value);
  const toInvoice = Math.max(value - net, 0);
  const crmMismatch = qvals.size > 0 && Math.abs(quoteBased - num(d.Amount)) > Math.max(1, 0.01 * num(d.Amount));
  return { docs, value, net, paid, open, overdue, maxDays, toInvoice, tol, crmMismatch, invoicedNothing: net <= tol };
}

// Same decision as the payment tags
function invoiceStatus(d, f) {
  if (f.invoicedNothing) return "invoice-todo";
  if (f.overdue > 0) return "payment-overdue";
  if (d.Stage === "Project Done" && f.toInvoice > f.tol) return "invoice-todo";
  if (f.open > 0) return "awaiting";
  return "ok";
}

function computeCashFromInvoices(deals, inv) {
  const c = {
    overdue: 0, overdueDocs: [], notDue: 0, notDueDocs: [], aging: { a: 0, b: 0, c: 0 },
    toInvoiceNow: 0, toInvoiceFirstDeals: [], toInvoiceFinalDeals: [], toInvoiceSubsidyValue: 0,
    wonNotStartedValue: 0, wonNotStartedReceived: 0, wonNotStartedDeals: [],
    inExecutionValue: 0, inExecutionReceived: 0, inExecutionDeals: [],
    futureSecond: 0, futureSecondDeals: [], stillToReceiveDeals: new Set(), mismatchDeals: []
  };
  deals.forEach(d => {
    const f = inv.get(d.id);
    const subsidy = SUBSIDY_TAGS.some(t => hasTag(d, t));
    f.docs.forEach(doc => {
      const o = num(doc.Open_excl_VAT);
      if (o <= 0) return;
      doc.__deal = d;
      const days = num(doc.Days_Overdue);
      if (days > 0) {
        c.overdue += o; c.overdueDocs.push(doc);
        if (days <= 30) c.aging.a += o; else if (days <= 90) c.aging.b += o; else c.aging.c += o;
      } else { c.notDue += o; c.notDueDocs.push(doc); }
      c.stillToReceiveDeals.add(d);
    });
    if (f.crmMismatch) c.mismatchDeals.push(d);
    let nowAmt = 0, laterAmt = 0;
    if (d.Stage === "Project Done") {
      nowAmt = f.toInvoice > f.tol ? f.toInvoice : 0;
      if (nowAmt) c.toInvoiceFinalDeals.push(d);
    } else if (f.invoicedNothing) {
      nowAmt = f.value * 0.5;            // 1st invoice, default 50%
      laterAmt = f.value - nowAmt;
      c.toInvoiceFirstDeals.push(d);
    } else {
      laterAmt = f.toInvoice > f.tol ? f.toInvoice : 0;
    }
    c.toInvoiceNow += nowAmt;
    if (subsidy) c.toInvoiceSubsidyValue += nowAmt;
    if (nowAmt) c.stillToReceiveDeals.add(d);
    if (laterAmt) { c.futureSecond += laterAmt; c.futureSecondDeals.push(d); c.stillToReceiveDeals.add(d); }
    if (d.Stage === "Closed Won") {
      c.wonNotStartedValue += f.value; c.wonNotStartedReceived += f.paid; c.wonNotStartedDeals.push(d);
    } else if (d.Stage === "Scheduled Execution" || d.Stage === "Project Started") {
      c.inExecutionValue += f.value; c.inExecutionReceived += f.paid; c.inExecutionDeals.push(d);
    }
  });
  c.totalOutstanding = c.overdue + c.notDue;
  c.totalOutstandingDocs = c.overdueDocs.concat(c.notDueDocs);
  c.toInvoiceNowDeals = c.toInvoiceFirstDeals.concat(c.toInvoiceFinalDeals);
  c.stillToReceive = c.totalOutstanding + c.toInvoiceNow + c.futureSecond;
  c.stillToReceiveDeals = Array.from(c.stillToReceiveDeals);
  return c;
}

// Drill-down listing invoices instead of deals
window.__invDrill = window.__invDrill || {};
function registerInvoiceDrill(key, title, subtitle, docs) { window.__invDrill[key] = { title, subtitle, docs }; }
window.__showInvoiceDrill = function (key) {
  const item = window.__invDrill[key];
  if (!item) return;
  let container = document.getElementById("drill-modal-container");
  if (!container) { container = document.createElement("div"); container.id = "drill-modal-container"; document.body.appendChild(container); }
  const docs = item.docs.slice().sort((a, b) => num(b.Days_Overdue) - num(a.Days_Overdue));
  const total = docs.reduce((s, f) => s + num(f.Open_excl_VAT), 0);
  const rows = docs.map(f => {
    const d = f.__deal || {};
    const pdf = f.PDF_Link ? `<a href="${escapeHtml(f.PDF_Link)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">PDF</a>` : "-";
    return `<tr class="drill-row" onclick="window.__openDealInCrm('${escapeHtml(d.id || "")}')">
      <td class="drill-ref">${escapeHtml(f.Name || "")}</td>
      <td>${escapeHtml(d.Reference_Number || "-")}</td>
      <td class="drill-name">${escapeHtml(d.Deal_Name || f.Billing_Name || "")}</td>
      <td>${escapeHtml(f.Invoice_Date || "-")}</td>
      <td>${escapeHtml(f.Due_Date || "-")}</td>
      <td class="num">${num(f.Days_Overdue) > 0 ? num(f.Days_Overdue) + "d" : "-"}</td>
      <td class="num">${fmtEur(num(f.Open_excl_VAT))}</td>
      <td>${pdf}</td>
    </tr>`;
  }).join("");
  container.innerHTML = `<div class="modal-overlay" onclick="window.__closeDrill(event)">
    <div class="modal-card" onclick="event.stopPropagation()">
      <div class="modal-header"><div class="modal-titleblock">
        <h3>${escapeHtml(item.title)}</h3>
        <div class="modal-subtitle">${escapeHtml(item.subtitle || "")}</div>
        <div class="modal-stats"><span><strong>${docs.length}</strong> invoice${docs.length === 1 ? "" : "s"}</span><span>Open excl. VAT: <strong>${fmtEur(total)}</strong></span></div>
      </div><button class="modal-close" onclick="window.__closeDrill()" aria-label="Close">×</button></div>
      <div class="modal-controls"><input type="text" class="modal-search" placeholder="🔍 Filter…" oninput="window.__filterDrill(this.value)"></div>
      <div class="modal-body"><table class="modal-table">
        <thead><tr><th>Invoice</th><th>Deal</th><th>Name</th><th>Date</th><th>Due</th><th class="num">Late</th><th class="num">Open</th><th></th></tr></thead>
        <tbody id="modal-tbody">${rows || '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;">No invoices</td></tr>'}</tbody>
      </table></div>
      <div class="modal-footer"><span class="modal-footer-hint">Click a row to open the deal · PDF opens the invoice in InvoiceXpress · ESC or click outside to close</span></div>
    </div></div>`;
  container.style.display = "block";
};

function outstandingHtmlInvoices(c, unlinked, lastSync) {
  registerInvoiceDrill("inv_overdue", "Overdue invoices", "Open and past the due date, per InvoiceXpress", c.overdueDocs);
  registerInvoiceDrill("inv_notdue", "Open invoices, not yet due", "Sent and not paid, due date still ahead", c.notDueDocs);
  registerInvoiceDrill("inv_total", "All open invoices", "Everything still to be paid on invoices already sent", c.totalOutstandingDocs);
  registerInvoiceDrill("inv_unlinked", "Invoices without a deal", "Open, or dated in the last 90 days, and not linked to a deal. Link them in the Faturas module.", unlinked);
  const unlinkedTile = unlinked.length
    ? `<div class="outstanding-note clickable" style="background:#fee2e2;color:#991b1b;" onclick="window.__showInvoiceDrill('inv_unlinked')"><strong>${unlinked.length} invoice${unlinked.length === 1 ? "" : "s"} without a deal</strong> (${fmtEur(unlinked.reduce((s, f) => s + num(f.Amount_excl_VAT), 0))}): add the deal number in InvoiceXpress or link them in Faturas.</div>`
    : "";
  return `<div class="outstanding-box">
    <h2>💸 Cash summary: money outstanding</h2>
    <div class="outstanding-subtitle">From InvoiceXpress invoices (Faturas) &middot; amounts excl. VAT &middot; last sync ${escapeHtml(lastSync || "-")} &middot; click any tile to see the invoices</div>
    <div class="outstanding-grid">
      <div class="outstanding-tile first clickable" onclick="window.__showInvoiceDrill('inv_overdue')">
        <div class="outstanding-label">Overdue</div>
        <div class="outstanding-value">${fmtEur(c.overdue)}</div>
        <div class="outstanding-detail">${c.overdueDocs.length} invoice${c.overdueDocs.length === 1 ? "" : "s"} &middot; ≤30d ${fmtEur(c.aging.a)} &middot; 31-90d ${fmtEur(c.aging.b)} &middot; 90d+ ${fmtEur(c.aging.c)}</div>
      </div>
      <div class="outstanding-tile second clickable" onclick="window.__showInvoiceDrill('inv_notdue')">
        <div class="outstanding-label">Open, not yet due</div>
        <div class="outstanding-value">${fmtEur(c.notDue)}</div>
        <div class="outstanding-detail">${c.notDueDocs.length} invoice${c.notDueDocs.length === 1 ? "" : "s"}</div>
      </div>
      <div class="outstanding-tile total clickable" onclick="window.__showInvoiceDrill('inv_total')">
        <div class="outstanding-label">Total outstanding</div>
        <div class="outstanding-value">${fmtEur(c.totalOutstanding)}</div>
        <div class="outstanding-detail">${c.totalOutstandingDocs.length} open invoice${c.totalOutstandingDocs.length === 1 ? "" : "s"}</div>
      </div>
    </div>
    ${unlinkedTile}
    <div class="outstanding-note">
      <strong>How this is calculated:</strong> open and overdue come straight from InvoiceXpress. "To invoice" uses the deal value (sum of invoiced quotes, else the CRM amount, minus an "x% Discount" tag) minus what has been invoiced net of credit notes; a first invoice that was not sent yet counts as 50%.
      ${c.mismatchDeals.length ? `<br><strong>Check:</strong> ${c.mismatchDeals.length} deal${c.mismatchDeals.length === 1 ? "" : "s"} where the CRM amount differs from the invoiced quotes (${c.mismatchDeals.map(dealRef).join(", ")}).` : ""}
    </div>
  </div>`;
}

function cashSummaryHtmlInvoices(c) {
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  registerDrill("cash_to_invoice", "To invoice NOW", `${c.toInvoiceFirstDeals.length}× 1st invoice not sent + ${c.toInvoiceFinalDeals.length}× final invoice not sent`, c.toInvoiceNowDeals, c.toInvoiceNow);
  registerDrill("cash_wonwait", "Won, not started: value", `${c.wonNotStartedDeals.length} Closed Won deals · ${fmtEur(c.wonNotStartedReceived)} received`, c.wonNotStartedDeals, c.wonNotStartedValue);
  registerDrill("cash_inexec", "In execution: value", `${c.inExecutionDeals.length} projects · ${fmtEur(c.inExecutionReceived)} received`, c.inExecutionDeals, c.inExecutionValue);
  registerDrill("cash_future", "After project completion", `${c.futureSecondDeals.length} deals with an invoice still to come after completion`, c.futureSecondDeals, c.futureSecond);
  registerDrill("cash_total", "Total still to receive", `Outstanding + to invoice now + after completion · ${c.stillToReceiveDeals.length} deals`, c.stillToReceiveDeals, c.stillToReceive);
  const subsidyNote = c.toInvoiceSubsidyValue > 0 ? ` &middot; of which ${fmtEur(c.toInvoiceSubsidyValue)} subsidy-tagged` : "";
  return `<div class="cash-summary">
    <div class="cash-tile action clickable" onclick="window.__showDrill('cash_to_invoice')">
      <div class="cash-label">To invoice NOW</div>
      <div class="cash-value">${fmtEur(c.toInvoiceNow)}</div>
      <div class="cash-detail">${c.toInvoiceFirstDeals.length}&times; 1st + ${c.toInvoiceFinalDeals.length}&times; final invoice${subsidyNote}</div>
    </div>
    <div class="cash-tile outstanding clickable" onclick="window.__showInvoiceDrill('inv_total')">
      <div class="cash-label">Outstanding invoices</div>
      <div class="cash-value">${fmtEur(c.totalOutstanding)}</div>
      <div class="cash-detail">${plural(c.totalOutstandingDocs.length, "invoice")} &middot; ${fmtEur(c.overdue)} overdue</div>
    </div>
    <div class="cash-tile won clickable" onclick="window.__showDrill('cash_wonwait')">
      <div class="cash-label">Won, not started</div>
      <div class="cash-value">${fmtEur(c.wonNotStartedValue)}</div>
      <div class="cash-detail">${plural(c.wonNotStartedDeals.length, "deal")} &middot; ${fmtEur(c.wonNotStartedReceived)} received</div>
    </div>
    <div class="cash-tile in-progress clickable" onclick="window.__showDrill('cash_inexec')">
      <div class="cash-label">In execution</div>
      <div class="cash-value">${fmtEur(c.inExecutionValue)}</div>
      <div class="cash-detail">${plural(c.inExecutionDeals.length, "project")} &middot; ${fmtEur(c.inExecutionReceived)} received</div>
    </div>
    <div class="cash-tile future clickable" onclick="window.__showDrill('cash_future')">
      <div class="cash-label">After project completion</div>
      <div class="cash-value">${fmtEur(c.futureSecond)}</div>
      <div class="cash-detail">final invoices of won deals, not due yet</div>
    </div>
    <div class="cash-tile received clickable" onclick="window.__showDrill('cash_total')">
      <div class="cash-label">Total still to receive</div>
      <div class="cash-value">${fmtEur(c.stillToReceive)}</div>
      <div class="cash-detail">outstanding + to invoice + after completion</div>
    </div>
  </div>`;
}

function render(deals, faturas) {
  TODAY = new Date();
  const filtered = deals.filter(d =>
    (d.Pipeline === PIPELINE_FILTER) && ACTIVE_STAGES.includes(d.Stage)
  );
  const greenFund = deals.filter(d => d.Pipeline === PIPELINE_FILTER && d.Stage === "Green Fund");

  log("Active deals:", filtered.length);

  const dealsByStage = {};
  filtered.forEach(d => {
    if (!dealsByStage[d.Stage]) dealsByStage[d.Stage] = [];
    dealsByStage[d.Stage].push(d);
  });

  INVOICE_MODE = Array.isArray(faturas);
  let inv = null, unlinked = [], lastSync = null, others = [];
  if (INVOICE_MODE) {
    const byDeal = {};
    faturas.forEach(f => {
      const did = f.Deal && f.Deal.id;
      if (did) (byDeal[did] = byDeal[did] || []).push(f);
      if (f.Modified_Time && (!lastSync || f.Modified_Time > lastSync)) lastSync = f.Modified_Time;
    });
    inv = new Map();
    INV_FIG = inv;
    filtered.forEach(d => inv.set(d.id, invoiceFigures(d, byDeal[d.id])));
    // deals in other stages (e.g. Project Finalised) that still have an open invoice
    const activeIds = new Set(filtered.map(d => d.id));
    others = deals.filter(d => !activeIds.has(d.id) && (byDeal[d.id] || []).some(f => f.Payment_Status === "Open"));
    others.forEach(d => inv.set(d.id, invoiceFigures(d, byDeal[d.id])));
    const cutoff = new Date(TODAY.getTime() - 90 * 86400000).toISOString().slice(0, 10);
    unlinked = faturas.filter(f => !(f.Deal && f.Deal.id) && !SKIP_STATUS.has(f.Payment_Status) &&
      (f.Payment_Status === "Open" || (f.Invoice_Date || "") >= cutoff));
    if (lastSync) lastSync = new Date(lastSync).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  }
  const invFn = d => invoiceStatus(d, inv.get(d.id));
  const stagesToShow = INVOICE_MODE ? [
    { name: "Closed Won", fn: invFn, note: "send 1st invoice + collect the 1st payment" },
    { name: "Scheduled Execution", fn: invFn, note: "1st payment should already be in" },
    { name: "Project Started", fn: invFn, note: "1st payment should already be in" },
    { name: "Project Done", fn: invFn, note: "send final invoice + collect the rest" }
  ] : [
    { name: "Closed Won", fn: classifyClosedWon, note: "send 1st invoice + collect the 1st payment" },
    { name: "Scheduled Execution", fn: classifyScheduled, note: "1st payment should already be in" },
    { name: "Project Started", fn: classifyScheduled, note: "1st payment should already be in" },
    { name: "Project Done", fn: classifyProjectDone, note: "send final invoice + collect the rest" }
  ];

  const cash = INVOICE_MODE ? computeCashFromInvoices(filtered.concat(others), inv) : computeCashSummary(filtered);
  const ts = new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

  let html = `
    <div class="header">
      <div>
        <h1>Action Items by Stage</h1>
        <div class="meta">Live from Zoho CRM · ${filtered.length} active deals · refreshed ${ts}</div>
      </div>
      <button class="refresh-btn" onclick="window.__energyease_refresh()">Refresh</button>
    </div>
    <div class="scope-note">
      <strong>Scope:</strong> Pipeline = Regular, stages where action is required (Closed Won → Project Done), plus the Green Fund stage at the bottom. Project Finalised only shows when an invoice is still open. Test deals are filtered out automatically.
    </div>
    ${INVOICE_MODE ? outstandingHtmlInvoices(cash, unlinked, lastSync) : outstandingHtml(cash)}
    ${INVOICE_MODE ? cashSummaryHtmlInvoices(cash) : cashSummaryHtml(cash)}
    ${stagesToShow.map(s => panelHtml(s.name, dealsByStage[s.name] || [], s.fn, s.note)).join("")}
    ${INVOICE_MODE && others.length ? panelHtml("Other stages", others, invFn, "e.g. Project Finalised with an invoice still open") : ""}
    ${greenFundHtml(greenFund)}
  `;

  root.innerHTML = html;

  // Wire row clicks to open the deal in CRM
  document.querySelectorAll(".action-row").forEach(row => {
    row.addEventListener("click", () => {
      const dealId = row.getAttribute("data-deal-id");
      if (dealId && window.ZOHO && ZOHO.CRM && ZOHO.CRM.UI && ZOHO.CRM.UI.Record) {
        ZOHO.CRM.UI.Record.open({ Entity: "Deals", RecordID: dealId }).catch(e => log("open error", e));
      }
    });
  });
}

const TESTDEAL_IDS = new Set(["680374000007820138", "680374000005010079"]);
// Test deals by name: "ZZ ..." or the word "test" (e.g. "Test Deal - Rule 1 Quote Sent")
function isTestDeal(r) {
  const n = r.Deal_Name || "";
  return TESTDEAL_IDS.has(r.id) || /^ZZ\s/i.test(n) || /\btest\b/i.test(n);
}

async function fetchAllDeals() {
  if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.API || !ZOHO.CRM.API.getAllRecords) {
    throw new Error("Zoho SDK not ready. Are you opening this widget inside Zoho CRM?");
  }

  const all = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    log("Fetching page", page);
    const resp = await ZOHO.CRM.API.getAllRecords({
      Entity: "Deals",
      sort_order: "desc",
      sort_by: "Modified_Time",
      page,
      per_page: perPage
    });
    if (!resp || !resp.data) break;
    const rows = resp.data.filter(r => !isTestDeal(r));
    all.push(...rows);
    const more = resp.info && resp.info.more_records;
    if (!more || resp.data.length < perPage) break;
    page++;
    if (page > 10) break; // safety: max 2000 deals
  }
  log("Total fetched:", all.length);
  return all;
}

// Faturas (invoices synced from InvoiceXpress). Returns null when the module is not readable
// for this user, so the widget falls back to the tag-based estimate.
async function fetchFaturas() {
  try {
    const all = [];
    for (let page = 1; page <= 25; page++) {
      const resp = await ZOHO.CRM.API.getAllRecords({ Entity: FATURAS_MODULE, page, per_page: 200 });
      if (!resp || !resp.data) break;
      all.push(...resp.data);
      if (!(resp.info && resp.info.more_records)) break;
    }
    return all.length ? all : null;
  } catch (e) {
    log("Faturas not available, using tags", e);
    return null;
  }
}

async function loadAndRender() {
  try {
    root.innerHTML = `<div class="loading-state"><div class="spinner"></div><div>Fetching deals from Zoho CRM&hellip;</div></div>`;
    const [deals, faturas] = await Promise.all([fetchAllDeals(), fetchFaturas()]);
    render(deals, faturas);
  } catch (e) {
    log("error", e);
    renderError("Unable to load deals.", e && e.message ? e.message : String(e));
  }
}

window.__energyease_refresh = loadAndRender;

// Wait for Zoho SDK init
if (window.ZOHO && ZOHO.embeddedApp) {
  ZOHO.embeddedApp.on("PageLoad", function () {
    log("PageLoad fired");
    loadAndRender();
  });
  ZOHO.embeddedApp.init().catch(e => {
    log("SDK init error", e);
    renderError("Zoho SDK init failed.", String(e));
  });
} else {
  // Fallback if SDK not present (e.g. opening directly outside CRM for dev)
  setTimeout(() => {
    if (window.ZOHO && ZOHO.embeddedApp) {
      ZOHO.embeddedApp.on("PageLoad", loadAndRender);
      ZOHO.embeddedApp.init();
    } else {
      renderError("Zoho Embedded App SDK not loaded.",
        "This widget must be embedded inside Zoho CRM as a registered widget.");
    }
  }, 1000);
}
