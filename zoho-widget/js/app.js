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

// ============== DRILL-DOWN MODAL ==============
window.__drillData = window.__drillData || {};
function registerDrill(key, title, subtitle, deals) {
  window.__drillData[key] = { title, subtitle, deals };
}

function renderDrillRow(d) {
  const owner = (d.Owner && (d.Owner.name || d.Owner.full_name)) || "—";
  const ref = d.Reference_Number || ("#" + (d.id || "").slice(-4));
  const name = d.Deal_Name || "(no name)";
  const stage = d.Stage || "—";
  const amount = d.Amount ? fmtEur(d.Amount) : "—";
  const age = ageStr(d);
  const tagsList = (d.Tag || []).map(t => escapeHtml(t.name)).join(", ") || "—";
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
  openDrillModal(item.title, item.subtitle, item.deals);
};

function openDrillModal(title, subtitle, deals) {
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
            <span>Total amount: <strong>${fmtEur(totalAmount)}</strong></span>
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
              <th>Age</th>
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
  if (hasTag(d, "Cetelem Paid Upfront") || hasTag(d, "paid 100%")) return "ok";
  // If first invoice has been paid, treat as ok regardless of whether "First 50% sent" tag was set
  // (you can't pay an invoice that wasn't sent — handles tag-hygiene inconsistencies)
  if (hasTag(d, "Paid 50%") || hasTag(d, "Paid 25%")) return "ok";
  if (hasTag(d, "Waiting Cetelem")) return "cetelem-pending";
  if (!hasTag(d, "First 50% sent") && !hasTag(d, "First 25%")) return "invoice-todo";
  return "payment-overdue";
}

