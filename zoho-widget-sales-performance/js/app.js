/* EnergyEase Sales Performance widget — runs inside Zoho CRM, fetches deals via Embedded App SDK */

const PIPELINE_FILTER = "Regular";
const TESTDEAL_IDS = new Set(["680374000007820138", "680374000005010079"]);
const STALE_QUOTE_DAYS = 21; // Pipeline Rules: ghosted Quote Sent → Closed Lost after 21 days

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

// Filter periods (apply to Created_Time)
const FILTERS = [
  { id: "all", label: "All time" },
  { id: "ytd", label: "YTD" },
  { id: "q", label: "This Quarter" },
  { id: "90d", label: "Last 90d" },
  { id: "30d", label: "Last 30d" },
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

// ============== KPIs ==============
function computeKPIs(deals) {
  const total = deals.length;
  const advisorDeals = deals.filter(isAdvisorAttributable);
  const wonDeals = advisorDeals.filter(d => WON_STAGES.has(d.Stage));
  const lostDeals = advisorDeals.filter(isEffectivelyLost);
  const decided = wonDeals.length + lostDeals.length;

  const realisedRevenue = wonDeals.reduce((s, d) => s + (Number(d.Amount) || 0), 0);
  const quoteToClose = decided > 0 ? (wonDeals.length / decided) * 100 : 0;

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
    realisedRevenue, quoteToClose, leadToQuote, avgCycle, inQuoteSent };
}

function kpiHtml(k) {
  return `<div class="kpi-row">
    <div class="kpi hero">
      <div class="kpi-label">Quote → Close conversion</div>
      <div class="kpi-value">${fmtPct(k.quoteToClose)}</div>
      <div class="kpi-sub">${k.wonCount} won / ${k.wonCount + k.lostCount} decided · Pipeline Rules applied (21d ghosted = lost)</div>
    </div>
    <div class="kpi win">
      <div class="kpi-label">Lead → Quote conversion</div>
      <div class="kpi-value">${fmtPct(k.leadToQuote)}</div>
      <div class="kpi-sub">${k.advisorTotal} advisor deals total</div>
    </div>
    <div class="kpi revenue">
      <div class="kpi-label">Realised revenue</div>
      <div class="kpi-value">${fmtEur(k.realisedRevenue)}</div>
      <div class="kpi-sub">total of won deals</div>
    </div>
    <div class="kpi warn">
      <div class="kpi-label">In Quote Sent</div>
      <div class="kpi-value">${k.inQuoteSent}</div>
      <div class="kpi-sub">awaiting decision</div>
    </div>
    <div class="kpi cycle">
      <div class="kpi-label">Avg sales cycle</div>
      <div class="kpi-value">${k.avgCycle !== null ? Math.round(k.avgCycle) + "d" : "—"}</div>
      <div class="kpi-sub">won deals only</div>
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

function leaderboardHtml(leaders) {
  let html = `<div class="section">
    <h2>🏆 Sales Advisor Leaderboard</h2>
    <div class="subtitle">Advisor-attributable deals · ranked by revenue × win rate · ghosted Quote Sent (21d+) reclassified as lost</div>
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
      html += `<div class="leader-row">
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
function trophiesHtml(leaders) {
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
    <div class="subtitle">Per-advisor records · min. 3 won deals to qualify for win-rate trophies</div>
    <div class="badge-grid">
      ${trophies.map(t => `<div class="badge">
        <div class="badge-icon">${t.icon}</div>
        <div class="badge-content">
          <div class="badge-title">${t.title}</div>
          <div class="badge-holder">${escapeHtml(t.holder)}</div>
          <div class="badge-detail">${t.detail}</div>
        </div>
      </div>`).join("")}
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
    <div class="subtitle">Which sources bring revenue · sorted by revenue</div>
    <div class="source-row header">
      <div>Source</div><div>Total</div><div>Won</div><div>Revenue</div><div>Win %</div>
    </div>`;
  rows.forEach(s => {
    html += `<div class="source-row">
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
    <div class="subtitle">Stage distribution with Pipeline Rules applied (ghosted Quote Sent reclassified as Closed Lost)</div>
    <div class="funnel-row header">
      <div>Stage</div><div>Deals</div><div>% of total</div><div></div>
    </div>`;
  stagesPresent.forEach(s => {
    const c = stageCounts[s];
    const pct = total > 0 ? (c / total * 100) : 0;
    const barPct = maxCount > 0 ? (c / maxCount * 100) : 0;
    const cls = WON_STAGES.has(s) ? "won" : (LOST_STAGES_RAW.has(s) || s === "Closed Not Qualified") ? "lost" : "active";
    html += `<div class="funnel-row">
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
    <div class="subtitle">Why deals are lost · ${lostDeals.length} Closed Lost deals analysed</div>
    <div class="loss-row header">
      <div>Reason</div><div>Count</div><div>Distribution</div><div>Type</div>
    </div>`;
  rows.forEach(([reason, count]) => {
    const bucket = LOSS_REASON_BUCKET[reason] || "other";
    const barPct = max > 0 ? (count / max * 100) : 0;
    html += `<div class="loss-row ${bucket}">
      <div>${escapeHtml(reason)}</div>
      <div style="text-align:right; font-weight:600;">${count}</div>
      <div class="loss-bar-container"><div class="loss-bar" style="width:${barPct}%"></div></div>
      <div style="font-size:10px; text-transform:uppercase; color:#94a3b8;">${bucket}</div>
    </div>`;
  });
  html += "</div>";
  return html;
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
    ${kpiHtml(kpis)}
    ${leaderboardHtml(leaders)}
    ${trophiesHtml(leaders)}
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

async function loadAndRender() {
  try {
    root.innerHTML = `<div class="loading-state"><div class="spinner"></div><div>Fetching deals from Zoho CRM&hellip;</div></div>`;
    cachedDeals = await fetchAllDeals();
    render(cachedDeals, currentFilter);
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
