/* EnergyEase Action Panels widget — runs inside Zoho CRM, fetches deals via Embedded App SDK */

const ACTIVE_STAGES = ["Closed Won", "Scheduled Execution", "Project Started", "Project Done"];
const PIPELINE_FILTER = "Regular";
const FIELDS = "id,Reference_Number,Deal_Name,Stage,Amount,Owner,Modified_Time,Created_Time,Closing_Date,Tag,Pipeline";

const root = document.getElementById("root");
const TODAY = new Date();

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

function ageStr(d) {
  const days = daysSince(d.Modified_Time);
  return days === null ? "-" : days + "d";
}

function hasTag(deal, name) {
  return (deal.Tag || []).some(t => (t.name || "").toLowerCase() === name.toLowerCase());
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

function classifyClosedWon(d) {
  if (hasTag(d, "Cetelem Paid Upfront") || hasTag(d, "paid 100%")) return "ok";
  if (hasTag(d, "Waiting Cetelem")) return "cetelem-pending";
  if (!hasTag(d, "First 50% sent")) return "invoice-todo";
  if (hasTag(d, "First 50% sent") && !hasTag(d, "Paid 50%")) return "payment-overdue";
  return "ok";
}

function classifyScheduled(d) {
  if (hasTag(d, "Cetelem Paid Upfront") || hasTag(d, "paid 100%")) return "ok";
  if (hasTag(d, "Paid 50%")) return "ok";
  if (!hasTag(d, "First 50% sent")) return "invoice-todo";
  return "payment-overdue";
}

function classifyProjectDone(d) {
  if (hasTag(d, "paid 100%") || hasTag(d, "Cetelem Paid Upfront")) return "ok";
  if (!hasTag(d, "Sent last invoice")) return "invoice-todo";
  return "payment-overdue";
}

function rowHtml(d, cls) {
  const ownerName = (d.Owner && (d.Owner.name || d.Owner.full_name)) || "-";
  const ref = d.Reference_Number || "-";
  return `<div class="action-row ${cls}" data-deal-id="${d.id}">
    <div class="ref">${escapeHtml(ref)}</div>
    <div class="name" title="${escapeHtml(d.Deal_Name)}">${escapeHtml(d.Deal_Name)}</div>
    <div class="owner">${escapeHtml(ownerName)}</div>
    <div class="amount">${fmtEur(d.Amount)}</div>
    <div class="age">${ageStr(d)}</div>
    <div class="tags">${tagPills(d)}</div>
  </div>`;
}

function groupHtml(title, items, cls) {
  if (!items.length) return "";
  return `<div class="action-group ${cls}">
    <div class="action-group-title"><span>${escapeHtml(title)}</span><span class="group-count">${items.length}</span></div>
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
  const buckets = { "invoice-todo": [], "payment-overdue": [], "cetelem-pending": [], "ok": [] };
  dealsInStage.forEach(d => {
    const c = classifyFn(d);
    (buckets[c] || buckets.ok).push(d);
  });
  const todo = buckets["invoice-todo"].length + buckets["payment-overdue"].length + buckets["cetelem-pending"].length;
  let html = `<div class="stage-panel">
    <div class="stage-panel-header">
      <h3>${escapeHtml(stageName)} <span style="font-weight:400; color:#64748b; font-size:11px;">— ${escapeHtml(actionNote)}</span></h3>
      <span class="count">${dealsInStage.length} deals · ${todo} need action</span>
    </div>`;
  html += groupHtml(stageName === "Project Done" ? "Final invoice still to send" : "1st invoice still to send",
                    buckets["invoice-todo"], "invoice-todo");
  html += groupHtml("Payment not received yet", buckets["payment-overdue"], "payment-overdue");
  if (buckets["cetelem-pending"].length) {
    html += `<div class="action-group">
      <div class="action-group-title" style="color:#1e40af;"><span>Awaiting Cetelem approval</span><span class="group-count" style="background:#3b82f6;">${buckets["cetelem-pending"].length}</span></div>
      ${buckets["cetelem-pending"].map(d => rowHtml(d, "warn")).join("")}
    </div>`;
  }
  if (buckets.ok.length) html += groupHtml("On track", buckets.ok, "ok");
  html += "</div>";
  return html;
}

function computeCashSummary(deals) {
  let firstOutstandingValue = 0, firstOutstandingCount = 0;
  let secondOutstandingValue = 0, secondOutstandingCount = 0;
  let toInvoiceFirstValue = 0, toInvoiceFirstCount = 0;
  let toInvoiceSecondValue = 0, toInvoiceSecondCount = 0;
  let inExecutionValue = 0, inExecutionCount = 0;

  deals.forEach(d => {
    const amt = Number(d.Amount) || 0;
    const half = amt / 2;
    const stage = d.Stage;
    const fullPaid = hasTag(d, "paid 100%") || hasTag(d, "Cetelem Paid Upfront");
    const firstSent = hasTag(d, "First 50% sent");
    const firstPaid = hasTag(d, "Paid 50%") || fullPaid;
    const lastSent = hasTag(d, "Sent last invoice");

    if (stage === "Closed Won") {
      if (!firstSent && !firstPaid) { toInvoiceFirstCount++; toInvoiceFirstValue += half; }
      else if (firstSent && !firstPaid) { firstOutstandingCount++; firstOutstandingValue += half; }
    }
    if (stage === "Scheduled Execution" || stage === "Project Started") {
      if (firstPaid) { inExecutionCount++; inExecutionValue += amt; }
      else if (firstSent) { firstOutstandingCount++; firstOutstandingValue += half; }
      else { toInvoiceFirstCount++; toInvoiceFirstValue += half; }
    }
    if (stage === "Project Done") {
      if (!lastSent && !fullPaid) { toInvoiceSecondCount++; toInvoiceSecondValue += half; }
      else if (lastSent && !fullPaid) { secondOutstandingCount++; secondOutstandingValue += half; }
    }
  });

  const totalOutstanding = firstOutstandingValue + secondOutstandingValue;
  const totalOutstandingCount = firstOutstandingCount + secondOutstandingCount;
  const toInvoiceNow = toInvoiceFirstValue + toInvoiceSecondValue;
  const futureSecond = inExecutionValue / 2;
  const stillToReceive = totalOutstanding + toInvoiceNow + futureSecond;

  return {
    toInvoiceNow, toInvoiceNowCount: toInvoiceFirstCount + toInvoiceSecondCount,
    toInvoiceFirstCount, toInvoiceSecondCount,
    firstOutstandingValue, firstOutstandingCount,
    secondOutstandingValue, secondOutstandingCount,
    totalOutstanding, totalOutstandingCount,
    inExecutionValue, inExecutionCount,
    futureSecond, stillToReceive
  };
}

function outstandingHtml(c) {
  return `<div class="outstanding-box">
    <h2>💸 Cash summary &mdash; money outstanding</h2>
    <div class="outstanding-subtitle">Live calculation from Zoho tag data &middot; 50/50 invoicing model</div>
    <div class="outstanding-grid">
      <div class="outstanding-tile first">
        <div class="outstanding-label">1st invoice outstanding</div>
        <div class="outstanding-value">${fmtEur(c.firstOutstandingValue)}</div>
        <div class="outstanding-detail">${c.firstOutstandingCount} deal${c.firstOutstandingCount === 1 ? "" : "s"} &middot; half of total</div>
      </div>
      <div class="outstanding-tile second">
        <div class="outstanding-label">2nd invoice outstanding</div>
        <div class="outstanding-value">${fmtEur(c.secondOutstandingValue)}</div>
        <div class="outstanding-detail">${c.secondOutstandingCount} deal${c.secondOutstandingCount === 1 ? "" : "s"} &middot; half of total</div>
      </div>
      <div class="outstanding-tile total">
        <div class="outstanding-label">Total outstanding</div>
        <div class="outstanding-value">${fmtEur(c.totalOutstanding)}</div>
        <div class="outstanding-detail">${c.totalOutstandingCount} invoice${c.totalOutstandingCount === 1 ? "" : "s"} awaiting payment</div>
      </div>
    </div>
    <div class="outstanding-note">
      <strong>Assumption:</strong> 50/50 model. Deals with "Cetelem Paid Upfront" or "paid 100%" tags are treated as fully paid. Deviating splits (such as 25/75) are not separately handled.
    </div>
  </div>`;
}

function cashSummaryHtml(c) {
  return `<div class="cash-summary">
    <div class="cash-tile action">
      <div class="cash-label">To invoice NOW</div>
      <div class="cash-value">${fmtEur(c.toInvoiceNow)}</div>
      <div class="cash-detail">${c.toInvoiceFirstCount}× 1st (Closed Won) + ${c.toInvoiceSecondCount}× final (Project Done)</div>
    </div>
    <div class="cash-tile outstanding">
      <div class="cash-label">Outstanding invoices</div>
      <div class="cash-value">${fmtEur(c.totalOutstanding)}</div>
      <div class="cash-detail">${c.totalOutstandingCount} sent, not paid</div>
    </div>
    <div class="cash-tile in-progress">
      <div class="cash-label">In execution (50% received)</div>
      <div class="cash-value">${fmtEur(c.inExecutionValue)}</div>
      <div class="cash-detail">${c.inExecutionCount} ongoing project${c.inExecutionCount === 1 ? "" : "s"}</div>
    </div>
    <div class="cash-tile future">
      <div class="cash-label">After project completion</div>
      <div class="cash-value">${fmtEur(c.futureSecond)}</div>
      <div class="cash-detail">2nd invoice potential</div>
    </div>
    <div class="cash-tile received">
      <div class="cash-label">Total still to receive</div>
      <div class="cash-value">${fmtEur(c.stillToReceive)}</div>
      <div class="cash-detail">Outstanding + to-invoice + future 2nd</div>
    </div>
  </div>`;
}

function render(deals) {
  const filtered = deals.filter(d =>
    (d.Pipeline === PIPELINE_FILTER) && ACTIVE_STAGES.includes(d.Stage)
  );

  log("Active deals:", filtered.length);

  const dealsByStage = {};
  filtered.forEach(d => {
    if (!dealsByStage[d.Stage]) dealsByStage[d.Stage] = [];
    dealsByStage[d.Stage].push(d);
  });

  const stagesToShow = [
    { name: "Closed Won", fn: classifyClosedWon, note: "send 1st invoice + collect 50%" },
    { name: "Scheduled Execution", fn: classifyScheduled, note: "50% should already be paid" },
    { name: "Project Started", fn: () => "ok", note: "mid-execution, no invoice action expected" },
    { name: "Project Done", fn: classifyProjectDone, note: "send final invoice + collect last 50%" }
  ];

  const cash = computeCashSummary(filtered);
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
      <strong>Scope:</strong> Pipeline = Regular, stages where action is required (Closed Won → Project Done). Project Finalised is excluded. Florian Apartment test deal is filtered out automatically.
    </div>
    ${outstandingHtml(cash)}
    ${cashSummaryHtml(cash)}
    ${stagesToShow.map(s => panelHtml(s.name, dealsByStage[s.name] || [], s.fn, s.note)).join("")}
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
    const rows = resp.data.filter(r => !TESTDEAL_IDS.has(r.id));
    all.push(...rows);
    const more = resp.info && resp.info.more_records;
    if (!more || resp.data.length < perPage) break;
    page++;
    if (page > 10) break; // safety: max 2000 deals
  }
  log("Total fetched:", all.length);
  return all;
}

async function loadAndRender() {
  try {
    root.innerHTML = `<div class="loading-state"><div class="spinner"></div><div>Fetching deals from Zoho CRM&hellip;</div></div>`;
    const deals = await fetchAllDeals();
    render(deals);
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