function classifyScheduled(d) {
  if (hasTag(d, "Cetelem Paid Upfront") || hasTag(d, "paid 100%")) return "ok";
  if (hasTag(d, "Paid 50%") || hasTag(d, "Paid 25%")) return "ok";
  if (!hasTag(d, "First 50% sent") && !hasTag(d, "First 25%")) return "invoice-todo";
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
  const buckets = { "invoice-todo": [], "payment-overdue": [], "cetelem-pending": [], "ok": [] };
  dealsInStage.forEach(d => {
    const c = classifyFn(d);
    (buckets[c] || buckets.ok).push(d);
  });
  const todo = buckets["invoice-todo"].length + buckets["payment-overdue"].length + buckets["cetelem-pending"].length;
  const stageKeyName = stageName.replace(/[^a-z0-9]/gi, "_");
  registerDrill(`stage_${stageKeyName}_all`, `${stageName} — all deals`, `${dealsInStage.length} deals in stage · ${todo} need action`, dealsInStage);
  let html = `<div class="stage-panel">
    <div class="stage-panel-header clickable" onclick="window.__showDrill('stage_${stageKeyName}_all')">
      <h3>${escapeHtml(stageName)} <span style="font-weight:400; color:#64748b; font-size:11px;">— ${escapeHtml(actionNote)}</span></h3>
      <span class="count">${dealsInStage.length} deals · ${todo} need action</span>
    </div>`;
  const stageKey = stageName.replace(/[^a-z0-9]/gi, "_");
  html += groupHtml(stageName === "Project Done" ? "Final invoice still to send" : "1st invoice still to send",
                    buckets["invoice-todo"], "invoice-todo", `stage_${stageKey}_todo`);
  html += groupHtml("Payment not received yet", buckets["payment-overdue"], "payment-overdue", `stage_${stageKey}_overdue`);
  if (buckets["cetelem-pending"].length) {
    registerDrill(`stage_${stageKey}_cetelem`, `${stageName} — Awaiting Cetelem approval`, `${buckets["cetelem-pending"].length} deals awaiting Cetelem decision`, buckets["cetelem-pending"]);
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
  // Per-deal payment-split detection:
  //   - 100% upfront ("Cetelem Paid Upfront" or "paid 100%") → no outstanding, no future invoice
  //   - 25/75 ("Paid 25%" or "First 25%" tag) → first invoice = 25%, second = 75%
  //   - default 50/50
  // futureSecond is tracked explicitly per deal (NOT inExecutionValue / 2) so Cetelem deals don't inflate it.
  let firstOutstandingValue = 0, firstOutstandingDeals = [];
  let secondOutstandingValue = 0, secondOutstandingDeals = [];
  let toInvoiceFirstValue = 0, toInvoiceFirstDeals = [];
  let toInvoiceSecondValue = 0, toInvoiceSecondDeals = [];
  let inExecutionValue = 0, inExecutionDeals = [];
  let inExecutionReceived = 0;
  let futureSecond = 0, futureSecondDeals = [];

  deals.forEach(d => {
    const amt = Number(d.Amount) || 0;
    const stage = d.Stage;

    const fullPaid = hasTag(d, "paid 100%") || hasTag(d, "Cetelem Paid Upfront");
    const is25Split = hasTag(d, "Paid 25%") || hasTag(d, "First 25%");
    const firstPct = is25Split ? 0.25 : 0.50;
    const secondPct = 1 - firstPct;
    const firstInvoiceAmt = amt * firstPct;
    const secondInvoiceAmt = amt * secondPct;

    const firstSent = hasTag(d, "First 50% sent") || hasTag(d, "First 25%");
    const firstPaid = hasTag(d, "Paid 50%") || hasTag(d, "Paid 25%") || fullPaid;
    const lastSent = hasTag(d, "Sent last invoice");

    if (stage === "Closed Won") {
      if (fullPaid) {
        // 100% paid (e.g. Cetelem). Nothing outstanding.
      } else if (!firstSent && !firstPaid) {
        toInvoiceFirstValue += firstInvoiceAmt;
        toInvoiceFirstDeals.push(d);
      } else if (firstSent && !firstPaid) {
        firstOutstandingValue += firstInvoiceAmt;
        firstOutstandingDeals.push(d);
      }
    }
    if (stage === "Scheduled Execution" || stage === "Project Started") {
      if (fullPaid) {
        inExecutionValue += amt;
        inExecutionDeals.push(d);
        inExecutionReceived += amt;
      } else if (firstPaid) {
        inExecutionValue += amt;
        inExecutionDeals.push(d);
        inExecutionReceived += firstInvoiceAmt;
        futureSecond += secondInvoiceAmt;
        futureSecondDeals.push(d);
      } else if (firstSent) {
        firstOutstandingValue += firstInvoiceAmt;
        firstOutstandingDeals.push(d);
      } else {
        toInvoiceFirstValue += firstInvoiceAmt;
        toInvoiceFirstDeals.push(d);
      }
    }
    if (stage === "Project Done") {
      if (fullPaid) {
        // 100% paid, project done. Nothing outstanding.
      } else if (!lastSent) {
        toInvoiceSecondValue += secondInvoiceAmt;
        toInvoiceSecondDeals.push(d);
      } else if (lastSent) {
        secondOutstandingValue += secondInvoiceAmt;
        secondOutstandingDeals.push(d);
      }
    }
  });

  const totalOutstanding = firstOutstandingValue + secondOutstandingValue;
  const totalOutstandingDeals = [...firstOutstandingDeals, ...secondOutstandingDeals];
  const toInvoiceNow = toInvoiceFirstValue + toInvoiceSecondValue;
  const toInvoiceNowDeals = [...toInvoiceFirstDeals, ...toInvoiceSecondDeals];
  const stillToReceive = totalOutstanding + toInvoiceNow + futureSecond;
  const stillToReceiveDeals = Array.from(new Set([
    ...totalOutstandingDeals, ...toInvoiceNowDeals, ...futureSecondDeals
  ]));

  return {
    toInvoiceNow, toInvoiceNowCount: toInvoiceFirstDeals.length + toInvoiceSecondDeals.length,
    toInvoiceFirstCount: toInvoiceFirstDeals.length, toInvoiceSecondCount: toInvoiceSecondDeals.length,
    toInvoiceNowDeals, toInvoiceFirstDeals, toInvoiceSecondDeals,
    firstOutstandingValue, firstOutstandingCount: firstOutstandingDeals.length, firstOutstandingDeals,
    secondOutstandingValue, secondOutstandingCount: secondOutstandingDeals.length, secondOutstandingDeals,
    totalOutstanding, totalOutstandingCount: totalOutstandingDeals.length, totalOutstandingDeals,
    inExecutionValue, inExecutionCount: inExecutionDeals.length, inExecutionReceived, inExecutionDeals,
    futureSecond, futureSecondDeals, stillToReceive, stillToReceiveDeals
  };
}

function outstandingHtml(c) {
  registerDrill("out_first", "1st invoice outstanding", `${c.firstOutstandingCount} deals · 1st-invoice portion (50% or 25%) sent but not yet paid`, c.firstOutstandingDeals);
  registerDrill("out_second", "2nd invoice outstanding", `${c.secondOutstandingCount} deals · final-invoice portion sent but not yet paid`, c.secondOutstandingDeals);
  registerDrill("out_total", "Total outstanding invoices", `${c.totalOutstandingCount} invoices awaiting payment (1st + 2nd combined)`, c.totalOutstandingDeals);
  return `<div class="outstanding-box">
    <h2>💸 Cash summary &mdash; money outstanding</h2>
    <div class="outstanding-subtitle">Live calculation from Zoho tag data &middot; per-deal split detection (50/50, 25/75, or 100% upfront) &middot; click any tile to see underlying deals</div>
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
        <div class="outstanding-detail">${c.totalOutstandingCount} invoice${c.totalOutstandingCount === 1 ? "" : "s"} awaiting payment</div>
      </div>
    </div>
    <div class="outstanding-note">
      <strong>Invoice splits:</strong> 50/50 default. "Paid 25%" / "First 25%" tags trigger 25/75 split. "Cetelem Paid Upfront" / "paid 100%" tags mark deals as fully paid — they don't contribute to outstanding or future invoices.
    </div>
  </div>`;
}

function cashSummaryHtml(c) {
  registerDrill("cash_to_invoice", "To invoice NOW", `${c.toInvoiceFirstCount}× 1st (Closed Won) + ${c.toInvoiceSecondCount}× final (Project Done) need invoicing`, c.toInvoiceNowDeals);
  registerDrill("cash_outstanding", "Outstanding invoices", `${c.totalOutstandingCount} invoices sent but not paid`, c.totalOutstandingDeals);
  registerDrill("cash_inexec", "In execution — contract value", `${c.inExecutionCount} ongoing projects · ${fmtEur(c.inExecutionReceived)} already received of ${fmtEur(c.inExecutionValue)} contract value`, c.inExecutionDeals);
  registerDrill("cash_future", "After project completion", `${c.futureSecondDeals.length} deals with future 2nd invoice expected (Cetelem-paid deals excluded)`, c.futureSecondDeals);
  registerDrill("cash_total", "Total still to receive", `Outstanding + to-invoice + future 2nd combined · ${c.stillToReceiveDeals.length} deals total`, c.stillToReceiveDeals);
  return `<div class="cash-summary">
    <div class="cash-tile action clickable" onclick="window.__showDrill('cash_to_invoice')">
      <div class="cash-label">To invoice NOW</div>
      <div class="cash-value">${fmtEur(c.toInvoiceNow)}</div>
      <div class="cash-detail">${c.toInvoiceFirstCount}&times; 1st (Closed Won) + ${c.toInvoiceSecondCount}&times; final (Project Done)</div>
    </div>
    <div class="cash-tile outstanding clickable" onclick="window.__showDrill('cash_outstanding')">
      <div class="cash-label">Outstanding invoices</div>
      <div class="cash-value">${fmtEur(c.totalOutstanding)}</div>
      <div class="cash-detail">${c.totalOutstandingCount} sent, not paid</div>
    </div>
    <div class="cash-tile in-progress clickable" onclick="window.__showDrill('cash_inexec')">
      <div class="cash-label">In execution &mdash; contract value</div>
      <div class="cash-value">${fmtEur(c.inExecutionValue)}</div>
      <div class="cash-detail">${c.inExecutionCount} ongoing project${c.inExecutionCount === 1 ? "" : "s"} &middot; ${fmtEur(c.inExecutionReceived)} already received</div>
    </div>
    <div class="cash-tile future clickable" onclick="window.__showDrill('cash_future')">
      <div class="cash-label">After project completion</div>
      <div class="cash-value">${fmtEur(c.futureSecond)}</div>
      <div class="cash-detail">future invoices (Cetelem-paid deals excluded)</div>
    </div>
    <div class="cash-tile received clickable" onclick="window.__showDrill('cash_total')">
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
