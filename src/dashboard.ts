// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
export async function buildDashboardResponse(request) {
    const generatedAt = new Date().toISOString();
    const table = normalizeDaxResult(request.result);
    const analysisRows = selectMonthlyRows(table.rows);
    const analysis = analyzeRevenueMonthExtremes(request.question, analysisRows, table.columns);
    const insights = buildInsights(analysis);
    const summary = buildExecutiveSummary(request.question, table.rows, table.columns, analysis);
    const html = renderDashboardHtml({
        ...request,
        rows: table.rows,
        columns: table.columns,
        summary,
        insights,
        analysis,
        generatedAt
    });
    const dashboardPath = await writeDashboardFile(request.title || request.question, html);
    return {
        summary,
        insights,
        dashboardPath,
        dashboardUri: `file://${dashboardPath}`,
        html,
        rows: table.rows,
        columns: table.columns,
        generatedAt
    };
}
function normalizeDaxResult(result) {
    const candidates = collectRowCandidates(result);
    const rows = candidates
        .map(row => normalizeRow(row))
        .filter((row) => row !== undefined);
    const columns = unique(rows.flatMap(row => Object.keys(row)));
    return { rows, columns };
}
function collectRowCandidates(value) {
    if (Array.isArray(value))
        return value;
    if (!isRecord(value))
        return [];
    if (Array.isArray(value.data))
        return value.data;
    if (Array.isArray(value.rows))
        return mapRowsWithColumns(value.rows, value.columns);
    const firstTable = firstArrayTable(value.tables) || firstArrayTable(value.results);
    if (firstTable) {
        if (Array.isArray(firstTable.rows)) {
            return mapRowsWithColumns(firstTable.rows, firstTable.columns);
        }
        if (Array.isArray(firstTable.data))
            return firstTable.data;
    }
    if (isRecord(value.result))
        return collectRowCandidates(value.result);
    if (isRecord(value.data))
        return collectRowCandidates(value.data);
    return [value];
}
function firstArrayTable(value) {
    if (!Array.isArray(value))
        return undefined;
    for (const item of value) {
        if (!isRecord(item))
            continue;
        if (Array.isArray(item.rows) || Array.isArray(item.data))
            return item;
        const nested = firstArrayTable(item.tables);
        if (nested)
            return nested;
    }
    return undefined;
}
function mapRowsWithColumns(rows, columns) {
    if (!Array.isArray(columns))
        return rows;
    const names = columns.map((column, index) => {
        if (isRecord(column)) {
            return String(column.name ?? column.columnName ?? column.caption ?? `Column ${index + 1}`);
        }
        return String(column || `Column ${index + 1}`);
    });
    return rows.map(row => {
        if (!Array.isArray(row))
            return row;
        return Object.fromEntries(row.map((value, index) => [names[index] || `Column ${index + 1}`, value]));
    });
}
function normalizeRow(value) {
    if (!isRecord(value))
        return undefined;
    const row = {};
    for (const [key, item] of Object.entries(value)) {
        if (isPrimitive(item))
            row[cleanColumnName(key)] = item;
    }
    return Object.keys(row).length ? row : undefined;
}
function buildExecutiveSummary(question, rows, columns, analysis) {
    if (rows.length === 0) {
        return `No rows were returned for: ${question}`;
    }
    if (analysis) {
        if (analysis.language === "vi") {
            const driverText = [
                ...analysis.highest.reasons.slice(0, 1),
                ...analysis.lowest.reasons.slice(0, 1)
            ].join(" ");
            return `Tháng có ${analysis.metric} cao nhất là ${analysis.highest.label} (${formatNumber(analysis.highest.value)}); thấp nhất là ${analysis.lowest.label} (${formatNumber(analysis.lowest.value)}), chênh lệch ${formatNumber(analysis.spread)}. ${driverText}`;
        }
        const driverText = [
            ...analysis.highest.reasons.slice(0, 1),
            ...analysis.lowest.reasons.slice(0, 1)
        ].join(" ");
        return `Highest ${analysis.metric} is ${analysis.highest.label} (${formatNumber(analysis.highest.value)}); lowest is ${analysis.lowest.label} (${formatNumber(analysis.lowest.value)}), a spread of ${formatNumber(analysis.spread)}. ${driverText}`;
    }
    const numericColumns = columns.filter(column => rows.some(row => typeof row[column] === "number"));
    const primaryMetric = numericColumns[0];
    const primaryDimension = columns.find(column => column !== primaryMetric && rows.some(row => typeof row[column] === "string"));
    if (!primaryMetric) {
        return `Returned ${rows.length} row${rows.length === 1 ? "" : "s"} for: ${question}`;
    }
    const total = rows.reduce((sum, row) => sum + numericValue(row[primaryMetric]), 0);
    const leader = primaryDimension
        ? [...rows].sort((a, b) => numericValue(b[primaryMetric]) - numericValue(a[primaryMetric]))[0]
        : undefined;
    const leaderText = leader && primaryDimension
        ? ` Highest ${primaryMetric} is ${String(leader[primaryDimension])} at ${formatNumber(numericValue(leader[primaryMetric]))}.`
        : "";
    return `${primaryMetric} totals ${formatNumber(total)} across ${rows.length} row${rows.length === 1 ? "" : "s"}.${leaderText}`;
}
function renderDashboardHtml(input) {
    const title = input.title || "Executive Power BI Dashboard";
    const kpis = buildKpis(input.rows, input.columns, input.analysis);
    const executive = input.analysis ? buildExecutiveDecisionModel(input.rows, input.columns, input.analysis) : undefined;
    const dimension = input.columns.find(column => input.rows.some(row => typeof row[column] === "string"));
    const metric = input.columns.find(column => input.rows.some(row => typeof row[column] === "number"));
    const bars = dimension && metric ? buildBars(input.rows, dimension, metric) : [];
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1b1f23;
      --muted: #667085;
      --line: #d7dde5;
      --panel: #ffffff;
      --canvas: #f4f7fa;
      --green: #08875d;
      --blue: #1769aa;
      --amber: #b75f00;
      --red: #c5352b;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--canvas);
      color: var(--ink);
    }
    main { max-width: 1280px; margin: 0 auto; padding: 28px; }
    header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 20px;
      align-items: start;
      border-bottom: 1px solid var(--line);
      padding-bottom: 18px;
      margin-bottom: 18px;
    }
    h1 { margin: 0 0 8px; font-size: 30px; line-height: 1.15; font-weight: 760; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 17px; line-height: 1.25; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.5; }
    .meta { text-align: right; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 18px; }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    .card { min-height: 118px; padding: 16px; display: grid; align-content: space-between; }
    .label { color: var(--muted); font-size: 12px; line-height: 1.25; text-transform: uppercase; font-weight: 700; }
    .value { font-size: 27px; line-height: 1.15; font-weight: 760; overflow-wrap: anywhere; }
    .tone-green { border-top: 4px solid var(--green); }
    .tone-blue { border-top: 4px solid var(--blue); }
    .tone-amber { border-top: 4px solid var(--amber); }
    .tone-red { border-top: 4px solid var(--red); }
    .content { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr); gap: 18px; align-items: start; }
    .panel { padding: 18px; overflow: hidden; }
    .bars { display: grid; gap: 11px; }
    .bar-row { display: grid; grid-template-columns: minmax(120px, 190px) minmax(0, 1fr) minmax(86px, auto); gap: 12px; align-items: center; }
    .bar-label { font-size: 13px; color: #344054; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .track { height: 12px; border-radius: 999px; background: #e8eef5; overflow: hidden; }
    .fill { height: 100%; border-radius: inherit; background: linear-gradient(90deg, var(--blue), var(--green)); }
    .bar-value { font-size: 13px; font-weight: 700; text-align: right; }
    .insights { display: grid; gap: 10px; margin-bottom: 18px; }
    .insight { background: var(--panel); border-left: 4px solid var(--blue); padding: 14px 16px; border-radius: 8px; border-top: 1px solid var(--line); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); }
    .insight strong { display: block; margin-bottom: 5px; }
    .exec-grid { display: grid; grid-template-columns: minmax(0, 1.08fr) minmax(360px, 0.92fr); gap: 18px; align-items: start; margin-bottom: 18px; }
    .exec-stack { display: grid; gap: 18px; }
    .readout { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
    .readout-item { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; min-height: 110px; }
    .readout-item span, .mini-card span { display: block; color: var(--muted); font-size: 11px; line-height: 1.25; text-transform: uppercase; font-weight: 760; margin-bottom: 6px; }
    .readout-item strong { display: block; font-size: 15px; line-height: 1.3; margin-bottom: 5px; }
    .readout-item p, .mini-card p { font-size: 12px; line-height: 1.4; }
    .driver-tree { display: grid; gap: 8px; }
    .tree-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--line); font-size: 13px; }
    .tree-row:last-child { border-bottom: 0; }
    .tree-row span { color: var(--muted); }
    .tree-row strong { text-align: right; }
    .waterfall { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; align-items: end; min-height: 210px; }
    .wf-step { display: grid; grid-template-rows: auto 1fr auto; gap: 8px; text-align: center; color: var(--muted); font-size: 12px; min-height: 190px; }
    .wf-step i { align-self: end; display: block; min-height: 12px; border-radius: 6px 6px 0 0; background: var(--blue); }
    .wf-step.good i { background: var(--green); }
    .wf-step.warn i { background: var(--amber); }
    .wf-step.bad i { background: var(--red); }
    .wf-step b { color: var(--ink); font-size: 13px; line-height: 1.25; }
    .monthly-bars { display: grid; gap: 9px; }
    .mini-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .mini-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; }
    .mini-card strong { display: block; font-size: 20px; margin-bottom: 4px; overflow-wrap: anywhere; }
    .dimension-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .decision-table { width: 100%; min-width: 760px; }
    .analysis-stack { display: grid; gap: 18px; margin-bottom: 18px; }
    .analysis-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
    .analysis-note { margin-bottom: 12px; font-size: 13px; color: var(--muted); }
    .visual-grid { display: grid; gap: 10px; }
    .visual-row { display: grid; grid-template-columns: minmax(150px, 1fr) minmax(0, 1.4fr) minmax(82px, auto); gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .visual-row:last-child { border-bottom: 0; }
    .visual-name { min-width: 0; font-weight: 700; font-size: 13px; overflow-wrap: anywhere; }
    .visual-sub { display: block; color: var(--muted); font-size: 11px; font-weight: 500; margin-top: 2px; }
    .visual-metric { text-align: right; font-weight: 760; font-size: 13px; }
    .heat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .heat-cell { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fbfcfd; border-left: 5px solid var(--blue); min-height: 104px; }
    .heat-cell.risk { border-left-color: var(--red); }
    .heat-cell.scale { border-left-color: var(--green); }
    .heat-cell.warn { border-left-color: var(--amber); }
    .heat-cell b { display: block; font-size: 14px; margin-bottom: 5px; overflow-wrap: anywhere; }
    .heat-cell span { display: block; color: var(--muted); font-size: 12px; line-height: 1.35; }
    .alert-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .alert-card { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #fff; border-top: 4px solid var(--amber); min-height: 110px; }
    .alert-card.high { border-top-color: var(--red); }
    .alert-card.ok { border-top-color: var(--green); }
    .alert-card b { display: block; margin-bottom: 5px; }
    .alert-card p { font-size: 12px; line-height: 1.4; }
    .appendix { opacity: 0.92; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; min-width: 620px; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eef3f8; color: #344054; font-size: 12px; text-transform: uppercase; position: sticky; top: 0; }
    td.number { text-align: right; font-variant-numeric: tabular-nums; }
    tr:last-child td { border-bottom: 0; }
    .query { margin-top: 14px; padding: 12px; border-radius: 8px; background: #101828; color: #f2f4f7; overflow: auto; font-size: 12px; line-height: 1.45; }
    @media (max-width: 900px) {
      main { padding: 18px; }
      header, .content, .exec-grid, .analysis-grid { grid-template-columns: 1fr; }
      .meta { text-align: left; }
      .grid, .readout, .mini-cards, .dimension-grid, .heat-grid, .alert-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .grid, .readout, .mini-cards, .dimension-grid, .heat-grid, .alert-grid, .waterfall { grid-template-columns: 1fr; }
      .bar-row { grid-template-columns: 1fr; gap: 6px; }
      .visual-row { grid-template-columns: 1fr; }
      .visual-metric { text-align: left; }
      h1 { font-size: 24px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <section>
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(input.summary)}</p>
      </section>
      <aside class="meta">
        <div>${escapeHtml(input.workspaceName)}</div>
        <div>${escapeHtml(input.semanticModelName)}</div>
        <div>${escapeHtml(new Date(input.generatedAt).toLocaleString("en-US"))}</div>
      </aside>
    </header>

    <section class="grid">
      ${kpis.map(kpi => `<article class="card tone-${kpi.tone}"><div class="label">${escapeHtml(kpi.label)}</div><div class="value">${escapeHtml(kpi.value)}</div></article>`).join("\n      ")}
    </section>

    ${input.insights.length ? `<section class="insights">${input.insights.map(insight => `<article class="insight"><strong>${escapeHtml(insight.title)}</strong><p>${escapeHtml(insight.detail)}</p></article>`).join("")}</section>` : ""}

    ${executive ? renderExecutiveDecisionSection(input, executive) : ""}

    ${executive ? renderAnalysisTables(input.rows, input.analysis) : ""}

    <section class="content">
      <article class="panel">
        <h2>${escapeHtml(executive ? "Evidence: monthly revenue profile" : (metric && dimension ? `${metric} by ${dimension}` : "Result Overview"))}</h2>
        ${executive ? renderMonthlyBars(input.rows, input.analysis.dimension, input.analysis.metric) : (bars.length ? `<div class="bars">${bars.map(bar => `<div class="bar-row"><div class="bar-label" title="${escapeHtml(bar.label)}">${escapeHtml(bar.label)}</div><div class="track"><div class="fill" style="width:${bar.width}%"></div></div><div class="bar-value">${escapeHtml(bar.value)}</div></div>`).join("")}</div>` : `<p>No numeric series was available for a chart.</p>`)}
      </article>
    </section>

    <section class="panel" style="margin-top:18px">
      <h2>Question</h2>
      <p>${escapeHtml(input.question)}</p>
      <pre class="query">${escapeHtml(input.query)}</pre>
    </section>
  </main>
</body>
</html>`;
}
function renderExecutiveDecisionSection(input, executive) {
    const analysis = input.analysis;
    if (!analysis)
        return "";
    const highLabel = analysis.highest.label;
    const lowLabel = analysis.lowest.label;
    const highestText = `${highLabel}: ${formatMetricValue(analysis.metric, analysis.highest.value)}`;
    const lowestText = `${lowLabel}: ${formatMetricValue(analysis.metric, analysis.lowest.value)}`;
    return `<section class="exec-grid">
      <article class="panel">
        <h2>Executive answer</h2>
        <div class="readout">
          <div class="readout-item"><span>What happened</span><strong>${escapeHtml(highestText)} vs ${escapeHtml(lowestText)}</strong><p>Spread is ${escapeHtml(formatMetricValue(analysis.metric, analysis.spread))} across ${escapeHtml(formatNumber(input.rows.length))} monthly observations.</p></div>
          <div class="readout-item"><span>Why it happened</span><strong>Volume is the primary driver</strong><p>${escapeHtml(volumeNarrative(executive))}</p></div>
          <div class="readout-item"><span>So what</span><strong>Revenue quality depends on repeatable demand</strong><p>${escapeHtml(executive.trendText)}</p></div>
          <div class="readout-item"><span>Decision</span><strong>Replicate peak-month motion, fix trough-month capacity</strong><p>Prioritize the levers with data-backed impact before changing price or discount policy.</p></div>
        </div>
      </article>

      <article class="panel">
        <h2>Driver tree</h2>
        <div class="driver-tree">
          <div class="tree-row"><span>Revenue</span><strong>${escapeHtml(formatMetricValue(analysis.metric, executive.totalRevenue))}</strong></div>
          <div class="tree-row"><span>Average monthly revenue</span><strong>${escapeHtml(formatMetricValue(analysis.metric, executive.averageRevenue))}</strong></div>
          <div class="tree-row"><span>High month units</span><strong>${escapeHtml(executive.highUnits !== undefined ? formatNumber(executive.highUnits) : "Not returned")}</strong></div>
          <div class="tree-row"><span>Low month units</span><strong>${escapeHtml(executive.lowUnits !== undefined ? formatNumber(executive.lowUnits) : "Not returned")}</strong></div>
          <div class="tree-row"><span>Implied ASP high month</span><strong>${escapeHtml(executive.highAsp !== undefined ? formatNumber(executive.highAsp) : "Not returned")}</strong></div>
          <div class="tree-row"><span>Implied ASP low month</span><strong>${escapeHtml(executive.lowAsp !== undefined ? formatNumber(executive.lowAsp) : "Not returned")}</strong></div>
        </div>
      </article>

      <article class="panel">
        <h2>Revenue bridge: low month to high month</h2>
        ${renderWaterfall(executive, analysis)}
      </article>

      <article class="panel">
        <h2>Decision levers</h2>
        <div class="mini-cards">
          ${executive.leverCards.map(card => `<div class="mini-card tone-${card.tone}"><span>${escapeHtml(card.label)}</span><strong>${escapeHtml(card.value)}</strong><p>${escapeHtml(card.detail)}</p></div>`).join("")}
        </div>
      </article>

      ${executive.dimensionInsights.length ? `<article class="panel">
        <h2>Cross-dimension insight scan</h2>
        <div class="dimension-grid">
          ${executive.dimensionInsights.map(insight => `<div class="mini-card"><span>${escapeHtml(insight.dimension)}</span><strong>${escapeHtml(insight.topLabel)}: ${escapeHtml(formatMetricValue(analysis.metric, insight.topValue))}</strong><p>${escapeHtml(insight.read)}</p></div>`).join("")}
        </div>
      </article>` : ""}

      <article class="panel">
        <h2>Executive decision board</h2>
        <div class="table-wrap"><table class="decision-table"><thead><tr><th>CEO question</th><th>Evidence from query</th><th>Management read</th><th>Still missing</th></tr></thead><tbody>${executive.decisionRows.map(row => `<tr><td>${escapeHtml(row.question)}</td><td>${escapeHtml(row.evidence)}</td><td>${escapeHtml(row.decision)}</td><td>${escapeHtml(row.missing)}</td></tr>`).join("")}</tbody></table></div>
      </article>

      <article class="panel">
        <h2>Predictive read</h2>
        <div class="driver-tree">
          <div class="tree-row"><span>Last 3-month annualized run-rate</span><strong>${escapeHtml(executive.lastThreeRunRate !== undefined ? formatMetricValue(analysis.metric, executive.lastThreeRunRate) : "Not enough rows")}</strong></div>
          <div class="tree-row"><span>Current-period total in returned data</span><strong>${escapeHtml(formatMetricValue(analysis.metric, executive.totalRevenue))}</strong></div>
          <div class="tree-row"><span>Confidence note</span><strong>Directional only</strong></div>
        </div>
        <p style="margin-top:10px">Forecast confidence improves when the DAX returns plan, market growth, dealer pipeline, inventory, campaign calendar, and conversion data.</p>
      </article>
    </section>`;
}
function renderWaterfall(executive, analysis) {
    const unitEffect = executive.unitEffect ?? 0;
    const aspMixEffect = executive.aspMixEffect ?? 0;
    const max = Math.max(Math.abs(analysis.lowest.value), Math.abs(unitEffect), Math.abs(aspMixEffect), Math.abs(analysis.highest.value), 1);
    const step = (label, value, tone) => `<div class="wf-step ${tone}"><span>${escapeHtml(label)}</span><i style="height:${Math.max(6, Math.round(Math.abs(value) / max * 100))}%"></i><b>${escapeHtml(formatMetricValue(analysis.metric, value))}</b></div>`;
    return `<div class="waterfall">
    ${step(`Low month ${analysis.lowest.label}`, analysis.lowest.value, "bad")}
    ${step("Unit effect", unitEffect, unitEffect >= 0 ? "good" : "bad")}
    ${step("ASP / mix effect", aspMixEffect, aspMixEffect >= 0 ? "warn" : "bad")}
    ${step(`High month ${analysis.highest.label}`, analysis.highest.value, "good")}
  </div>`;
}
function renderMonthlyBars(rows, dimension, metric) {
    const sorted = [...selectMonthlyRows(rows)].sort((a, b) => compareDimension(a[dimension], b[dimension]));
    const max = Math.max(...sorted.map(row => Math.abs(numericValue(row[metric]))), 1);
    return `<div class="monthly-bars">${sorted.map(row => {
        const value = numericValue(row[metric]);
        return `<div class="bar-row"><div class="bar-label" title="${escapeHtml(String(row[dimension] ?? ""))}">Month ${escapeHtml(String(row[dimension] ?? ""))}</div><div class="track"><div class="fill" style="width:${Math.max(3, Math.round(Math.abs(value) / max * 100))}%"></div></div><div class="bar-value">${escapeHtml(formatMetricValue(metric, value))}</div></div>`;
    }).join("")}</div>`;
}
function renderAnalysisTables(rows, analysis) {
    const tables = buildAnalysisTables(rows, analysis);
    if (tables.length === 0)
        return "";
    return `<section class="analysis-stack">
    <article class="panel">
      <h2>Business insight dashboard</h2>
      <p class="analysis-note">The main report uses visual analysis blocks. Returned rows remain available in MCP structuredContent for auditability but are not rendered as a raw table.</p>
    </article>
    <section class="analysis-grid">
      ${tables.map(table => `<article class="panel"><h2>${escapeHtml(table.title)}</h2><p class="analysis-note">${escapeHtml(table.subtitle)}</p>${renderAnalysisVisual(table)}</article>`).join("")}
    </section>
  </section>`;
}
function buildAnalysisTables(rows, analysis) {
    return [
        buildMonthlyPerformanceTable(rows, analysis),
        ...buildContributionTables(rows, analysis),
        ...buildCrossContributionTables(rows, analysis),
        buildRiskWatchTable(rows, analysis)
    ].filter((table) => table !== undefined);
}
function buildMonthlyPerformanceTable(rows, analysis) {
    const monthlyRows = selectMonthlyRows(rows);
    if (!monthlyRows.length)
        return undefined;
    const unitsColumn = findColumnByTokens(Object.keys(monthlyRows[0] ?? {}), ["unit", "quantity", "sold"]);
    const aspColumn = findColumnByTokens(Object.keys(monthlyRows[0] ?? {}), ["asp", "weightedasp"]);
    const averageRevenue = average(monthlyRows.map(row => numericValue(row[analysis.metric])));
    const sorted = [...monthlyRows]
        .sort((a, b) => numericValue(b[analysis.metric]) - numericValue(a[analysis.metric]))
        .slice(0, 6);
    return {
        title: "Monthly performance ranking",
        subtitle: "Not raw data: this ranks the months and shows whether the gap is volume-led or price/mix-led.",
        columns: ["Month", "Revenue", "Units", "ASP", "Vs Avg", "CEO read"],
        rows: sorted.map(row => {
            const revenue = numericValue(row[analysis.metric]);
            const units = unitsColumn ? numericValue(row[unitsColumn]) : 0;
            const asp = aspColumn ? numericValue(row[aspColumn]) : impliedAsp(revenue, units);
            return {
                Month: String(row[analysis.dimension] ?? ""),
                Revenue: formatMetricValue(analysis.metric, revenue),
                Units: unitsColumn ? formatNumber(units) : "n/a",
                ASP: asp !== undefined ? `${formatNumber(asp)} triệu VND` : "n/a",
                "Vs Avg": formatMetricValue(analysis.metric, revenue - averageRevenue),
                "CEO read": revenue >= averageRevenue ? "Scale playbook" : "Recovery watch"
            };
        })
    };
}
function buildContributionTables(rows, analysis) {
    if (!(Object.keys(rows[0] ?? {}).includes("Dimension") && Object.keys(rows[0] ?? {}).includes("Member"))) {
        return [];
    }
    const monthlyTotal = selectMonthlyRows(rows).reduce((sum, row) => sum + numericValue(row[analysis.metric]), 0);
    const dimensions = unique(rows
        .filter(row => String(row.Scope ?? "") === "Dimension")
        .map(row => String(row.Dimension ?? ""))
        .filter(Boolean));
    return dimensions.map(dimension => {
        const grouped = rows
            .filter(row => String(row.Scope ?? "") === "Dimension" && String(row.Dimension ?? "") === dimension)
            .sort((a, b) => numericValue(b[analysis.metric]) - numericValue(a[analysis.metric]))
            .slice(0, 8);
        return {
            title: `${dimension} contribution`,
            subtitle: `Contribution ranking by ${dimension}; this answers where revenue is concentrated before drilling into root cause.`,
            columns: [dimension, "Revenue", "Share", "Units", "Margin", "Business read"],
            rows: grouped.map(row => {
                const revenue = numericValue(row[analysis.metric]);
                const margin = findColumnByTokens(Object.keys(row), ["margin"]);
                const units = findColumnByTokens(Object.keys(row), ["unit", "quantity", "sold"]);
                return {
                    [dimension]: String(row.Member ?? ""),
                    Revenue: formatMetricValue(analysis.metric, revenue),
                    Share: monthlyTotal ? formatPercent(revenue / monthlyTotal) : "n/a",
                    Units: units ? formatNumber(numericValue(row[units])) : "n/a",
                    Margin: margin ? formatMetricValue(margin, numericValue(row[margin])) : "n/a",
                    "Business read": contributionRead(revenue, monthlyTotal)
                };
            })
        };
    });
}
function buildCrossContributionTables(rows, analysis) {
    if (!(Object.keys(rows[0] ?? {}).includes("Dimension") && Object.keys(rows[0] ?? {}).includes("Member"))) {
        return [];
    }
    const monthlyTotal = selectMonthlyRows(rows).reduce((sum, row) => sum + numericValue(row[analysis.metric]), 0);
    const crossDimensions = unique(rows
        .filter(row => String(row.Scope ?? "") === "Cross")
        .map(row => String(row.Dimension ?? ""))
        .filter(Boolean));
    return crossDimensions.map(dimension => {
        const grouped = rows
            .filter(row => String(row.Scope ?? "") === "Cross" && String(row.Dimension ?? "") === dimension)
            .sort((a, b) => numericValue(b[analysis.metric]) - numericValue(a[analysis.metric]))
            .slice(0, 10);
        return {
            title: `${dimension} pockets`,
            subtitle: "Cross-dimension pockets are where CEO insight usually lives: not just which region or model, but which combination.",
            columns: ["Pocket", "Revenue", "Share", "Units", "Margin", "Action cue"],
            rows: grouped.map(row => {
                const revenue = numericValue(row[analysis.metric]);
                const margin = findColumnByTokens(Object.keys(row), ["margin"]);
                const units = findColumnByTokens(Object.keys(row), ["unit", "quantity", "sold"]);
                return {
                    Pocket: String(row.Member ?? ""),
                    Revenue: formatMetricValue(analysis.metric, revenue),
                    Share: monthlyTotal ? formatPercent(revenue / monthlyTotal) : "n/a",
                    Units: units ? formatNumber(numericValue(row[units])) : "n/a",
                    Margin: margin ? formatMetricValue(margin, numericValue(row[margin])) : "n/a",
                    "Action cue": crossActionCue(row, analysis.metric)
                };
            })
        };
    });
}
function buildRiskWatchTable(rows, analysis) {
    const candidateRows = rows.filter(row => String(row.Scope ?? "") !== "Monthly");
    if (!candidateRows.length)
        return undefined;
    const inventoryColumn = findColumnByTokens(Object.keys(candidateRows[0] ?? {}), ["inventory"]);
    const marketShareColumn = findColumnByTokens(Object.keys(candidateRows[0] ?? {}), ["marketshare"]);
    const discountColumn = findColumnByTokens(Object.keys(candidateRows[0] ?? {}), ["discount"]);
    const marketingColumn = findColumnByTokens(Object.keys(candidateRows[0] ?? {}), ["marketing"]);
    const scored = candidateRows
        .map(row => {
        const inventory = inventoryColumn ? numericValue(row[inventoryColumn]) : 0;
        const discount = discountColumn ? numericValue(row[discountColumn]) : 0;
        const marketing = marketingColumn ? numericValue(row[marketingColumn]) : 0;
        const marketShare = marketShareColumn ? numericValue(row[marketShareColumn]) : 0;
        const score = inventory + discount / 10 + marketing / 10 - marketShare;
        return { row, score };
    })
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    if (!scored.length)
        return undefined;
    return {
        title: "Risk and anomaly watch",
        subtitle: "A first-pass watchlist based on returned operational drivers; use it to decide which slice deserves the next query.",
        columns: ["Slice", "Revenue", "Inventory", "Discount", "Marketing", "Risk read"],
        rows: scored.map(({ row }) => ({
            Slice: [row.Dimension, row.Member].filter(Boolean).join(": "),
            Revenue: formatMetricValue(analysis.metric, numericValue(row[analysis.metric])),
            Inventory: inventoryColumn ? formatNumber(numericValue(row[inventoryColumn])) : "n/a",
            Discount: discountColumn ? formatMetricValue(analysis.metric, numericValue(row[discountColumn])) : "n/a",
            Marketing: marketingColumn ? formatMetricValue(analysis.metric, numericValue(row[marketingColumn])) : "n/a",
            "Risk read": riskRead(row, inventoryColumn, discountColumn, marketingColumn, marketShareColumn)
        }))
    };
}
function renderStringTable(columns, rows) {
    if (!rows.length)
        return "<p>No analysis rows available.</p>";
    return `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${columns.map(column => `<td>${escapeHtml(row[column] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function renderAnalysisVisual(table) {
    if (table.title.includes("Monthly performance"))
        return renderMonthlyPerformanceVisual(table);
    if (table.title.includes("pockets"))
        return renderPocketVisual(table);
    if (table.title.includes("Risk"))
        return renderRiskVisual(table);
    if (table.title.includes("contribution"))
        return renderContributionVisual(table);
    return renderStringTable(table.columns, table.rows);
}
function renderMonthlyPerformanceVisual(table) {
    const max = maxFromRows(table.rows, "Revenue");
    return `<div class="visual-grid">${table.rows.map(row => {
        const value = parseFormattedNumber(row.Revenue);
        const width = max ? Math.max(4, Math.round(value / max * 100)) : 4;
        return `<div class="visual-row"><div class="visual-name">Month ${escapeHtml(row.Month)}<span class="visual-sub">${escapeHtml(row["CEO read"])} · ${escapeHtml(row["Vs Avg"])}</span></div><div class="track"><div class="fill" style="width:${width}%"></div></div><div class="visual-metric">${escapeHtml(row.Revenue)}<span class="visual-sub">${escapeHtml(row.Units)} units · ASP ${escapeHtml(row.ASP)}</span></div></div>`;
    }).join("")}</div>`;
}
function renderContributionVisual(table) {
    const dimension = table.columns[0];
    const max = maxFromRows(table.rows, "Revenue");
    return `<div class="visual-grid">${table.rows.slice(0, 8).map(row => {
        const value = parseFormattedNumber(row.Revenue);
        const width = max ? Math.max(4, Math.round(value / max * 100)) : 4;
        return `<div class="visual-row"><div class="visual-name">${escapeHtml(row[dimension])}<span class="visual-sub">${escapeHtml(row["Business read"])} · Margin ${escapeHtml(row.Margin)}</span></div><div class="track"><div class="fill" style="width:${width}%"></div></div><div class="visual-metric">${escapeHtml(row.Share)}<span class="visual-sub">${escapeHtml(row.Revenue)} · ${escapeHtml(row.Units)} units</span></div></div>`;
    }).join("")}</div>`;
}
function renderPocketVisual(table) {
    return `<div class="heat-grid">${table.rows.slice(0, 8).map(row => {
        const cue = row["Action cue"] ?? "";
        const tone = cue.includes("Fix") ? "risk" : cue.includes("Audit") ? "warn" : "scale";
        return `<div class="heat-cell ${tone}"><b>${escapeHtml(row.Pocket)}</b><span>${escapeHtml(row.Revenue)} · ${escapeHtml(row.Share)} share · ${escapeHtml(row.Units)} units</span><span>Margin ${escapeHtml(row.Margin)} · ${escapeHtml(cue)}</span></div>`;
    }).join("")}</div>`;
}
function renderRiskVisual(table) {
    return `<div class="alert-grid">${table.rows.slice(0, 8).map(row => {
        const read = row["Risk read"] ?? "";
        const tone = read.includes("heavy") || read.includes("weak") ? "high" : read.includes("monitor") ? "" : "ok";
        return `<div class="alert-card ${tone}"><b>${escapeHtml(row.Slice)}</b><p>${escapeHtml(read)}</p><p>${escapeHtml(row.Revenue)} · Inventory ${escapeHtml(row.Inventory)} · Discount ${escapeHtml(row.Discount)}</p></div>`;
    }).join("")}</div>`;
}
function maxFromRows(rows, column) {
    return Math.max(...rows.map(row => parseFormattedNumber(row[column])), 0);
}
function parseFormattedNumber(value) {
    if (!value)
        return 0;
    const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
}
function contributionRead(value, total) {
    const share = total ? value / total : 0;
    if (share >= 0.25)
        return "Strategic concentration";
    if (share >= 0.1)
        return "Scale contributor";
    return "Long-tail contributor";
}
function crossActionCue(row, metric) {
    const marginColumn = findColumnByTokens(Object.keys(row), ["margin"]);
    const discountColumn = findColumnByTokens(Object.keys(row), ["discount"]);
    const margin = marginColumn ? numericValue(row[marginColumn]) : undefined;
    const discount = discountColumn ? numericValue(row[discountColumn]) : undefined;
    if (margin !== undefined && margin < 0.16)
        return "Fix margin before scaling";
    if (discount !== undefined && discount > numericValue(row[metric]) * 0.05)
        return "Audit discount leakage";
    return "Candidate for scale or replication";
}
function riskRead(row, inventoryColumn, discountColumn, marketingColumn, marketShareColumn) {
    const parts = [];
    if (inventoryColumn && numericValue(row[inventoryColumn]) > 42)
        parts.push("inventory high");
    if (discountColumn && numericValue(row[discountColumn]) > numericValue(row.Revenue_BillionVND) * 0.04)
        parts.push("discount heavy");
    if (marketingColumn && numericValue(row[marketingColumn]) > numericValue(row.Revenue_BillionVND) * 0.025)
        parts.push("marketing intensity high");
    if (marketShareColumn && numericValue(row[marketShareColumn]) < 10)
        parts.push("share weak");
    return parts.length ? parts.join("; ") : "monitor for next drill-down";
}
function buildExecutiveDecisionModel(rows, columns, analysis) {
    const monthlyRows = selectMonthlyRows(rows);
    const unitsColumn = findColumnByTokens(columns, ["unit", "quantity", "vehicle", "sold"]);
    const aspColumn = findColumnByTokens(columns, ["asp", "averagesellingprice", "weightedasp"]);
    const discountColumn = findColumnByTokens(columns, ["discount"]);
    const marketingColumn = findColumnByTokens(columns, ["marketing", "promotion"]);
    const marginColumn = findColumnByTokens(columns, ["margin"]);
    const inventoryColumn = findColumnByTokens(columns, ["inventory"]);
    const marketShareColumn = findColumnByTokens(columns, ["marketshare"]);
    const highRow = aggregateRows(monthlyRows.filter(row => String(row[analysis.dimension] ?? "").trim() === analysis.highest.label), columns);
    const lowRow = aggregateRows(monthlyRows.filter(row => String(row[analysis.dimension] ?? "").trim() === analysis.lowest.label), columns);
    const totalRevenue = monthlyRows.reduce((sum, row) => sum + numericValue(row[analysis.metric]), 0);
    const averageRevenue = totalRevenue / Math.max(monthlyRows.length, 1);
    const highUnits = unitsColumn ? numericValue(highRow[unitsColumn]) : undefined;
    const lowUnits = unitsColumn ? numericValue(lowRow[unitsColumn]) : undefined;
    const highAsp = impliedAsp(analysis.highest.value, highUnits, aspColumn ? numericValue(highRow[aspColumn]) : undefined);
    const lowAsp = impliedAsp(analysis.lowest.value, lowUnits, aspColumn ? numericValue(lowRow[aspColumn]) : undefined);
    const unitEffect = highUnits !== undefined && lowUnits !== undefined && lowAsp !== undefined
        ? ((highUnits - lowUnits) * lowAsp) / 1000
        : undefined;
    const aspMixEffect = highUnits !== undefined && highAsp !== undefined && lowAsp !== undefined
        ? (highUnits * (highAsp - lowAsp)) / 1000
        : undefined;
    const sorted = [...monthlyRows].sort((a, b) => compareDimension(a[analysis.dimension], b[analysis.dimension]));
    const lastThree = sorted.slice(-3);
    const firstThree = sorted.slice(0, 3);
    const lastThreeAverage = average(lastThree.map(row => numericValue(row[analysis.metric])));
    const firstThreeAverage = average(firstThree.map(row => numericValue(row[analysis.metric])));
    const lastThreeRunRate = lastThree.length >= 3 ? lastThreeAverage * 12 : undefined;
    const trendDelta = lastThreeAverage - firstThreeAverage;
    const trendText = trendDelta >= 0
        ? `Last 3-month average is ${formatMetricValue(analysis.metric, Math.abs(trendDelta))} above the first 3-month average.`
        : `Last 3-month average is ${formatMetricValue(analysis.metric, Math.abs(trendDelta))} below the first 3-month average.`;
    const leverCards = [
        {
            label: "Volume sensitivity",
            value: formatMetricValue(analysis.metric, totalRevenue * 0.05),
            detail: "Approximate revenue lift from +5% units at current revenue-per-unit economics.",
            tone: "green"
        },
        {
            label: "Price / mix sensitivity",
            value: formatMetricValue(analysis.metric, totalRevenue * 0.01),
            detail: "Approximate revenue lift from +1% ASP/mix with units unchanged.",
            tone: "blue"
        },
        {
            label: "Discount pool",
            value: discountColumn ? formatMetricValue(analysis.metric, sumRows(rows, discountColumn)) : "Not returned",
            detail: "Use as a margin-leakage control, not as a revenue target by itself.",
            tone: "amber"
        },
        {
            label: "Marketing spend",
            value: marketingColumn ? formatMetricValue(analysis.metric, sumRows(rows, marketingColumn)) : "Not returned",
            detail: "Decision quality improves when linked to conversion, traffic, or campaign ROI.",
            tone: "red"
        }
    ];
    const decisionRows = [
        {
            question: "Why is the peak month strong?",
            evidence: highUnits !== undefined ? `${analysis.highest.label} sold ${formatNumber(highUnits)} units, versus ${formatNumber(averageByMonth(monthlyRows, analysis.dimension, unitsColumn ?? analysis.metric))} monthly average.` : `${analysis.highest.label} is the highest revenue month.`,
            decision: "Replicate the peak-month demand and channel operating pattern before scaling spend.",
            missing: "Dealer capacity, traffic, conversion, campaign calendar."
        },
        {
            question: "Why is the trough month weak?",
            evidence: lowUnits !== undefined ? `${analysis.lowest.label} sold ${formatNumber(lowUnits)} units, versus ${formatNumber(averageByMonth(monthlyRows, analysis.dimension, unitsColumn ?? analysis.metric))} monthly average.` : `${analysis.lowest.label} is the lowest revenue month.`,
            decision: "Treat the trough as a volume recovery issue unless ASP/mix deterioration is proven.",
            missing: "Lost leads, stock-outs, competitor actions, financing approval rates."
        },
        {
            question: "Is price the main issue?",
            evidence: highAsp !== undefined && lowAsp !== undefined ? `Implied ASP changes from ${formatNumber(lowAsp)} to ${formatNumber(highAsp)} million VND per unit.` : "ASP was not returned.",
            decision: "Do not lead with price changes if volume explains most of the variance.",
            missing: "Model mix, trim mix, discount by dealer, transaction-level price waterfall."
        },
        {
            question: "What should CEO monitor next?",
            evidence: `${marginColumn ? "Margin returned. " : "Margin missing. "}${inventoryColumn ? "Inventory returned. " : "Inventory missing. "}${marketShareColumn ? "Market share returned." : "Market share missing."}`,
            decision: "Add a standing weekly view for volume, ASP/mix, discount, inventory days, market share, and marketing ROI.",
            missing: "Plan/forecast/target and cash conversion metrics."
        }
    ];
    return {
        totalRevenue,
        averageRevenue,
        highRow,
        lowRow,
        highUnits,
        lowUnits,
        highAsp,
        lowAsp,
        unitEffect,
        aspMixEffect,
        lastThreeRunRate,
        trendText,
        leverCards,
        decisionRows,
        dimensionInsights: buildDimensionInsights(rows, columns, analysis)
    };
}
function buildDimensionInsights(rows, columns, analysis) {
    if (columns.includes("Dimension") && columns.includes("Member")) {
        const total = selectMonthlyRows(rows).reduce((sum, row) => sum + numericValue(row[analysis.metric]), 0);
        return unique(rows
            .filter(row => String(row.Scope ?? "") !== "Monthly" && typeof row.Dimension === "string")
            .map(row => String(row.Dimension)))
            .map(dimension => {
            const dimensionRows = rows.filter(row => String(row.Dimension ?? "") === dimension && String(row.Scope ?? "") !== "Monthly");
            const grouped = groupMetric(dimensionRows, "Member", analysis.metric)
                .filter(item => item.label && item.value > 0)
                .sort((a, b) => b.value - a.value);
            if (grouped.length < 2)
                return undefined;
            const top = grouped[0];
            const bottom = grouped[grouped.length - 1];
            const topShare = total ? top.value / total : 0;
            return {
                dimension,
                topLabel: top.label,
                topValue: top.value,
                topShare,
                bottomLabel: bottom.label,
                bottomValue: bottom.value,
                itemCount: grouped.length,
                read: `${top.label} leads ${dimension} with ${formatPercent(topShare)} of revenue; ${bottom.label} is the smallest returned contributor. Drill this dimension for root cause before deciding spend or capacity.`
            };
        })
            .filter((item) => item !== undefined)
            .slice(0, 6);
    }
    const dimensions = columns.filter(column => column !== analysis.dimension &&
        column !== "Scope" &&
        rows.some(row => typeof row[column] === "string"));
    const total = rows.reduce((sum, row) => sum + numericValue(row[analysis.metric]), 0);
    return dimensions
        .map(dimension => {
        const grouped = groupMetric(rows, dimension, analysis.metric)
            .filter(item => item.label && item.value > 0)
            .sort((a, b) => b.value - a.value);
        if (grouped.length < 2)
            return undefined;
        const top = grouped[0];
        const bottom = grouped[grouped.length - 1];
        const topShare = total ? top.value / total : 0;
        return {
            dimension,
            topLabel: top.label,
            topValue: top.value,
            topShare,
            bottomLabel: bottom.label,
            bottomValue: bottom.value,
            itemCount: grouped.length,
            read: `${top.label} leads ${dimension} with ${formatPercent(topShare)} of returned revenue; ${bottom.label} is the smallest contributor. Use this as a drill path, not final causality, unless the query also includes operational drivers for this dimension.`
        };
    })
        .filter((item) => item !== undefined)
        .slice(0, 6);
}
function selectMonthlyRows(rows) {
    const scoped = rows.filter(row => String(row.Scope ?? "") === "Monthly");
    if (rows.some(row => row.Scope !== undefined))
        return scoped;
    return scoped.length ? scoped : rows;
}
function groupMetric(rows, dimension, metric) {
    const groups = new Map();
    for (const row of rows) {
        const label = String(row[dimension] ?? "").trim();
        if (!label)
            continue;
        groups.set(label, (groups.get(label) ?? 0) + numericValue(row[metric]));
    }
    return [...groups.entries()].map(([label, value]) => ({ label, value }));
}
function aggregateRows(rows, columns) {
    const aggregate = {};
    for (const column of columns) {
        const values = rows.map(row => row[column]).filter(value => value !== null && value !== undefined);
        if (values.some(value => typeof value === "number")) {
            const numericValues = values.filter((value) => typeof value === "number" && Number.isFinite(value));
            const normalized = normalizeForMatch(column);
            aggregate[column] = normalized.includes("avg") || normalized.includes("pct") || normalized.includes("margin")
                ? average(numericValues)
                : numericValues.reduce((sum, value) => sum + value, 0);
        }
        else if (typeof values[0] === "string" || typeof values[0] === "boolean") {
            aggregate[column] = values[0];
        }
    }
    return aggregate;
}
function volumeNarrative(executive) {
    if (executive.highUnits === undefined || executive.lowUnits === undefined) {
        return "The query did not return units, so the report can only confirm revenue extremes.";
    }
    const unitDelta = executive.highUnits - executive.lowUnits;
    const aspText = executive.highAsp !== undefined && executive.lowAsp !== undefined
        ? ` ASP moved from ${formatNumber(executive.lowAsp)} to ${formatNumber(executive.highAsp)} million VND per unit.`
        : "";
    return `Peak month sold ${formatNumber(unitDelta)} more units than trough month.${aspText}`;
}
function impliedAsp(revenue, units, fallbackAsp) {
    if (units && units !== 0)
        return (revenue / units) * 1000;
    return fallbackAsp;
}
function findColumnByTokens(columns, tokens) {
    return columns.find(column => {
        const normalized = normalizeForMatch(column);
        return tokens.some(token => normalized.includes(token));
    });
}
function compareDimension(a, b) {
    if (typeof a === "number" && typeof b === "number")
        return a - b;
    return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true });
}
function formatMetricValue(metric, value) {
    const normalized = normalizeForMatch(metric);
    if (normalized.includes("billionvnd"))
        return `${formatNumber(value)} tỷ VND`;
    if (normalized.includes("millionvnd"))
        return `${formatNumber(value)} triệu VND`;
    if (normalized.includes("pct") || normalized.includes("margin")) {
        const percent = Math.abs(value) <= 1 ? value * 100 : value;
        return `${formatNumber(percent)}%`;
    }
    return formatNumber(value);
}
function buildKpis(rows, columns, analysis) {
    if (analysis) {
        return [
            {
                label: `Highest ${analysis.metric}`,
                value: `${analysis.highest.label}: ${formatNumber(analysis.highest.value)}`,
                tone: "green"
            },
            {
                label: `Lowest ${analysis.metric}`,
                value: `${analysis.lowest.label}: ${formatNumber(analysis.lowest.value)}`,
                tone: "red"
            },
            {
                label: "Spread",
                value: formatNumber(analysis.spread),
                tone: "amber"
            },
            {
                label: "Rows returned",
                value: formatNumber(rows.length),
                tone: "blue"
            }
        ];
    }
    const numericColumns = columns.filter(column => rows.some(row => typeof row[column] === "number"));
    const tones = ["green", "blue", "amber", "red"];
    const metricKpis = numericColumns.slice(0, 3).map((column, index) => ({
        label: column,
        value: formatNumber(rows.reduce((sum, row) => sum + numericValue(row[column]), 0)),
        tone: tones[index]
    }));
    return [
        ...metricKpis,
        {
            label: "Rows returned",
            value: formatNumber(rows.length),
            tone: tones[metricKpis.length % tones.length]
        }
    ].slice(0, 4);
}
function buildBars(rows, dimension, metric) {
    const sorted = [...rows]
        .sort((a, b) => numericValue(b[metric]) - numericValue(a[metric]))
        .slice(0, 12);
    const max = Math.max(...sorted.map(row => Math.abs(numericValue(row[metric]))), 1);
    return sorted.map(row => {
        const value = numericValue(row[metric]);
        return {
            label: String(row[dimension] ?? "Unspecified"),
            value: formatNumber(value),
            width: Math.max(3, Math.round((Math.abs(value) / max) * 100))
        };
    });
}
function analyzeRevenueMonthExtremes(question, rows, columns) {
    if (rows.length === 0)
        return undefined;
    const monthColumn = findMonthColumn(rows, columns);
    const revenueColumn = findRevenueColumn(rows, columns);
    if (!revenueColumn && !asksForMonthExtremes(question))
        return undefined;
    const metricColumn = revenueColumn ?? firstNumericColumn(rows, columns);
    if (!monthColumn || !metricColumn)
        return undefined;
    const totals = new Map();
    for (const row of rows) {
        const label = String(row[monthColumn] ?? "").trim();
        if (!label)
            continue;
        totals.set(label, (totals.get(label) ?? 0) + numericValue(row[metricColumn]));
    }
    if (totals.size < 2)
        return undefined;
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
    const highest = ranked[0];
    const lowest = ranked[ranked.length - 1];
    const language = prefersVietnamese(question) ? "vi" : "en";
    return {
        dimension: monthColumn,
        metric: metricColumn,
        highest: {
            label: highest[0],
            value: highest[1],
            reasons: explainExtreme("high", highest[0], rows, columns, monthColumn, metricColumn, totals, language)
        },
        lowest: {
            label: lowest[0],
            value: lowest[1],
            reasons: explainExtreme("low", lowest[0], rows, columns, monthColumn, metricColumn, totals, language)
        },
        spread: highest[1] - lowest[1],
        language
    };
}
function buildInsights(analysis) {
    if (!analysis)
        return [];
    if (analysis.language === "vi") {
        return [
            {
                title: `Cao nhất: ${analysis.highest.label}`,
                detail: `${analysis.metric} đạt ${formatNumber(analysis.highest.value)}. ${analysis.highest.reasons.join(" ")}`
            },
            {
                title: `Thấp nhất: ${analysis.lowest.label}`,
                detail: `${analysis.metric} đạt ${formatNumber(analysis.lowest.value)}. ${analysis.lowest.reasons.join(" ")}`
            }
        ];
    }
    return [
        {
            title: `Highest: ${analysis.highest.label}`,
            detail: `${analysis.metric} reached ${formatNumber(analysis.highest.value)}. ${analysis.highest.reasons.join(" ")}`
        },
        {
            title: `Lowest: ${analysis.lowest.label}`,
            detail: `${analysis.metric} reached ${formatNumber(analysis.lowest.value)}. ${analysis.lowest.reasons.join(" ")}`
        }
    ];
}
function explainExtreme(mode, monthLabel, rows, columns, monthColumn, metricColumn, monthTotals, language) {
    const reasons = [];
    const monthRows = rows.filter(row => String(row[monthColumn] ?? "").trim() === monthLabel);
    const monthAverage = average([...monthTotals.values()]);
    const monthValue = monthTotals.get(monthLabel) ?? 0;
    const variance = monthValue - monthAverage;
    const driver = strongestNumericDriver(mode, monthRows, rows, columns, monthColumn, metricColumn);
    if (driver) {
        reasons.push(language === "vi"
            ? `${driver.column} ${mode === "high" ? "cao hơn" : "thấp hơn"} mức trung bình (${formatNumber(driver.value)} so với ${formatNumber(driver.average)}), là driver nổi bật nhất trong các cột query trả về.`
            : `${driver.column} is ${mode === "high" ? "above" : "below"} average (${formatNumber(driver.value)} vs ${formatNumber(driver.average)}), the strongest returned driver.`);
    }
    const contributor = strongestDimensionContributor(mode, monthLabel, rows, columns, monthColumn, metricColumn);
    if (contributor) {
        reasons.push(language === "vi"
            ? `${contributor.column} = ${contributor.value} đóng góp ${formatNumber(contributor.amount)} trong tháng này và lệch ${formatNumber(contributor.delta)} so với mức tháng trung bình của cùng nhóm.`
            : `${contributor.column} = ${contributor.value} contributed ${formatNumber(contributor.amount)} this month, ${formatNumber(contributor.delta)} from that group's average month.`);
    }
    if (reasons.length === 0) {
        reasons.push(language === "vi"
            ? `Query hiện chỉ đủ dữ liệu để xác nhận tháng này ${mode === "high" ? "cao hơn" : "thấp hơn"} mức trung bình ${formatNumber(Math.abs(variance))}; để giải thích sâu hơn, hãy trả thêm các driver như số đơn, khách hàng, sản phẩm, khu vực hoặc kênh bán.`
            : `The query only has enough data to confirm this month is ${formatNumber(Math.abs(variance))} ${mode === "high" ? "above" : "below"} average; return drivers such as orders, customers, product, region, or channel for a deeper explanation.`);
    }
    return reasons;
}
function strongestNumericDriver(mode, monthRows, allRows, columns, monthColumn, metricColumn) {
    const candidates = columns.filter(column => column !== monthColumn &&
        column !== metricColumn &&
        allRows.some(row => typeof row[column] === "number"));
    return candidates
        .map(column => {
        const value = sumRows(monthRows, column);
        const averageValue = averageByMonth(allRows, monthColumn, column);
        return { column, value, average: averageValue, delta: value - averageValue };
    })
        .filter(item => mode === "high" ? item.delta > 0 : item.delta < 0)
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
}
function strongestDimensionContributor(mode, monthLabel, rows, columns, monthColumn, metricColumn) {
    const dimensionColumns = columns.filter(column => column !== monthColumn &&
        !["Scope", "Dimension", "Member"].includes(column) &&
        rows.some(row => typeof row[column] === "string"));
    const candidates = dimensionColumns.flatMap(column => {
        const values = unique(rows.map(row => String(row[column] ?? "").trim()).filter(Boolean));
        return values.map(value => {
            const amount = rows
                .filter(row => String(row[monthColumn] ?? "").trim() === monthLabel && String(row[column] ?? "").trim() === value)
                .reduce((sum, row) => sum + numericValue(row[metricColumn]), 0);
            const averageAmount = averageContributionByMonth(rows, monthColumn, column, value, metricColumn);
            return { column, value, amount, delta: amount - averageAmount };
        });
    });
    return candidates
        .filter(item => item.amount !== 0 && (mode === "high" ? item.delta > 0 : item.delta < 0))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0];
}
function findMonthColumn(rows, columns) {
    const byName = columns.find(column => {
        const normalized = normalizeForMatch(column);
        return ["yearmonth", "month", "period", "date", "thang", "ngay"].some(token => normalized.includes(token));
    });
    if (byName)
        return byName;
    return columns.find(column => rows.some(row => {
        const value = row[column];
        return typeof value === "string" && looksLikeMonthValue(value);
    }));
}
function findRevenueColumn(rows, columns) {
    return columns.find(column => rows.some(row => typeof row[column] === "number") &&
        ["revenue", "sales", "doanhthu", "doanhso", "gross", "netamount", "amount", "turnover"].some(token => normalizeForMatch(column).includes(token)));
}
function firstNumericColumn(rows, columns) {
    return columns.find(column => rows.some(row => typeof row[column] === "number"));
}
function looksLikeMonthValue(value) {
    const normalized = stripVietnamese(value).toLowerCase().trim();
    return /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|thang)\b/.test(normalized) ||
        /^\d{4}[-/]\d{1,2}$/.test(normalized) ||
        /^\d{1,2}[-/]\d{4}$/.test(normalized);
}
function averageByMonth(rows, monthColumn, metricColumn) {
    const totals = new Map();
    for (const row of rows) {
        const month = String(row[monthColumn] ?? "").trim();
        if (!month)
            continue;
        totals.set(month, (totals.get(month) ?? 0) + numericValue(row[metricColumn]));
    }
    return average([...totals.values()]);
}
function averageContributionByMonth(rows, monthColumn, dimensionColumn, dimensionValue, metricColumn) {
    const totals = new Map();
    for (const row of rows) {
        const month = String(row[monthColumn] ?? "").trim();
        if (!month || String(row[dimensionColumn] ?? "").trim() !== dimensionValue)
            continue;
        totals.set(month, (totals.get(month) ?? 0) + numericValue(row[metricColumn]));
    }
    return average([...totals.values()]);
}
function sumRows(rows, column) {
    return rows.reduce((sum, row) => sum + numericValue(row[column]), 0);
}
function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
function renderTable(rows, columns) {
    if (rows.length === 0 || columns.length === 0)
        return "<p>No rows returned.</p>";
    const visibleRows = rows.slice(0, 100);
    return `<div class="table-wrap"><table><thead><tr>${columns.map(column => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${visibleRows.map(row => `<tr>${columns.map(column => {
        const value = row[column];
        const numeric = typeof value === "number";
        return `<td class="${numeric ? "number" : ""}">${escapeHtml(numeric ? formatNumber(value) : String(value ?? ""))}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>`;
}
async function writeDashboardFile(title, html) {
    const outputDir = resolve(process.env.POWERBI_REPORT_OUTPUT_DIR ||
        process.env.POWERBI_DASHBOARD_OUTPUT_DIR ||
        "powerbi-report-output");
    await mkdir(outputDir, { recursive: true });
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slugify(title)}.html`;
    const path = resolve(outputDir, filename);
    await writeFile(path, html, "utf8");
    return path;
}
function numericValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function formatNumber(value) {
    return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: Number.isInteger(value) ? 0 : 2
    }).format(value);
}
function formatPercent(value) {
    return `${formatNumber(value * 100)}%`;
}
function cleanColumnName(value) {
    const cleaned = value
        .replace(/^\[[^\]]+\]\./, "")
        .replace(/^'([^']+)'\[([^\]]+)\]$/, "$1 $2")
        .replace(/^[^\[]+\[([^\]]+)\]$/, "$1")
        .trim();
    return cleaned.replace(/^\[|\]$/g, "").trim() || value;
}
function slugify(value) {
    const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return slug || "dashboard";
}
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}
function prefersVietnamese(value) {
    return /[ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(value) ||
        /\b(thang|tháng|doanh thu|tai sao|tại sao|cao nhat|cao nhất|thap nhat|thấp nhất)\b/i.test(stripVietnamese(value));
}
function asksForMonthExtremes(value) {
    const normalized = stripVietnamese(value).toLowerCase();
    const asksMonth = /\b(thang|month|monthly)\b/.test(normalized);
    const asksExtreme = /\b(cao nhat|thap nhat|max|min|highest|lowest|best|worst)\b/.test(normalized);
    const asksRevenue = /\b(doanh thu|revenue|sales)\b/.test(normalized);
    return asksMonth && (asksExtreme || asksRevenue);
}
function stripVietnamese(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D");
}
function normalizeForMatch(value) {
    return stripVietnamese(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function unique(values) {
    return [...new Set(values)];
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isPrimitive(value) {
    return value === null || ["string", "number", "boolean"].includes(typeof value);
}
