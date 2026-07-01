export type EvidenceColumnRoles = {
  time?: string;
  metric?: string;
  units?: string;
  asp?: string;
  grossProfit?: string;
  grossMargin?: string;
  discount?: string;
  marketing?: string;
  inventory?: string;
  marketShare?: string;
};

export type EvidenceQuerySpec = {
  id: string;
  label: string;
  role: "monthly" | "dimension_gap" | "cross_gap";
  dimensions: string[];
  query: string;
  maxRows: number;
};

export type EvidencePlan = {
  triggered: boolean;
  reason: string;
  baseTable?: string;
  focusPeriod?: string | number;
  focusMode?: "lowest" | "highest" | "specified" | "unspecified";
  roles: EvidenceColumnRoles;
  availableColumns: string[];
  availableDimensions: string[];
  missingDimensions: string[];
  missingDrivers: string[];
  querySpecs: EvidenceQuerySpec[];
  warnings: string[];
};

export type EvidenceQueryResult = {
  id: string;
  label: string;
  role: EvidenceQuerySpec["role"];
  dimensions: string[];
  rowCount: number;
  rows: Record<string, unknown>[];
  error?: string;
};

export type EvidenceGateResult = EvidencePlan & {
  queryResults: EvidenceQueryResult[];
};

const dimensionPriority = [
  "Region",
  "Model",
  "Province",
  "Dealer",
  "Channel",
  "Campaign",
  "CustomerSegment",
  "Salesperson"
];

const driverPriority = [
  "UnitsSold",
  "ASP",
  "GrossProfit",
  "GrossMargin",
  "Discount",
  "Marketing",
  "Inventory",
  "MarketShare",
  "Lead",
  "Conversion",
  "WorkingDays"
];

export function shouldRunEvidenceGate(question: string): boolean {
  const q = normalize(question);
  return /(why|taisao|visao|nguyennhan|rootcause|because|explain|lydo|thapnhat|caonhat|lowest|highest)/.test(q);
}

export function buildEvidencePlan(options: {
  question: string;
  query: string;
  schemaColumns: string[];
  returnedColumns: string[];
  returnedRows?: Record<string, unknown>[];
}): EvidencePlan {
  if (!shouldRunEvidenceGate(options.question)) {
    return {
      triggered: false,
      reason: "Question does not ask for explanation/root cause.",
      roles: {},
      availableColumns: options.schemaColumns,
      availableDimensions: [],
      missingDimensions: [],
      missingDrivers: [],
      querySpecs: [],
      warnings: []
    };
  }

  const baseTable = inferBaseTable(options.query);
  const availableColumns = unique([...options.schemaColumns, ...options.returnedColumns].filter(Boolean));
  const roles = inferColumnRoles(availableColumns);
  const focus = inferFocusPeriod(options.question, roles, options.returnedRows ?? []);
  const availableDimensions = dimensionPriority
    .map(label => findColumnByTokens(availableColumns, tokensFor(label)))
    .filter((value): value is string => Boolean(value));
  const missingDimensions = dimensionPriority.filter(label => !findColumnByTokens(availableColumns, tokensFor(label)));
  const missingDrivers = driverPriority.filter(label => !findColumnByTokens(availableColumns, tokensFor(label)));
  const warnings: string[] = [];

  if (!baseTable) warnings.push("Could not infer base table from DAX query; evidence query pack was not generated.");
  if (!roles.time) warnings.push("No month/date column detected; cannot build period gap queries.");
  if (!roles.metric) warnings.push("No revenue/sales metric detected; cannot build revenue gap queries.");
  if (focus.value === undefined) warnings.push("No focus period could be inferred from the question or returned rows; evidence query pack was not generated.");

  const querySpecs = baseTable && roles.time && roles.metric && focus.value !== undefined
    ? buildQuerySpecs(baseTable, roles, availableDimensions, focus.value)
    : [];

  return {
    triggered: true,
    reason: "Question asks for explanation; evidence sufficiency gate requires schema scan and slice gap queries before final report.",
    baseTable,
    focusPeriod: focus.value,
    focusMode: focus.mode,
    roles,
    availableColumns,
    availableDimensions,
    missingDimensions,
    missingDrivers,
    querySpecs,
    warnings
  };
}

export function buildEvidenceGateResult(plan: EvidencePlan, queryResults: EvidenceQueryResult[]): EvidenceGateResult {
  return {
    ...plan,
    queryResults
  };
}

export function schemaColumnNames(rows: Record<string, unknown>[]): string[] {
  return unique(rows
    .filter(row => String(row.IsHidden ?? "False").toLowerCase() !== "true")
    .map(row => String(row.ExplicitName ?? row.Name ?? row.SourceColumn ?? "").trim())
    .filter(Boolean));
}

export function schemaScanQuery(): string {
  return "EVALUATE INFO.COLUMNS()";
}

