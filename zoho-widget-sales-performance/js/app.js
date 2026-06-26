/* EnergyEase Sales Performance widget — runs inside Zoho CRM, fetches deals via Embedded App SDK */

const PIPELINE_FILTER = "Regular";
const TESTDEAL_IDS = new Set(["680374000007820138", "680374000005010079"]);
const STALE_QUOTE_DAYS = 21; // Pipeline Rules: ghosted Quote Sent → Closed Lost after 21 days

// Blown-in product IDs — if the most recent quote of a deal contains any of these as a line item,
// the deal is classified as a blown-in project. List confirmed by Florian (service items + old inactive).
const BLOWN_IN_PRODUCT_IDS = [
  "680374000001323055", // Execução Insuflação (Blown-In) — inactive
  "680374000003136002", // Blown in — inactive
  "680374000003994071", // Material (Blown-In) - Lã Mineral SUPAFIL LOFT 45
  "680374000016614001", // Execução Insuflação — Caixa de Ar
  "680374000016614002", // Execução Insuflação — Teto Falso
  "680374000016614003", // Execução Insuflação — Pavimento do Sótão
];

// Stages that count as "won" for conversion (they ALL passed through Closed Won)
const WON_STAGES = new Set([
  "Closed Won", "Scheduled Execution", "Project Started", "Project Done", "Project Finalised"
]);
const LOST_STAGES_RAW = new Set(["Closed Lost"]);
// Customer service intake stages — owners on these are intake operators, not advisors
const CUSTOMER_SERVICE_STAGES = new Set(["Inspection Scheduled"]);
const CUSTOMER_SERVICE_OWNERS = new Set(["Tomas Rodrigues"]);

// Stages by sequence (for funnel)
const STAGE_ORDER = [
  "Inspection Scheduled", "Inspection Qualified", "Remote  Quotes", "Inspection Performed",
  "Quote Ready for Review", "Quote Sent", "Green Fund", "Negotiation/Review",
  "Closed Won", "Scheduled Execution", "Project Started", "Project Done", "Project Finalised",
  "Closed Lost", "Closed Not Qualified"
];

// Loss reason buckets
const LOSS_REASON_BUCKET = {
  "Lack of response": "recoverable",
  "Future Interest": "recoverable",
  "Missed Follow Ups": "recoverable",
  "Price": "qualification",
  "Competition": "qualification",
  "Unqualified Customer": "qualification",
  "Expectation Mismatch": "qualification",
  "Wrong Target": "qualification",
  "Blown-In Actually Impossible": "hard",
  "We Missed Appointments": "internal",
  "Other": "other",
  "Unknown": "other"
};

const root = document.getElementById("root");
const TODAY = new Date();

// Filter state
let cachedDeals = null;
let currentFilter = "all";
let customFrom = null; // ISO date string YYYY-MM-DD
let customTo = null;

// Blown-in detection state: null = not yet loaded, Set = loaded set of dealIds
let blownInDealIds = null;
let blownInLoadError = null;

// Lead Intake state (independent of period filter)
let leadIntakeGranularity = "weekly";
let leadIntakeCustomFrom = null;
let leadIntakeCustomTo = null;

// Filter periods (apply to Created_Time)
const FILTERS = [
  { id: "all", label: "All time" },
  { id: "ytd", label: "YTD" },
  { id: "q", label: "This Quarter" },
  { id: "90d", label: "Last 90d" },
  { id: "30d", label: "Last 30d" },
  { id: "custom", label: "Custom" }
];

// Lead Intake granularities. monthly/quarterly use year grouping with YoY.
const GRANULARITIES = [
  { id: "weekly", label: "Weekly", buckets: 12, grouping: "flat" },
  { id: "monthly", label: "Monthly", buckets: 24, grouping: "year" },
  { id: "quarterly", label: "Quarterly", buckets: 8, grouping: "year" },
  { id: "custom", label: "Custom" }
];

function applyPeriodFilter(deals, filterId) {
  if (filterId === "all") return deals;
  const now = TODAY;
  let cutoffFrom, cutoffTo;
  if (filterId === "ytd") {
    cutoffFrom = new Date(now.getFullYear(), 0, 1);
  } else if (filterId === "q") {
    const q = Math.floor(now.getMonth() / 3);
    cutoffFrom = new Date(now.getFullYear(), q * 3, 1);
  } else if (filterId === "90d") {
    cutoffFrom = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  } else if (filterId === "30d") {
    cutoffFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  } else if (filterId === "custom") {
    if (customFrom) cutoffFrom = new Date(customFrom + "T00:00:00");
    if (customTo) cutoffTo = new Date(customTo + "T23:59:59");
  } else {
    return deals;
  }
  return deals.filter(d => {
    if (!d.Created_Time) return false;
    const t = new Date(d.Created_Time);
    if (cutoffFrom && t < cutoffFrom) return false;
    if (cutoffTo && t > cutoffTo) return false;
    return true;
  });
}

// Default custom range when first opening Custom: last 30 days
function ensureCustomDefaults() {
  if (!customFrom) {
    const d = new Date(TODAY.getTime() - 30 * 24 * 60 * 60 * 1000);
    customFrom = d.toISOString().slice(0, 10);
  }
  if (!customTo) {
    customTo = TODAY.toISOString().slice(0, 10);
  }
}

function log(...args) { if (window.console) console.log("[Sales Performance]", ...args); }

function fmtEur(n) {
  if (n === null || n === undefined || isNaN(n)) return "€0";
  if (n >= 10000) return "€" + (n / 1000).toFixed(0) + "k";
  return "€" + Math.round(n).toLocaleString("en-US");
}
function fmtNum(n) { return (n || 0).toLocaleString("en-US"); }
function fmtPct(n) { return (n || 0).toFixed(0) + "%"; }
function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return Math.floor((TODAY - d) / (1000 * 60 * 60 * 24));
}
function escapeHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderError(msg, detail) {
  root.innerHTML = `<div class="error-state">
    <strong>Couldn't load sales performance.</strong><br>
    ${escapeHtml(msg)}<br>
    ${detail ? `<small style="opacity:0.7;">${escapeHtml(detail)}</small>` : ""}
  </div>`;
}

// Apply Pipeline Rules: Quote Sent + Modified > 21 days ago = effectively Closed Lost / No Response
function isEffectivelyLost(d) {
  if (LOST_STAGES_RAW.has(d.Stage)) return true;
  if (d.Stage === "Quote Sent") {
    const days = daysSince(d.Modified_Time);
    if (days !== null && days >= STALE_QUOTE_DAYS) return true;
  }
  return false;
}

function isAdvisorAttributable(d) {
  return !CUSTOMER_SERVICE_STAGES.has(d.Stage);
}

function getOwnerName(d) {
  return (d.Owner && (d.Owner.name || d.Owner.full_name)) || null;
}

function ownerLastName(name) {
  if (!name) return name;
  const parts = name.trim().split(" ");
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

// ============== DRILL-DOWN MODAL ==============
// Storage for drill-down data, keyed by string ID. We store the deal list at render-time
// and look it up by key from the inline onclick, to avoid embedding huge arrays in HTML.
window.__drillData = window.__drillData || {};

function registerDrill(key, title, subtitle, deals) {
  window.__drillData[key] = { title, subtitle, deals };
}

function drillBtn(key, value, ariaLabel) {
  // Wraps a value in a clickable element that opens the drill-down with the given key.
  return `<span class="drill-trigger" role="button" tabindex="0" title="Click to see underlying deals" onclick="window.__showDrill('${key}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.__showDrill('${key}')}" aria-label="${escapeHtml(ariaLabel || 'Open drill-down')}">${value}</span>`;
}

function dealOutcomeLabel(d) {
  if (WON_STAGES.has(d.Stage)) return "Won";
  if (d.Stage === "Closed Lost") return "Lost (final)";
  if (d.Stage === "Closed Not Qualified") return "Not qualified";
  if (d.Stage === "Quote Sent" && daysSince(d.Modified_Time) >= STALE_QUOTE_DAYS) return "Lost (ghosted 21d+)";
  return "Open";
}

function outcomeClass(d) {
  if (WON_STAGES.has(d.Stage)) return "outcome-won";
  if (LOST_STAGES_RAW.has(d.Stage) || isEffectivelyLost(d)) return "outcome-lost";
  return "outcome-open";
}

function renderDrillRow(d) {
  const owner = (d.Owner && (d.Owner.name || d.Owner.full_name)) || "—";
  const ref = d.Reference_Number || ("#" + (d.id || "").slice(-4));
  const name = d.Deal_Name || "(no name)";
  const source = d.Lead_Source || "—";
  const stage = d.Stage || "—";
  const amount = d.Amount ? fmtEur(d.Amount) : "—";
  const created = d.Created_Time ? new Date(d.Created_Time).toLocaleDateString("en-GB") : "—";
  return `<tr class="drill-row" data-deal-id="${escapeHtml(d.id)}" onclick="window.__openDealInCrm('${escapeHtml(d.id)}')">
    <td class="drill-ref">${escapeHtml(ref)}</td>
    <td class="drill-name">${escapeHtml(name)}</td>
    <td>${escapeHtml(ownerLastName(owner))}</td>
    <td>${escapeHtml(source)}</td>
    <td>${escapeHtml(stage)}</td>
    <td class="drill-outcome ${outcomeClass(d)}">${escapeHtml(dealOutcomeLabel(d))}</td>
    <td class="num">${amount}</td>
    <td>${created}</td>
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
  // Sort by Created_Time desc by default
  const sortedDeals = (deals || []).slice().sort((a, b) =>
    new Date(b.Created_Time || 0) - new Date(a.Created_Time || 0)
  );
  // Aggregate stats
  const totalAmount = sortedDeals.reduce((s, d) => s + (Number(d.Amount) || 0), 0);
  const wonCount = sortedDeals.filter(d => WON_STAGES.has(d.Stage)).length;
  const lostCount = sortedDeals.filter(d => isEffectivelyLost(d)).length;
  const openCount = sortedDeals.length - wonCount - lostCount;
  container.innerHTML = `<div class="modal-overlay" onclick="window.__closeDrill(event)">
    <div class="modal-card" onclick="event.stopPropagation()">
      <div class="modal-header">
        <div class="modal-titleblock">
          <h3>${escapeHtml(title)}</h3>
          <div class="modal-subtitle">${escapeHtml(subtitle || '')}</div>
          <div class="modal-stats">
            <span><strong>${sortedDeals.length}</strong> deal${sortedDeals.length === 1 ? '' : 's'}</span>
            <span class="modal-stat-won">${wonCount} won</span>
            <span class="modal-stat-lost">${lostCount} lost</span>
            <span class="modal-stat-open">${openCount} open</span>
            <span>Total amount: <strong>${fmtEur(totalAmount)}</strong></span>
          </div>
        </div>
        <button class="modal-close" onclick="window.__closeDrill()" aria-label="Close">×</button>
      </div>
      <div class="modal-controls">
        <input type="text" class="modal-search" placeholder="🔍 Filter by name, owner, source, stage…" oninput="window.__filterDrill(this.value)" autofocus>
      </div>
      <div class="modal-body">
        <table class="modal-table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Deal Name</th>
              <th>Owner</th>
              <th>Source</th>
              <th>Stage</th>
              <th>Outcome</th>
              <th class="num">Amount</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody id="modal-tbody">
            ${sortedDeals.length ? sortedDeals.map(d => renderDrillRow(d)).join('') : '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;">No deals match</td></tr>'}
          </tbody>
        </table>
      </div>
      <div class="modal-footer">
        <span class="modal-footer-hint">Click any row to open the deal in Zoho CRM · ESC or click outside to close</span>
      </div>
    </div>
  </div>`;
  container.style.display = "block";
  // ESC key handler
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

// ============== KPIs ==============
function computeKPIs(deals) {
  const total = deals.length;
  const advisorDeals = deals.filter(isAdvisorAttributable);
  const wonDeals = advisorDeals.filter(d => WON_STAGES.has(d.Stage));
  const lostDeals = advisorDeals.filter(isEffectivelyLost);
  const decided = wonDeals.length + lostDeals.length;

  const realisedRevenue = wonDeals.reduce((s, d) => s + (Number(d.Amount) || 0), 0);

  // Method 1: Quote Sent → Won (decided ratio, with Pipeline Rules 21d ghost)
  const quoteToClose = decided > 0 ? (wonDeals.length / decided) * 100 : 0;

  // Method 2: Inspection Qualified → Won (broader — includes still-in-flight deals)
  const inspQualIdx = STAGE_ORDER.indexOf("Inspection Qualified");
  const reachedInspQual = advisorDeals.filter(d => STAGE_ORDER.indexOf(d.Stage) >= inspQualIdx).length;
  const inspectionToWon = reachedInspQual > 0 ? (wonDeals.length / reachedInspQual) * 100 : 0;

  // Lead → Quote: deals that reached Quote Sent (or beyond) / total advisor deals
  const reachedQuote = advisorDeals.filter(d => {
    const seqIdx = STAGE_ORDER.indexOf(d.Stage);
    const quoteSentIdx = STAGE_ORDER.indexOf("Quote Sent");
    return seqIdx >= quoteSentIdx;
  }).length;
  const leadToQuote = advisorDeals.length > 0 ? (reachedQuote / advisorDeals.length) * 100 : 0;

  // Avg sales cycle (won deals only, where Sales_Cycle_Duration is present)
  const cyclesAll = wonDeals.map(d => d.Sales_Cycle_Duration).filter(c => c && c > 0);
  const avgCycle = cyclesAll.length > 0 ? cyclesAll.reduce((a, b) => a + b, 0) / cyclesAll.length : null;

  const inQuoteSent = advisorDeals.filter(d => d.Stage === "Quote Sent").length;

  return { total, advisorTotal: advisorDeals.length, wonCount: wonDeals.length, lostCount: lostDeals.length,
    reachedInspQual, realisedRevenue, quoteToClose, inspectionToWon, leadToQuote, avgCycle, inQuoteSent };
}

// Compute conversion rates over a specific date range (Created_Time based)
// Returns { m1, m2, wonCount, decidedCount, reachedInspQual }
function computeConversionForRange(allDeals, from, to) {
  const inRange = allDeals.filter(d => {
    if (!d.Created_Time) return false;
    const t = new Date(d.Created_Time);
    return t >= from && t <= to;
  });
  const advisorDeals = inRange.filter(isAdvisorAttributable);
  const wonDeals = advisorDeals.filter(d => WON_STAGES.has(d.Stage));
  const lostDeals = advisorDeals.filter(isEffectivelyLost);
  const decided = wonDeals.length + lostDeals.length;
  const m1 = decided > 0 ? (wonDeals.length / decided) * 100 : null;

  const inspQualIdx = STAGE_ORDER.indexOf("Inspection Qualified");
  const reachedInspQual = advisorDeals.filter(d => STAGE_ORDER.indexOf(d.Stage) >= inspQualIdx).length;
  const m2 = reachedInspQual > 0 ? (wonDeals.length / reachedInspQual) * 100 : null;

  return { m1, m2, wonCount: wonDeals.length, decidedCount: decided, reachedInspQual };
}

function computeConversionTrend(allDeals) {
  // This month: 1st of current month → today
  // Last month: 1st of last month → end of last month
  // Last quarter: 1st of last quarter → end of last quarter
  const now = TODAY;
  const thisMonthFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const thisMonthTo = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const lastMonthFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthTo = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const currentQ = Math.floor(now.getMonth() / 3);
  const lastQOffset = 1;
  const totalQuartersAgo = now.getFullYear() * 4 + currentQ - lastQOffset;
  const lastQYear = Math.floor(totalQuartersAgo / 4);
  const lastQIdx = ((totalQuartersAgo % 4) + 4) % 4;
  const lastQFrom = new Date(lastQYear, lastQIdx * 3, 1);
  const lastQTo = new Date(lastQYear, lastQIdx * 3 + 3, 0, 23, 59, 59);

  return [
    { label: "This month", sub: monthLabel(thisMonthFrom), from: thisMonthFrom, to: thisMonthTo, ...computeConversionForRange(allDeals, thisMonthFrom, thisMonthTo) },
    { label: "Last month", sub: monthLabel(lastMonthFrom), from: lastMonthFrom, to: lastMonthTo, ...computeConversionForRange(allDeals, lastMonthFrom, lastMonthTo) },
    { label: "Last quarter", sub: `Q${lastQIdx + 1} ${lastQYear}`, from: lastQFrom, to: lastQTo, ...computeConversionForRange(allDeals, lastQFrom, lastQTo) }
  ];
}

function monthLabel(d) {
  return d.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function kpiHtml(k, filtered) {
  const avgDeal = k.wonCount > 0 ? k.realisedRevenue / k.wonCount : 0;
  const advisorDeals = filtered.filter(isAdvisorAttributable);
  const wonDeals = advisorDeals.filter(d => WON_STAGES.has(d.Stage));
  const lostDeals = advisorDeals.filter(isEffectivelyLost);
  const decided = [...wonDeals, ...lostDeals];
  const inspQualIdx = STAGE_ORDER.indexOf("Inspection Qualified");
  const reachedInspQual = advisorDeals.filter(d => STAGE_ORDER.indexOf(d.Stage) >= inspQualIdx);
  const quoteSentIdx = STAGE_ORDER.indexOf("Quote Sent");
  const reachedQuote = advisorDeals.filter(d => STAGE_ORDER.indexOf(d.Stage) >= quoteSentIdx);
  const inQuoteSent = advisorDeals.filter(d => d.Stage === "Quote Sent");
  const wonWithCycle = wonDeals.filter(d => d.Sales_Cycle_Duration && d.Sales_Cycle_Duration > 0);

  // Register drill-downs
  registerDrill("kpi_projects", "Total projects", "Closed Won, Scheduled Execution, Project Started, Project Done, Project Finalised", wonDeals);
  registerDrill("kpi_revenue", "Realised revenue", `Total: ${fmtEur(k.realisedRevenue)} from ${wonDeals.length} won deals`, wonDeals);
  registerDrill("kpi_q2w", "Quote → Won conversion (decided)", `${k.wonCount} won + ${k.lostCount} lost = ${k.wonCount + k.lostCount} decided deals (incl. 21d ghosted Quote Sent)`, decided);
  registerDrill("kpi_i2w", "Inspection → Won conversion (qualified leads)", `${reachedInspQual.length} deals that reached Inspection Qualified or beyond (incl. still in-flight)`, reachedInspQual);
  registerDrill("kpi_inqs", "Deals in Quote Sent", "Currently awaiting customer decision", inQuoteSent);
  registerDrill("kpi_cycle", "Won deals with sales cycle data", `${wonWithCycle.length} won deals with Sales_Cycle_Duration > 0`, wonWithCycle);
  registerDrill("kpi_l2q", "Reached Quote Sent or beyond", `${reachedQuote.length} of ${advisorDeals.length} advisor deals`, reachedQuote);

  return `<div class="kpi-hero-row">
    <div class="kpi-hero clickable" onclick="window.__showDrill('kpi_projects')">
      <div class="kpi-hero-label">Total projects</div>
      <div class="kpi-hero-value">${k.wonCount}</div>
      <div class="kpi-hero-sub">avg ${fmtEur(avgDeal)} per deal</div>
    </div>
    <div class="kpi-hero clickable" onclick="window.__showDrill('kpi_revenue')">
      <div class="kpi-hero-label">Realised revenue</div>
      <div class="kpi-hero-value">${fmtEur(k.realisedRevenue)}</div>
      <div class="kpi-hero-sub">from ${k.wonCount} won deal${k.wonCount === 1 ? "" : "s"}</div>
    </div>
    <div class="kpi-hero clickable" onclick="window.__showDrill('kpi_q2w')">
      <div class="kpi-hero-label">Quote → Won conversion</div>
      <div class="kpi-hero-value">${fmtPct(k.quoteToClose)}</div>
      <div class="kpi-hero-sub">of decided quotes (${k.wonCount} of ${k.wonCount + k.lostCount})</div>
    </div>
    <div class="kpi-hero clickable" onclick="window.__showDrill('kpi_i2w')">
      <div class="kpi-hero-label">Inspection → Won conversion</div>
      <div class="kpi-hero-value">${fmtPct(k.inspectionToWon)}</div>
      <div class="kpi-hero-sub">of qualified leads (${k.wonCount} of ${k.reachedInspQual})</div>
    </div>
  </div>
  <div class="kpi-secondary-row">
    <div class="kpi-secondary clickable" onclick="window.__showDrill('kpi_inqs')">
      <span class="kpi-secondary-label">In Quote Sent</span>
      <span class="kpi-secondary-value">${k.inQuoteSent}</span>
      <span class="kpi-secondary-sub">awaiting decision</span>
    </div>
    <div class="kpi-secondary clickable" onclick="window.__showDrill('kpi_cycle')">
      <span class="kpi-secondary-label">Avg sales cycle</span>
      <span class="kpi-secondary-value">${k.avgCycle !== null ? Math.round(k.avgCycle) + "d" : "—"}</span>
      <span class="kpi-secondary-sub">won deals only</span>
    </div>
    <div class="kpi-secondary clickable" onclick="window.__showDrill('kpi_l2q')">
      <span class="kpi-secondary-label">Lead → Quote</span>
      <span class="kpi-secondary-value">${fmtPct(k.leadToQuote)}</span>
      <span class="kpi-secondary-sub">${k.advisorTotal} advisor deals reached quote</span>
    </div>
  </div>`;
}

// ============== BLOWN-IN STATS ==============
function computeBlownInStats(deals, blownInSet) {
  // Only count deals that became projects (= won deals)
  const projects = deals.filter(d => WON_STAGES.has(d.Stage));
  let blownInCount = 0, blownInRevenue = 0;
  let otherCount = 0, otherRevenue = 0;
  projects.forEach(d => {
    const amt = Number(d.Amount) || 0;
    if (blownInSet && blownInSet.has(d.id)) {
      blownInCount++;
      blownInRevenue += amt;
    } else {
      otherCount++;
      otherRevenue += amt;
    }
  });
  const total = projects.length;
  const sharePct = total > 0 ? (blownInCount / total) * 100 : 0;
  const otherSharePct = total > 0 ? (otherCount / total) * 100 : 0;
  return { total, blownInCount, blownInRevenue, otherCount, otherRevenue, sharePct, otherSharePct };
}

function blownInHtml(stats, isLoading, filteredDeals, blownInSet) {
  if (isLoading) {
    return `<div class="section">
      <h2>🌬️ Blown-in share of projects</h2>
      <div class="subtitle">Computing from Quote line items&hellip;</div>
      <div class="intake-summary">
        <div class="intake-summary-label">Loading</div>
        <div class="intake-summary-value" style="font-size:14px; font-weight:400; color:#64748b;">Fetching Quote data, this may take a few seconds.</div>
      </div>
    </div>`;
  }
  if (blownInLoadError) {
    return `<div class="section">
      <h2>🌬️ Blown-in share of projects</h2>
      <div class="subtitle" style="color:#dc2626;">Could not load blown-in data: ${escapeHtml(blownInLoadError)}</div>
    </div>`;
  }
  const avgBlownIn = stats.blownInCount > 0 ? stats.blownInRevenue / stats.blownInCount : 0;
  const avgOther = stats.otherCount > 0 ? stats.otherRevenue / stats.otherCount : 0;

  // Register drill-downs
  const projects = (filteredDeals || []).filter(d => WON_STAGES.has(d.Stage));
  const blownInDeals = projects.filter(d => blownInSet && blownInSet.has(d.id));
  const otherDeals = projects.filter(d => !blownInSet || !blownInSet.has(d.id));
  registerDrill("blown_in", "Blown-in projects", `${blownInDeals.length} projects · ${fmtEur(stats.blownInRevenue)} revenue`, blownInDeals);
  registerDrill("blown_other", "Projects with other techniques", `${otherDeals.length} projects · ${fmtEur(stats.otherRevenue)} revenue`, otherDeals);
  registerDrill("blown_total", "All projects", `${projects.length} won + execution + finalised projects`, projects);

  return `<div class="section">
    <h2>🌬️ Blown-in share of projects</h2>
    <div class="subtitle">Project = Closed Won or beyond · classification based on most recent quote's line items · ${stats.total} project${stats.total === 1 ? "" : "s"} analysed · click any tile to see deals</div>
    <div class="blown-in-grid">
      <div class="blown-in-tile blown clickable" onclick="window.__showDrill('blown_in')">
        <div class="blown-in-label">Blown-in projects</div>
        <div class="blown-in-value">${stats.blownInCount}</div>
        <div class="blown-in-pct">${fmtPct(stats.sharePct)} of total</div>
        <div class="blown-in-detail">${fmtEur(stats.blownInRevenue)} revenue · avg ${fmtEur(avgBlownIn)}/deal</div>
      </div>
      <div class="blown-in-tile other clickable" onclick="window.__showDrill('blown_other')">
        <div class="blown-in-label">Other techniques</div>
        <div class="blown-in-value">${stats.otherCount}</div>
        <div class="blown-in-pct">${fmtPct(stats.otherSharePct)} of total</div>
        <div class="blown-in-detail">${fmtEur(stats.otherRevenue)} revenue · avg ${fmtEur(avgOther)}/deal</div>
      </div>
      <div class="blown-in-tile total clickable" onclick="window.__showDrill('blown_total')">
        <div class="blown-in-label">Total projects</div>
        <div class="blown-in-value">${stats.total}</div>
        <div class="blown-in-pct">100%</div>
        <div class="blown-in-detail">${fmtEur(stats.blownInRevenue + stats.otherRevenue)} total revenue</div>
      </div>
    </div>
    <div class="blown-in-bar">
      <div class="blown-in-bar-blown" style="width:${stats.sharePct}%" title="Blown-in ${fmtPct(stats.sharePct)}"></div>
      <div class="blown-in-bar-other" style="width:${stats.otherSharePct}%" title="Other ${fmtPct(stats.otherSharePct)}"></div>
    </div>
  </div>`;
}

function conversionTrendHtml(trend, allDeals) {
  const MIN_SAMPLE = 5;
  const fmt = (v) => v === null ? "—" : fmtPct(v);

  // Build deal subsets per trend cell + register drill-downs
  trend.forEach((t, i) => {
    // Find deals in period
    const inRange = (allDeals || []).filter(d => {
      if (!d.Created_Time) return false;
      const ct = new Date(d.Created_Time);
      return ct >= t.from && ct <= t.to;
    });
    const advisorDeals = inRange.filter(isAdvisorAttributable);
    const won = advisorDeals.filter(d => WON_STAGES.has(d.Stage));
    const lost = advisorDeals.filter(d => isEffectivelyLost(d));
    const inspQualIdx = STAGE_ORDER.indexOf("Inspection Qualified");
    const qualified = advisorDeals.filter(d => STAGE_ORDER.indexOf(d.Stage) >= inspQualIdx);
    registerDrill("trend_" + i + "_m1", `${t.label}: Quote → Won (decided)`, `${t.sub} · ${won.length} won + ${lost.length} lost`, [...won, ...lost]);
    registerDrill("trend_" + i + "_m2", `${t.label}: Inspection → Won (qualified)`, `${t.sub} · ${qualified.length} qualified leads (incl. in-flight)`, qualified);
  });

  const renderMetric = (label, value, currentIdx, methodKey, sampleKey, sampleNoun, drillKey) => {
    const isLowConf = trend[currentIdx][sampleKey] < MIN_SAMPLE;
    const prior = trend[currentIdx + 1];
    let deltaHtml = "";
    if (prior && prior[methodKey] !== null && value !== null) {
      const diff = value - prior[methodKey];
      const arrow = diff > 0.5 ? "▲" : diff < -0.5 ? "▼" : "▬";
      const cls = diff > 0.5 ? "delta-up" : diff < -0.5 ? "delta-down" : "delta-flat";
      deltaHtml = `<span class="trend-arrow ${cls}">${arrow} ${diff > 0 ? "+" : ""}${diff.toFixed(0)}pt</span>`;
    }
    return `<div class="trend-metric clickable ${isLowConf ? "low-conf" : ""}" onclick="window.__showDrill('${drillKey}')">
      <div class="trend-metric-label">${escapeHtml(label)}</div>
      <div class="trend-metric-value">${fmt(value)} ${deltaHtml}</div>
      <div class="trend-metric-sub">${trend[currentIdx].wonCount} / ${trend[currentIdx][sampleKey]} ${sampleNoun}${isLowConf ? " · low sample" : ""}</div>
    </div>`;
  };
  return `<div class="section">
    <h2>📈 Conversion trend</h2>
    <div class="subtitle">How conversion is moving across periods · uses Created_Time · period filter above does not apply here · ▲▼ = vs older period · cells with fewer than ${MIN_SAMPLE} decided/qualified deals are dimmed (low confidence) · click any cell to see underlying deals</div>
    <div class="trend-grid">
      ${trend.map((t, i) => `<div class="trend-cell">
        <div class="trend-period">${escapeHtml(t.label)}</div>
        <div class="trend-sub">${escapeHtml(t.sub)}</div>
        <div class="trend-metrics">
          ${renderMetric("Quote → Won", t.m1, i, "m1", "decidedCount", "decided", "trend_" + i + "_m1")}
          ${renderMetric("Inspection → Won", t.m2, i, "m2", "reachedInspQual", "qualified", "trend_" + i + "_m2")}
        </div>
      </div>`).join("")}
    </div>
  </div>`;
}

// ============== LEADERBOARD ==============
function computeLeaderboard(deals) {
  const advisorDeals = deals.filter(d =>
    isAdvisorAttributable(d) &&
    getOwnerName(d) &&
    !CUSTOMER_SERVICE_OWNERS.has(getOwnerName(d))
  );
  const stats = {};
  advisorDeals.forEach(d => {
    const name = getOwnerName(d);
    if (!stats[name]) stats[name] = { total: 0, won: 0, lost: 0, revenue: 0, cycleSum: 0, cycleN: 0, biggest: 0, biggestRef: null };
    stats[name].total++;
    if (WON_STAGES.has(d.Stage)) {
      stats[name].won++;
      const amt = Number(d.Amount) || 0;
      stats[name].revenue += amt;
      if (d.Sales_Cycle_Duration && d.Sales_Cycle_Duration > 0) {
        stats[name].cycleSum += d.Sales_Cycle_Duration;
        stats[name].cycleN++;
      }
      if (amt > stats[name].biggest) {
        stats[name].biggest = amt;
        stats[name].biggestRef = d.Reference_Number || ("#" + (d.id || "").slice(-4));
      }
    } else if (isEffectivelyLost(d)) {
      stats[name].lost++;
    }
  });
  return Object.entries(stats).map(([name, s]) => {
    const decided = s.won + s.lost;
    const winRate = decided > 0 ? (s.won / decided) * 100 : 0;
    const avgCycle = s.cycleN > 0 ? s.cycleSum / s.cycleN : null;
    const avgDealSize = s.won > 0 ? s.revenue / s.won : 0;
    return { name, ...s, winRate, avgCycle, avgDealSize, score: s.revenue * (winRate / 100) };
  }).sort((a, b) => b.score - a.score);
}

function leaderboardHtml(leaders, allDeals) {
  let html = `<div class="section">
    <h2>🏆 Sales Advisor Leaderboard</h2>
    <div class="subtitle">Advisor-attributable deals · ranked by revenue × win rate · ghosted Quote Sent (21d+) reclassified as lost · click row to see deals</div>
    <div class="leader-row header">
      <div></div><div>Sales Advisor</div>
      <div>Won</div>
      <div>Revenue</div>
      <div>Q→Close %</div>
    </div>`;
  if (!leaders.length) {
    html += `<div style="padding:14px; color:#94a3b8; text-align:center;">No advisor deals.</div>`;
  } else {
    leaders.forEach((l, i) => {
      const rankCls = i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "";
      const advisorDeals = (allDeals || []).filter(d =>
        isAdvisorAttributable(d) && getOwnerName(d) === l.name
      );
      const key = `leader_${l.name.replace(/[^a-z0-9]/gi, "_")}`;
      registerDrill(key, `${ownerLastName(l.name)} — all deals`, `${advisorDeals.length} advisor deals · ${l.won} won · ${l.lost} lost · ${fmtEur(l.revenue)} revenue`, advisorDeals);
      html += `<div class="leader-row clickable" onclick="window.__showDrill('${key}')">
        <div class="rank ${rankCls}">${i + 1}</div>
        <div class="leader-name">${escapeHtml(ownerLastName(l.name))}</div>
        <div class="leader-stat">${l.won}</div>
        <div class="leader-stat">${fmtEur(l.revenue)}</div>
        <div class="leader-stat">${fmtPct(l.winRate)}</div>
      </div>`;
    });
  }
  html += "</div>";
  return html;
}

// ============== TROPHIES ==============
function trophiesHtml(leaders, allDeals) {
  if (!leaders.length) return "";
  const minWonForRate = 3;
  const pick = (sortFn, filterFn) => {
    const pool = filterFn ? leaders.filter(filterFn) : leaders;
    return pool.length ? pool.slice().sort(sortFn)[0] : null;
  };
  const trophies = [];
  const mw = pick((a, b) => b.won - a.won, x => x.won > 0);
  if (mw) trophies.push({ icon: "🏆", title: "Most deals won", holder: ownerLastName(mw.name), detail: `${mw.won} won · ${fmtEur(mw.revenue)}` });
  const hr = pick((a, b) => b.revenue - a.revenue, x => x.revenue > 0);
  if (hr) trophies.push({ icon: "💰", title: "Highest revenue", holder: ownerLastName(hr.name), detail: `${fmtEur(hr.revenue)} across ${hr.won} deals` });
  let bg = null;
  leaders.forEach(s => { if (s.biggest > 0 && (!bg || s.biggest > bg.biggest)) bg = s; });
  if (bg) trophies.push({ icon: "💎", title: "Biggest single deal", holder: ownerLastName(bg.name), detail: `${fmtEur(bg.biggest)} (${bg.biggestRef || "—"})` });
  const br = pick((a, b) => b.winRate - a.winRate, x => x.won >= minWonForRate);
  if (br) trophies.push({ icon: "🎯", title: "Best win rate", holder: ownerLastName(br.name), detail: `${fmtPct(br.winRate)} (${br.won}/${br.won + br.lost})` });
  const fc = pick((a, b) => a.avgCycle - b.avgCycle, x => x.avgCycle !== null && x.won >= minWonForRate);
  if (fc) trophies.push({ icon: "⚡", title: "Fastest closer", holder: ownerLastName(fc.name), detail: `${Math.round(fc.avgCycle)}d avg cycle (${fc.won} won)` });
  const ad = pick((a, b) => b.avgDealSize - a.avgDealSize, x => x.won >= minWonForRate);
  if (ad) trophies.push({ icon: "📈", title: "Highest avg deal size", holder: ownerLastName(ad.name), detail: `${fmtEur(ad.avgDealSize)}/deal (${ad.won} deals)` });

  return `<div class="section">
    <h2>🎖️ Trophies</h2>
    <div class="subtitle">Per-advisor records · min. 3 won deals to qualify for win-rate trophies · click any trophy to see holder's deals</div>
    <div class="badge-grid">
      ${trophies.map((t, i) => {
        // Find holder's deals
        const holderDeals = (allDeals || []).filter(d => {
          const owner = getOwnerName(d);
          return owner && ownerLastName(owner) === t.holder && isAdvisorAttributable(d);
        });
        const key = `trophy_${i}_${t.holder.replace(/[^a-z0-9]/gi, "_")}`;
        registerDrill(key, `${t.title}: ${t.holder}`, t.detail, holderDeals);
        return `<div class="badge clickable" onclick="window.__showDrill('${key}')">
        <div class="badge-icon">${t.icon}</div>
        <div class="badge-content">
          <div class="badge-title">${t.title}</div>
          <div class="badge-holder">${escapeHtml(t.holder)}</div>
          <div class="badge-detail">${t.detail}</div>
        </div>
      </div>`;
      }).join("")}
    </div>
  </div>`;
}

// ============== LEAD SOURCE ROI ==============
function leadSourceHtml(deals) {
  const sources = {};
  deals.filter(isAdvisorAttributable).forEach(d => {
    const src = d.Lead_Source || "Unknown";
    if (!sources[src]) sources[src] = { total: 0, won: 0, lost: 0, revenue: 0 };
    sources[src].total++;
    if (WON_STAGES.has(d.Stage)) { sources[src].won++; sources[src].revenue += Number(d.Amount) || 0; }
    else if (isEffectivelyLost(d)) sources[src].lost++;
  });
  const rows = Object.entries(sources).map(([name, s]) => {
    const decided = s.won + s.lost;
    return { name, ...s, winRate: decided > 0 ? (s.won / decided) * 100 : 0 };
  }).sort((a, b) => b.revenue - a.revenue);

  let html = `<div class="section">
    <h2>📡 Lead Source ROI</h2>
    <div class="subtitle">Which sources bring revenue · sorted by revenue · click row to see deals</div>
    <div class="source-row header">
      <div>Source</div><div>Total</div><div>Won</div><div>Revenue</div><div>Win %</div>
    </div>`;
  rows.forEach(s => {
    const sourceDeals = deals.filter(d => isAdvisorAttributable(d) && (d.Lead_Source || "Unknown") === s.name);
    const key = `src_${s.name.replace(/[^a-z0-9]/gi, "_")}`;
    registerDrill(key, `Lead Source: ${s.name}`, `${s.total} advisor deals · ${s.won} won · ${s.lost} lost · ${fmtEur(s.revenue)} revenue`, sourceDeals);
    html += `<div class="source-row clickable" onclick="window.__showDrill('${key}')">
      <div class="source-name">${escapeHtml(s.name)}</div>
      <div class="num">${s.total}</div>
      <div class="num">${s.won}</div>
      <div class="num">${fmtEur(s.revenue)}</div>
      <div class="num">${fmtPct(s.winRate)}</div>
    </div>`;
  });
  html += "</div>";
  return html;
}

// ============== CONVERSION FUNNEL ==============
function funnelHtml(deals) {
  const stageCounts = {};
  deals.forEach(d => {
    // Apply Pipeline Rules: ghosted Quote Sent → Closed Lost
    const effectiveStage = (d.Stage === "Quote Sent" && daysSince(d.Modified_Time) >= STALE_QUOTE_DAYS)
      ? "Closed Lost" : d.Stage;
    stageCounts[effectiveStage] = (stageCounts[effectiveStage] || 0) + 1;
  });

  const stagesPresent = STAGE_ORDER.filter(s => stageCounts[s]);
  const total = deals.length;
  const maxCount = Math.max(...Object.values(stageCounts));

  let html = `<div class="section">
    <h2>🔻 Conversion Funnel</h2>
    <div class="subtitle">Stage distribution with Pipeline Rules applied (ghosted Quote Sent reclassified as Closed Lost) · click row to see deals</div>
    <div class="funnel-row header">
      <div>Stage</div><div>Deals</div><div>% of total</div><div></div>
    </div>`;
  stagesPresent.forEach(s => {
    const c = stageCounts[s];
    const pct = total > 0 ? (c / total * 100) : 0;
    const barPct = maxCount > 0 ? (c / maxCount * 100) : 0;
    const cls = WON_STAGES.has(s) ? "won" : (LOST_STAGES_RAW.has(s) || s === "Closed Not Qualified") ? "lost" : "active";
    // For each stage, include deals where current Stage equals the effective stage
    // (handles ghosted Quote Sent → Closed Lost reclassification)
    const stageDeals = deals.filter(d => {
      const effective = (d.Stage === "Quote Sent" && daysSince(d.Modified_Time) >= STALE_QUOTE_DAYS) ? "Closed Lost" : d.Stage;
      return effective === s;
    });
    const key = `funnel_${s.replace(/[^a-z0-9]/gi, "_")}`;
    registerDrill(key, `Funnel stage: ${s}`, `${c} deals currently in this stage (incl. ghost-reclassified)`, stageDeals);
    html += `<div class="funnel-row clickable" onclick="window.__showDrill('${key}')">
      <div class="stage-name">${escapeHtml(s)}</div>
      <div class="funnel-count">${c}</div>
      <div class="funnel-pct">${pct.toFixed(1)}%</div>
      <div class="funnel-bar-container"><div class="funnel-bar ${cls}" style="width:${barPct}%"></div></div>
    </div>`;
  });
  html += "</div>";
  return html;
}

// ============== LOSS REASONS ==============
function lossReasonsHtml(deals) {
  const lostDeals = deals.filter(d => d.Stage === "Closed Lost");
  if (!lostDeals.length) return "";
  const counts = {};
  lostDeals.forEach(d => {
    const reason = d.Reason_For_Loss__s || "Unknown";
    counts[reason] = (counts[reason] || 0) + 1;
  });
  const max = Math.max(...Object.values(counts));
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  let html = `<div class="section">
    <h2>📉 Loss Reason Distribution</h2>
    <div class="subtitle">Why deals are lost · ${lostDeals.length} Closed Lost deals analysed · click row to see deals</div>
    <div class="loss-row header">
      <div>Reason</div><div>Count</div><div>Distribution</div><div>Type</div>
    </div>`;
  rows.forEach(([reason, count]) => {
    const bucket = LOSS_REASON_BUCKET[reason] || "other";
    const barPct = max > 0 ? (count / max * 100) : 0;
    const reasonDeals = lostDeals.filter(d => (d.Reason_For_Loss__s || "Unknown") === reason);
    const key = `loss_${reason.replace(/[^a-z0-9]/gi, "_")}`;
    registerDrill(key, `Loss reason: ${reason}`, `${count} Closed Lost deals · category: ${bucket}`, reasonDeals);
    html += `<div class="loss-row clickable ${bucket}" onclick="window.__showDrill('${key}')">
      <div>${escapeHtml(reason)}</div>
      <div style="text-align:right; font-weight:600;">${count}</div>
      <div class="loss-bar-container"><div class="loss-bar" style="width:${barPct}%"></div></div>
      <div style="font-size:10px; text-transform:uppercase; color:#94a3b8;">${bucket}</div>
    </div>`;
  });
  html += "</div>";
  return html;
}

// ============== LEAD INTAKE ==============
function ensureLeadIntakeCustomDefaults() {
  if (!leadIntakeCustomFrom) {
    const d = new Date(TODAY.getTime() - 30 * 24 * 60 * 60 * 1000);
    leadIntakeCustomFrom = d.toISOString().slice(0, 10);
  }
  if (!leadIntakeCustomTo) {
    leadIntakeCustomTo = TODAY.toISOString().slice(0, 10);
  }
}

// Monday-start week
function getWeekStart(d) {
  const dt = new Date(d);
  const day = dt.getDay(); // 0 = Sunday, 1 = Monday
  const diff = day === 0 ? -6 : 1 - day;
  dt.setDate(dt.getDate() + diff);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function fmtDateShort(d) {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function computeLeadIntake(deals, granularity) {
  // Custom: return a single bucket with comparison to prior equal-length period
  if (granularity === "custom") {
    ensureLeadIntakeCustomDefaults();
    const from = new Date(leadIntakeCustomFrom + "T00:00:00");
    const to = new Date(leadIntakeCustomTo + "T23:59:59");
    const inPeriod = deals.filter(d => {
      if (!d.Created_Time) return false;
      const t = new Date(d.Created_Time);
      return t >= from && t <= to;
    });
    const periodMs = to - from;
    const priorTo = new Date(from.getTime() - 1);
    const priorFrom = new Date(priorTo.getTime() - periodMs);
    const inPrior = deals.filter(d => {
      if (!d.Created_Time) return false;
      const t = new Date(d.Created_Time);
      return t >= priorFrom && t <= priorTo;
    });
    return {
      isCustom: true,
      label: `${fmtDateShort(from)} → ${fmtDateShort(to)}`,
      count: inPeriod.length,
      priorCount: inPrior.length,
      priorLabel: `${fmtDateShort(priorFrom)} → ${fmtDateShort(priorTo)}`
    };
  }

  const numBuckets = (GRANULARITIES.find(g => g.id === granularity) || {}).buckets || 12;
  const buckets = [];
  for (let i = 0; i < numBuckets; i++) {
    let start, end, label;
    const offset = numBuckets - 1 - i; // i=0 is the oldest bucket, latest at end
    if (granularity === "weekly") {
      const ws = getWeekStart(TODAY);
      ws.setDate(ws.getDate() - 7 * offset);
      start = new Date(ws);
      end = new Date(ws);
      end.setDate(end.getDate() + 7);
      const lastDay = new Date(end.getTime() - 1);
      label = `${fmtDateShort(start)} – ${fmtDateShort(lastDay)}`;
    } else if (granularity === "monthly") {
      const m = new Date(TODAY.getFullYear(), TODAY.getMonth() - offset, 1);
      start = new Date(m);
      end = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      label = m.toLocaleDateString("en-GB", { month: "short", year: "numeric" });
    } else if (granularity === "quarterly") {
      const currentQ = Math.floor(TODAY.getMonth() / 3);
      const totalQ = TODAY.getFullYear() * 4 + currentQ - offset;
      const year = Math.floor(totalQ / 4);
      const q = ((totalQ % 4) + 4) % 4;
      start = new Date(year, q * 3, 1);
      end = new Date(year, q * 3 + 3, 1);
      label = `Q${q + 1} ${year}`;
    }
    const count = deals.filter(d => {
      if (!d.Created_Time) return false;
      const t = new Date(d.Created_Time);
      return t >= start && t < end;
    }).length;
    buckets.push({ label, count, start, end });
  }

  // Attach prior-period count (= previous bucket in series, MoM/WoW/QoQ)
  const withDelta = buckets.map((b, i) => ({
    ...b,
    priorCount: i > 0 ? buckets[i - 1].count : null
  }));

  // Attach YoY count (= bucket from same period 1 year prior, if present in the series)
  // Only meaningful for monthly + quarterly (year grouping); set null for weekly
  const cfg = GRANULARITIES.find(g => g.id === granularity) || {};
  if (cfg.grouping === "year") {
    withDelta.forEach(b => {
      if (!b.start) { b.yoyCount = null; return; }
      const target = withDelta.find(other => {
        if (!other.start) return false;
        if (granularity === "monthly") {
          return other.start.getFullYear() === b.start.getFullYear() - 1 &&
                 other.start.getMonth() === b.start.getMonth();
        }
        if (granularity === "quarterly") {
          const otherQ = Math.floor(other.start.getMonth() / 3);
          const bQ = Math.floor(b.start.getMonth() / 3);
          return other.start.getFullYear() === b.start.getFullYear() - 1 && otherQ === bQ;
        }
        return false;
      });
      b.yoyCount = target ? target.count : null;
    });
  }

  return { isCustom: false, buckets: withDelta, grouping: cfg.grouping || "flat", granularity };
}

// Group buckets by calendar year (most recent year first)
function groupBucketsByYear(buckets) {
  const groups = {};
  buckets.forEach(b => {
    if (!b.start) return;
    const year = b.start.getFullYear();
    if (!groups[year]) groups[year] = [];
    groups[year].push(b);
  });
  return Object.entries(groups)
    .map(([year, bs]) => ({
      year: Number(year),
      // Within a year: most recent period first
      buckets: bs.slice().sort((a, b) => b.start - a.start),
      total: bs.reduce((s, b) => s + b.count, 0),
      // YoY at year level: sum of YoY values where available (only counts comparable periods)
      yoySum: bs.reduce((s, b) => s + (b.yoyCount !== null ? b.yoyCount : 0), 0),
      yoyCoverage: bs.filter(b => b.yoyCount !== null).length
    }))
    .sort((a, b) => b.year - a.year);
}

function deltaHtml(count, prior) {
  if (prior === null || prior === undefined) return `<span class="delta-flat">—</span>`;
  const diff = count - prior;
  const sign = diff > 0 ? "+" : "";
  const cls = diff > 0 ? "delta-up" : diff < 0 ? "delta-down" : "delta-flat";
  const pct = prior > 0 ? ` (${sign}${Math.round(diff / prior * 100)}%)` : "";
  return `<span class="${cls}">${sign}${diff}${pct}</span>`;
}

function leadIntakeHtml(intake, granularity, allDeals) {
  // Helper to get deals in a bucket range
  const dealsInBucket = (b) => (allDeals || []).filter(d => {
    if (!d.Created_Time) return false;
    const ct = new Date(d.Created_Time);
    return ct >= b.start && ct < b.end;
  });
  const buttons = GRANULARITIES.map(g =>
    `<button class="filter-btn ${g.id === granularity ? "active" : ""}" onclick="window.__li_setGranularity('${g.id}')">${g.label}</button>`
  ).join("");

  let customRow = "";
  if (granularity === "custom") {
    ensureLeadIntakeCustomDefaults();
    customRow = `<div class="filter-custom-row">
      <span class="filter-label">From:</span>
      <input type="date" class="filter-date" value="${leadIntakeCustomFrom}" onchange="window.__li_setCustomDate('from', this.value)" max="${TODAY.toISOString().slice(0,10)}">
      <span class="filter-label">To:</span>
      <input type="date" class="filter-date" value="${leadIntakeCustomTo}" onchange="window.__li_setCustomDate('to', this.value)" max="${TODAY.toISOString().slice(0,10)}">
    </div>`;
  }

  const periodWord = granularity === "weekly" ? "week" : granularity === "monthly" ? "month" : granularity === "quarterly" ? "quarter" : "period";
  let body = "";

  if (intake.isCustom) {
    // Custom: use leadIntakeCustomFrom/To to get the deals
    const from = new Date(leadIntakeCustomFrom + "T00:00:00");
    const to = new Date(leadIntakeCustomTo + "T23:59:59");
    const customDeals = (allDeals || []).filter(d => {
      if (!d.Created_Time) return false;
      const ct = new Date(d.Created_Time);
      return ct >= from && ct <= to;
    });
    registerDrill("intake_custom", `Lead Intake · ${intake.label}`, `${customDeals.length} new deals in custom range`, customDeals);
    body = `<div class="intake-summary clickable" onclick="window.__showDrill('intake_custom')">
      <div class="intake-summary-label">New deals · ${escapeHtml(intake.label)}</div>
      <div class="intake-summary-value">${intake.count}</div>
      <div class="intake-summary-prior">vs ${intake.priorCount} in prior equal period (${escapeHtml(intake.priorLabel)}) ${deltaHtml(intake.count, intake.priorCount)}</div>
    </div>`;
  } else if (intake.grouping === "year") {
    // Year-grouped layout with YoY column
    const yearGroups = groupBucketsByYear(intake.buckets);
    const maxCount = Math.max(1, ...intake.buckets.map(b => b.count));
    const totals = intake.buckets.reduce((s, b) => s + b.count, 0);
    const avg = totals / intake.buckets.length;

    // Summary drill: all deals across all shown buckets
    const allShownDeals = intake.buckets.flatMap(b => dealsInBucket(b));
    registerDrill("intake_total", `Lead Intake · total across ${intake.buckets.length} ${periodWord}s`, `${allShownDeals.length} new deals across all shown periods`, allShownDeals);

    body = `<div class="intake-summary clickable" onclick="window.__showDrill('intake_total')">
      <div class="intake-summary-label">Total across ${intake.buckets.length} ${periodWord}s shown</div>
      <div class="intake-summary-value">${totals}</div>
      <div class="intake-summary-prior">avg ${avg.toFixed(1)} per ${periodWord} · grouped by calendar year · YoY = same period prior year</div>
    </div>`;

    yearGroups.forEach(yg => {
      const yearAvg = yg.total / yg.buckets.length;
      const yearCurrentMatched = yg.buckets.filter(b => b.yoyCount !== null).reduce((s, b) => s + b.count, 0);
      const yearYoyDelta = yg.yoyCoverage > 0 ? deltaHtml(yearCurrentMatched, yg.yoySum) : `<span class="delta-flat">no prior-year data</span>`;
      const yearYoyNote = yg.yoyCoverage > 0
        ? `vs ${yg.yoySum} in same ${yg.yoyCoverage} ${periodWord}${yg.yoyCoverage === 1 ? "" : "s"} of ${yg.year - 1}: ${yearYoyDelta}`
        : `<span class="delta-flat">no overlapping data with ${yg.year - 1}</span>`;

      // Drill for the entire year
      const yearDeals = yg.buckets.flatMap(b => dealsInBucket(b));
      registerDrill(`intake_year_${yg.year}`, `Lead Intake ${yg.year}`, `${yearDeals.length} new deals across ${yg.buckets.length} ${periodWord}${yg.buckets.length === 1 ? '' : 's'}`, yearDeals);

      body += `<div class="intake-year-header clickable" onclick="window.__showDrill('intake_year_${yg.year}')">
        <div class="intake-year-title">${yg.year}</div>
        <div class="intake-year-stats">${yg.total} new deal${yg.total === 1 ? "" : "s"} · avg ${yearAvg.toFixed(1)}/${periodWord} · ${yearYoyNote}</div>
      </div>
      <div class="intake-row header yoy">
        <div>Period</div>
        <div>New deals</div>
        <div>Distribution</div>
        <div>vs prior ${periodWord}</div>
        <div>vs ${yg.year - 1}</div>
      </div>`;
      yg.buckets.forEach((b, bi) => {
        const barPct = (b.count / maxCount) * 100;
        const yoy = b.yoyCount !== null ? deltaHtml(b.count, b.yoyCount) : `<span class="delta-flat">—</span>`;
        const drillKey = `intake_${yg.year}_${bi}_${b.label.replace(/[^a-z0-9]/gi, '_')}`;
        registerDrill(drillKey, `Lead Intake · ${b.label}`, `${b.count} new deal${b.count === 1 ? '' : 's'} created in this period`, dealsInBucket(b));
        body += `<div class="intake-row yoy clickable" onclick="window.__showDrill('${drillKey}')">
          <div class="intake-label">${escapeHtml(b.label)}</div>
          <div class="intake-count">${b.count}</div>
          <div class="intake-bar-container"><div class="intake-bar" style="width:${barPct}%"></div></div>
          <div class="intake-delta">${deltaHtml(b.count, b.priorCount)}</div>
          <div class="intake-delta">${yoy}</div>
        </div>`;
      });
    });
  } else {
    // Flat layout (weekly)
    const maxCount = Math.max(1, ...intake.buckets.map(b => b.count));
    const totals = intake.buckets.reduce((s, b) => s + b.count, 0);
    const avg = totals / intake.buckets.length;
    const allShownDeals = intake.buckets.flatMap(b => dealsInBucket(b));
    registerDrill("intake_total_flat", `Lead Intake · total across ${intake.buckets.length} ${periodWord}s`, `${allShownDeals.length} new deals across all shown periods`, allShownDeals);
    body = `<div class="intake-summary clickable" onclick="window.__showDrill('intake_total_flat')">
      <div class="intake-summary-label">Total across shown periods</div>
      <div class="intake-summary-value">${totals}</div>
      <div class="intake-summary-prior">avg ${avg.toFixed(1)} per ${periodWord}</div>
    </div>
    <div class="intake-row header">
      <div>Period</div>
      <div>New deals</div>
      <div>Distribution</div>
      <div>vs prior period</div>
    </div>`;
    intake.buckets.forEach((b, i) => {
      const barPct = (b.count / maxCount) * 100;
      const drillKey = `intake_flat_${i}_${b.label.replace(/[^a-z0-9]/gi, '_')}`;
      registerDrill(drillKey, `Lead Intake · ${b.label}`, `${b.count} new deal${b.count === 1 ? '' : 's'} created in this period`, dealsInBucket(b));
      body += `<div class="intake-row clickable" onclick="window.__showDrill('${drillKey}')">
        <div class="intake-label">${escapeHtml(b.label)}</div>
        <div class="intake-count">${b.count}</div>
        <div class="intake-bar-container"><div class="intake-bar" style="width:${barPct}%"></div></div>
        <div class="intake-delta">${deltaHtml(b.count, b.priorCount)}</div>
      </div>`;
    });
  }

  return `<div class="section">
    <h2>📥 Lead Intake</h2>
    <div class="subtitle">New deals created per period · Pipeline = Regular · independent of the period filter above</div>
    <div class="filter-row" style="margin-bottom:8px;">
      <span class="filter-label">Granularity:</span>
      ${buttons}
    </div>
    ${customRow}
    ${body}
  </div>`;
}

// ============== FILTER BUTTONS ==============
function filterButtonsHtml(activeId) {
  const buttons = FILTERS.map(f =>
    `<button class="filter-btn ${f.id === activeId ? "active" : ""}" onclick="window.__sp_setFilter('${f.id}')">${f.label}</button>`
  ).join("");
  let customRow = "";
  if (activeId === "custom") {
    ensureCustomDefaults();
    customRow = `<div class="filter-custom-row">
      <span class="filter-label">From:</span>
      <input type="date" class="filter-date" value="${customFrom}" onchange="window.__sp_setCustomDate('from', this.value)" max="${TODAY.toISOString().slice(0,10)}">
      <span class="filter-label">To:</span>
      <input type="date" class="filter-date" value="${customTo}" onchange="window.__sp_setCustomDate('to', this.value)" max="${TODAY.toISOString().slice(0,10)}">
    </div>`;
  }
  return `<div class="filter-row">
    <span class="filter-label">Period:</span>
    ${buttons}
  </div>${customRow}`;
}

// ============== MAIN RENDER ==============
function render(allDeals, filterId) {
  const pipelineFiltered = allDeals.filter(d => d.Pipeline === PIPELINE_FILTER);
  const filtered = applyPeriodFilter(pipelineFiltered, filterId);
  log("Filter:", filterId, "deals after filter:", filtered.length, "of", pipelineFiltered.length);

  const kpis = computeKPIs(filtered);
  const leaders = computeLeaderboard(filtered);
  const intake = computeLeadIntake(pipelineFiltered, leadIntakeGranularity);
  const trend = computeConversionTrend(pipelineFiltered);
  const blownIn = computeBlownInStats(filtered, blownInDealIds);
  const blownInLoading = blownInDealIds === null && !blownInLoadError;
  const ts = new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
  const activeFilterLabel = (FILTERS.find(f => f.id === filterId) || FILTERS[0]).label;

  const html = `
    <div class="header">
      <div>
        <h1>Sales Performance</h1>
        <div class="meta">Live from Zoho CRM · ${filtered.length} deals (${activeFilterLabel}) · refreshed ${ts}</div>
      </div>
      <button class="refresh-btn" onclick="window.__sp_refresh()">Refresh</button>
    </div>
    ${filterButtonsHtml(filterId)}
    <div class="scope-note">
      <strong>Scope:</strong> Pipeline = Regular · period filter on Created_Time · advisor stats exclude customer-service intake (Inspection Scheduled stage and Tomas Rodrigues as owner) · ghosted Quote Sent (21d+ idle) automatically reclassified as Closed Lost per Pipeline Rules.
    </div>
    ${kpiHtml(kpis, filtered)}
    ${conversionTrendHtml(trend, pipelineFiltered)}
    ${blownInHtml(blownIn, blownInLoading, filtered, blownInDealIds)}
    ${leaderboardHtml(leaders, filtered)}
    ${trophiesHtml(leaders, filtered)}
    ${leadIntakeHtml(intake, leadIntakeGranularity, pipelineFiltered)}
    ${leadSourceHtml(filtered)}
    ${funnelHtml(filtered)}
    ${lossReasonsHtml(filtered)}
  `;
  root.innerHTML = html;
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
    const rows = resp.data.filter(r => !TESTDEAL_IDS.has(r.id));
    all.push(...rows);
    const more = resp.info && resp.info.more_records;
    if (!more || resp.data.length < perPage) break;
    page++;
    if (page > 10) break;
  }
  log("Total fetched:", all.length);
  return all;
}

// ============== BLOWN-IN DETECTION ==============
// Embedded SDK's COQL endpoint doesn't support Quoted_Items module ("module not supported in api").
// Workaround: use getAllRecords on Quotes + Quoted_Items modules directly. Then JS-side join.
async function fetchAllRecordsSDK(entity, sortBy) {
  if (!window.ZOHO || !ZOHO.CRM || !ZOHO.CRM.API || !ZOHO.CRM.API.getAllRecords) {
    throw new Error("getAllRecords not available in SDK");
  }
  const all = [];
  let page = 1;
  while (true) {
    const params = { Entity: entity, page, per_page: 200 };
    if (sortBy) { params.sort_by = sortBy; params.sort_order = "desc"; }
    const resp = await ZOHO.CRM.API.getAllRecords(params);
    if (!resp || !resp.data) break;
    all.push(...resp.data);
    const more = resp.info && resp.info.more_records;
    if (!more || resp.data.length < 200) break;
    page++;
    if (page > 50) break; // safety: max 10000 records
  }
  return all;
}

async function fetchBlownInDealIds() {
  try {
    log("Fetching quotes...");
    const quotes = await fetchAllRecordsSDK("Quotes", "Created_Time");
    log("Fetched", quotes.length, "quotes");

    // Build map dealId → most recent quoteId
    const dealToLatestQuote = {};
    quotes.forEach(q => {
      if (!q.Deal_Name || !q.Deal_Name.id || !q.Created_Time) return;
      const dealId = q.Deal_Name.id;
      const existing = dealToLatestQuote[dealId];
      if (!existing || new Date(q.Created_Time) > new Date(existing.time)) {
        dealToLatestQuote[dealId] = { quoteId: q.id, time: q.Created_Time };
      }
    });
    log("Built deal→latestQuote map:", Object.keys(dealToLatestQuote).length, "deals");

    log("Fetching quoted items...");
    const items = await fetchAllRecordsSDK("Quoted_Items", "Created_Time");
    log("Fetched", items.length, "quoted items");

    // Filter quoted items to blown-in products and collect their Parent_Id (quote ids)
    const blownInIdSet = new Set(BLOWN_IN_PRODUCT_IDS.map(String));
    const blownInQuoteIds = new Set();
    items.forEach(it => {
      const productId = it.Product_Name && (it.Product_Name.id || it.Product_Name);
      if (productId && blownInIdSet.has(String(productId))) {
        const pid = it.Parent_Id && (it.Parent_Id.id || it.Parent_Id);
        if (pid) blownInQuoteIds.add(String(pid));
      }
    });
    log("Blown-in quote ids:", blownInQuoteIds.size);

    // Intersect: deals whose most recent quote is in the blown-in set
    const result = new Set();
    Object.entries(dealToLatestQuote).forEach(([dealId, info]) => {
      if (blownInQuoteIds.has(String(info.quoteId))) result.add(dealId);
    });
    log("Blown-in deals found:", result.size);
    return result;
  } catch (e) {
    log("Blown-in detection failed:", e);
    blownInLoadError = e && e.message ? e.message : String(e);
    return null;
  }
}

async function loadAndRender() {
  try {
    root.innerHTML = `<div class="loading-state"><div class="spinner"></div><div>Fetching deals from Zoho CRM&hellip;</div></div>`;
    cachedDeals = await fetchAllDeals();
    render(cachedDeals, currentFilter);
    // Fire blown-in detection in background; re-render when done
    blownInLoadError = null;
    fetchBlownInDealIds().then(set => {
      blownInDealIds = set;
      if (cachedDeals) render(cachedDeals, currentFilter);
    });
  } catch (e) {
    log("error", e);
    renderError("Unable to load deals.", e && e.message ? e.message : String(e));
  }
}

window.__sp_refresh = loadAndRender;
window.__sp_setFilter = function (filterId) {
  currentFilter = filterId;
  if (cachedDeals) {
    render(cachedDeals, currentFilter);
  } else {
    loadAndRender();
  }
};
window.__sp_setCustomDate = function (which, value) {
  if (which === "from") customFrom = value;
  if (which === "to") customTo = value;
  // Validate from <= to; if reversed, swap
  if (customFrom && customTo && customFrom > customTo) {
    const tmp = customFrom;
    customFrom = customTo;
    customTo = tmp;
  }
  if (cachedDeals) render(cachedDeals, currentFilter);
};

// Lead Intake handlers
window.__li_setGranularity = function (g) {
  leadIntakeGranularity = g;
  if (cachedDeals) render(cachedDeals, currentFilter);
};
window.__li_setCustomDate = function (which, value) {
  if (which === "from") leadIntakeCustomFrom = value;
  if (which === "to") leadIntakeCustomTo = value;
  if (leadIntakeCustomFrom && leadIntakeCustomTo && leadIntakeCustomFrom > leadIntakeCustomTo) {
    const tmp = leadIntakeCustomFrom;
    leadIntakeCustomFrom = leadIntakeCustomTo;
    leadIntakeCustomTo = tmp;
  }
  if (cachedDeals) render(cachedDeals, currentFilter);
};

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