function buildQuerySpecs(baseTable: string, roles: EvidenceColumnRoles, dimensions: string[], focusPeriod: string | number): EvidenceQuerySpec[] {
  const specs: EvidenceQuerySpec[] = [
    {
      id: "evidence_monthly",
      label: "Monthly evidence baseline",
      role: "monthly",
      dimensions: [roles.time as string],
      query: buildMonthlyQuery(baseTable, roles),
      maxRows: 100
    }
  ];

  for (const dimension of dimensions.slice(0, 4)) {
    specs.push({
      id: `gap_${slug(dimension)}`,
      label: `${dimension} gap vs average`,
      role: "dimension_gap",
      dimensions: [dimension],
      query: buildGapQuery(baseTable, roles, [dimension], focusPeriod, 20),
      maxRows: 200
    });
  }

  const crossPairs = [
    ["Region", "Model"],
    ["Province", "Model"],
    ["Region", "Province"],
    ["Dealer", "Model"],
    ["Campaign", "Model"]
  ];
  for (const [a, b] of crossPairs) {
    const left = dimensions.find(dim => normalize(dim) === normalize(a));
    const right = dimensions.find(dim => normalize(dim) === normalize(b));
    if (!left || !right) continue;
    specs.push({
      id: `gap_${slug(left)}_${slug(right)}`,
      label: `${left} x ${right} gap vs average`,
      role: "cross_gap",
      dimensions: [left, right],
      query: buildGapQuery(baseTable, roles, [left, right], focusPeriod, 20),
      maxRows: 300
    });
  }

  return specs;
}

function buildMonthlyQuery(baseTable: string, roles: EvidenceColumnRoles): string {
  const time = qcol(baseTable, roles.time as string);
  return `EVALUATE
SUMMARIZECOLUMNS(
  ${time},
  ${measureList(baseTable, roles)}
)
ORDER BY ${time}`;
}

function buildGapQuery(baseTable: string, roles: EvidenceColumnRoles, dimensions: string[], focusPeriod: string | number, topN: number): string {
  const groupCols = dimensions.map(dim => qcol(baseTable, dim)).join(", ");
  const timeCol = qcol(baseTable, roles.time as string);
  const metricExpr = sumExpr(baseTable, roles.metric as string);
  const unitsExpr = roles.units ? sumExpr(baseTable, roles.units) : "BLANK()";
  const aspExpr = aspExpression(baseTable, roles);
  const marketingExpr = roles.marketing ? sumExpr(baseTable, roles.marketing) : "BLANK()";
  const inventoryExpr = roles.inventory ? `AVERAGE(${qcol(baseTable, roles.inventory)})` : "BLANK()";

  return `EVALUATE
VAR Base =
  ADDCOLUMNS(
    SUMMARIZE(${qtable(baseTable)}, ${groupCols}),
    "FocusRevenue", CALCULATE(${metricExpr}, ${timeCol} = ${daxLiteral(focusPeriod)}),
    "AvgRevenue", AVERAGEX(VALUES(${timeCol}), CALCULATE(${metricExpr})),
    "FocusUnits", CALCULATE(${unitsExpr}, ${timeCol} = ${daxLiteral(focusPeriod)}),
    "AvgUnits", AVERAGEX(VALUES(${timeCol}), CALCULATE(${unitsExpr})),
    "FocusASP", CALCULATE(${aspExpr}, ${timeCol} = ${daxLiteral(focusPeriod)}),
    "AvgASP", AVERAGEX(VALUES(${timeCol}), CALCULATE(${aspExpr})),
    "FocusMarketing", CALCULATE(${marketingExpr}, ${timeCol} = ${daxLiteral(focusPeriod)}),
    "AvgMarketing", AVERAGEX(VALUES(${timeCol}), CALCULATE(${marketingExpr})),
    "FocusInventoryDays", CALCULATE(${inventoryExpr}, ${timeCol} = ${daxLiteral(focusPeriod)}),
    "AvgInventoryDays", AVERAGEX(VALUES(${timeCol}), CALCULATE(${inventoryExpr}))
  )
VAR WithGap =
  ADDCOLUMNS(
    Base,
    "RevenueGap", [FocusRevenue] - [AvgRevenue],
    "UnitsGap", [FocusUnits] - [AvgUnits],
    "VolumeEffect", ([FocusUnits] - [AvgUnits]) * [FocusASP] / 1000,
    "ASPEffect", [FocusUnits] * ([FocusASP] - [AvgASP]) / 1000,
    "MarketingGap", [FocusMarketing] - [AvgMarketing],
    "InventoryGap", [FocusInventoryDays] - [AvgInventoryDays]
  )
RETURN TOPN(${topN}, WithGap, [RevenueGap], ASC)
ORDER BY [RevenueGap] ASC`;
}

function measureList(baseTable: string, roles: EvidenceColumnRoles): string {
  const measures = [
    `"Revenue", ${sumExpr(baseTable, roles.metric as string)}`,
    roles.units ? `"Units", ${sumExpr(baseTable, roles.units)}` : undefined,
    `"WeightedASP", ${aspExpression(baseTable, roles)}`,
    roles.grossProfit ? `"GrossProfit", ${sumExpr(baseTable, roles.grossProfit)}` : undefined,
    roles.grossMargin ? `"GrossMargin", AVERAGE(${qcol(baseTable, roles.grossMargin)})` : undefined,
    roles.discount ? `"Discount", ${sumExpr(baseTable, roles.discount)}` : undefined,
    roles.marketing ? `"Marketing", ${sumExpr(baseTable, roles.marketing)}` : undefined,
    roles.inventory ? `"InventoryDays", AVERAGE(${qcol(baseTable, roles.inventory)})` : undefined,
    roles.marketShare ? `"MarketShare", AVERAGE(${qcol(baseTable, roles.marketShare)})` : undefined
  ].filter(Boolean);
  return measures.join(",\n  ");
}

function inferColumnRoles(columns: string[]): EvidenceColumnRoles {
  return {
    time: findColumnByTokens(columns, ["month", "yearmonth", "date", "period", "thang", "ngay"]),
    metric: findColumnByTokens(columns, ["revenue", "sales", "doanhthu", "amount", "turnover"]),
    units: findColumnByTokens(columns, ["unitssold", "units", "quantity", "volume"]),
    asp: findColumnByTokens(columns, ["asp", "averageprice", "price"]),
    grossProfit: findColumnByTokens(columns, ["grossprofit", "profit"]),
    grossMargin: findColumnByTokens(columns, ["grossmargin", "marginpct", "margin"]),
    discount: findColumnByTokens(columns, ["discount", "rebate"]),
    marketing: findColumnByTokens(columns, ["marketing", "campaigncost", "promotion"]),
    inventory: findColumnByTokens(columns, ["inventorydays", "inventory", "stock"]),
    marketShare: findColumnByTokens(columns, ["marketshare", "share"])
  };
}

function inferFocusPeriod(question: string, roles: EvidenceColumnRoles, rows: Record<string, unknown>[]): {
  value?: string | number;
  mode: "lowest" | "highest" | "specified" | "unspecified";
} {
  const specifiedMonth = question.match(/(?:thang|tháng|month)\s*(\d{1,2})/i);
  if (specifiedMonth) return { value: Number(specifiedMonth[1]), mode: "specified" };
  if (!roles.time || !roles.metric || !rows.length) return { mode: "unspecified" };
  const candidates = rows
    .filter(row => getRowValue(row, roles.time as string) !== undefined && typeof getRowValue(row, roles.metric as string) === "number")
    .map(row => ({
      period: getRowValue(row, roles.time as string) as string | number,
      value: getRowValue(row, roles.metric as string) as number
    }));
  if (!candidates.length) return { mode: "unspecified" };
  const q = normalize(question);
  if (/(caonhat|highest|max|peak|best)/.test(q)) {
    const top = candidates.sort((a, b) => b.value - a.value)[0];
    return { value: top.period, mode: "highest" };
  }
  const bottom = candidates.sort((a, b) => a.value - b.value)[0];
  return { value: bottom.period, mode: "lowest" };
}

function aspExpression(baseTable: string, roles: EvidenceColumnRoles): string {
  if (roles.units && roles.asp) {
    return `DIVIDE(SUMX(${qtable(baseTable)}, ${qcol(baseTable, roles.units)} * ${qcol(baseTable, roles.asp)}), SUM(${qcol(baseTable, roles.units)}))`;
  }
  if (roles.units && roles.metric) {
    return `DIVIDE(SUM(${qcol(baseTable, roles.metric)}), SUM(${qcol(baseTable, roles.units)}))`;
  }
  return "BLANK()";
}

function sumExpr(baseTable: string, column: string): string {
  return `SUM(${qcol(baseTable, column)})`;
}

function inferBaseTable(query: string): string | undefined {
  const matches = [...query.matchAll(/(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_ ]*))\[([^\]]+)\]/g)];
  const counts = new Map<string, number>();
  for (const match of matches) {
    const table = (match[1] ?? match[2] ?? "").trim();
    if (!table) continue;
    counts.set(table, (counts.get(table) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function findColumnByTokens(columns: string[], tokens: string[]): string | undefined {
  return columns.find(column => {
    const normalized = normalize(column);
    return tokens.some(token => normalized.includes(normalize(token)));
  });
}

function getRowValue(row: Record<string, unknown>, column: string): unknown {
  if (row[column] !== undefined) return row[column];
  const normalized = normalize(column);
  const key = Object.keys(row).find(candidate => normalize(candidate) === normalized || normalize(candidate).endsWith(normalized));
  return key ? row[key] : undefined;
}

function tokensFor(label: string): string[] {
  const n = normalize(label);
  if (n === "customersegment") return ["customersegment", "segment"];
  if (n === "salesperson") return ["salesperson", "seller", "consultant"];
  return [label];
}

function qtable(table: string): string {
  if (/^'.*'$/.test(table)) return table;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return table;
  return `'${table.replace(/'/g, "''")}'`;
}

function qcol(table: string, column: string): string {
  return `${qtable(table)}[${column.replace(/\]/g, "]]")}]`;
}

function daxLiteral(value: string | number): string {
  return typeof value === "number" ? String(value) : `"${String(value).replace(/"/g, '""')}"`;
}

function slug(value: string): string {
  return normalize(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "dimension";
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
