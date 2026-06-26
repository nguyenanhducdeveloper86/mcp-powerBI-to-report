#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildDashboardResponse } from "./dashboard.js";
import { loadEnvFile } from "./env.js";
import { ModelingMcpBridge } from "./modelingMcpBridge.js";

loadEnvFile();

const modelingBridge = new ModelingMcpBridge();

const server = new McpServer({
  name: "mcp-powerBI-to-report",
  version: "0.1.0"
});

server.registerTool(
  "list_semantic_models_in_workspace",
  {
    title: "List semantic models in known workspace via Microsoft Modeling MCP",
    description: "Use Microsoft powerbi-modeling-mcp/XMLA auth to list semantic models inside a known workspace name. The workspace name must be explicit; if it is missing, ask the user instead of guessing.",
    inputSchema: {
      workspaceName: z.string().describe("Exact Fabric/Power BI workspace name, for example 'test-mcp'.")
    }
  },
  async ({ workspaceName }) => {
    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaceName,
      semanticModels: await modelingBridge.listSemanticModelsInWorkspace(workspaceName)
    });
  }
);

server.registerTool(
  "get_known_workspace_catalog",
  {
    title: "Get known workspace semantic model catalog",
    description: "List semantic models for manually configured POWERBI_KNOWN_WORKSPACES using Microsoft Modeling MCP. Use this for CEO workflows.",
    inputSchema: {
      workspaceNames: z.array(z.string()).optional().describe("Optional workspace names. Defaults to POWERBI_KNOWN_WORKSPACES, then POWERBI_DEFAULT_WORKSPACE.")
    }
  },
  async ({ workspaceNames }) => {
    const names = uniqueNonEmpty(workspaceNames?.length ? workspaceNames : configuredWorkspaces());
    if (names.length === 0) {
      throw new Error("No known workspaces configured. Set POWERBI_KNOWN_WORKSPACES or POWERBI_DEFAULT_WORKSPACE.");
    }

    const workspaces = [];
    for (const workspaceName of names) {
      workspaces.push({
        name: workspaceName,
        semanticModels: await modelingBridge.listSemanticModelsInWorkspace(workspaceName)
      });
    }

    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaces
    });
  }
);

server.registerTool(
  "execute_dax_query",
  {
    title: "Execute DAX query with CEO defaults",
    description: "Execute a DAX query against a Power BI semantic model using default workspace/model when omitted. This keeps the Microsoft Modeling MCP process alive to reduce repeated login prompts.",
    inputSchema: {
      query: z.string().describe("DAX query text, for example EVALUATE ROW(\"Revenue\", SUM(Visits[TreatmentCost]))."),
      workspaceName: z.string().optional().describe("Power BI workspace name. Defaults to POWERBI_DEFAULT_WORKSPACE."),
      semanticModelName: z.string().optional().describe("Semantic model name. Defaults to POWERBI_DEFAULT_SEMANTIC_MODEL."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ query, workspaceName, semanticModelName, maxRows, timeoutSeconds }) => {
    const workspace = workspaceName || process.env.POWERBI_DEFAULT_WORKSPACE;
    const model = semanticModelName || process.env.POWERBI_DEFAULT_SEMANTIC_MODEL;
    if (!workspace || !model) {
      throw new Error("Missing workspace/model. Set POWERBI_DEFAULT_WORKSPACE and POWERBI_DEFAULT_SEMANTIC_MODEL, or pass workspaceName and semanticModelName.");
    }

    return jsonResult({
      source: "microsoft-powerbi-modeling-mcp",
      workspaceName: workspace,
      semanticModelName: model,
      result: await modelingBridge.executeDaxQuery({
        workspaceName: workspace,
        semanticModelName: model,
        query,
        maxRows,
        timeoutSeconds
      })
    });
  }
);

server.registerTool(
  "execute_dax_report_query",
  {
    title: "Execute DAX query and build HTML executive report",
    description: "Execute a DAX query against a Power BI semantic model and return both a concise text answer and a self-contained HTML dashboard/report for executive review. Prefer this tool for boss/CEO business questions. For questions such as 'which month had the highest/lowest revenue and why', write DAX that returns a month column, a revenue/sales metric column, and when possible explanatory drivers such as orders, customers, average ticket, product/category, region, or channel.",
    inputSchema: {
      question: z.string().describe("The business question from the executive user."),
      query: z.string().describe("DAX query text, for example EVALUATE ROW(\"Revenue\", SUM(Visits[TreatmentCost]))."),
      title: z.string().optional().describe("Optional report title. Defaults to the question."),
      workspaceName: z.string().optional().describe("Power BI workspace name. Defaults to POWERBI_DEFAULT_WORKSPACE."),
      semanticModelName: z.string().optional().describe("Semantic model name. Defaults to POWERBI_DEFAULT_SEMANTIC_MODEL."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ question, query, title, workspaceName, semanticModelName, maxRows, timeoutSeconds }) => {
    return reportResult({
      question,
      query,
      title,
      workspaceName,
      semanticModelName,
      maxRows,
      timeoutSeconds
    });
  }
);

server.registerTool(
  "execute_dax_dashboard_query",
  {
    title: "Execute DAX query and build HTML dashboard",
    description: "Alias for execute_dax_report_query kept for compatibility with earlier dashboard workflows. For revenue-by-month questions, return month, revenue/sales, and available driver columns so the report can explain highest and lowest months.",
    inputSchema: {
      question: z.string().describe("The business question from the executive user."),
      query: z.string().describe("DAX query text, for example EVALUATE ROW(\"Revenue\", SUM(Visits[TreatmentCost]))."),
      title: z.string().optional().describe("Optional dashboard title. Defaults to the question."),
      workspaceName: z.string().optional().describe("Power BI workspace name. Defaults to POWERBI_DEFAULT_WORKSPACE."),
      semanticModelName: z.string().optional().describe("Semantic model name. Defaults to POWERBI_DEFAULT_SEMANTIC_MODEL."),
      maxRows: z.number().int().positive().optional().default(100),
      timeoutSeconds: z.number().int().positive().optional().default(120)
    }
  },
  async ({ question, query, title, workspaceName, semanticModelName, maxRows, timeoutSeconds }) => {
    return reportResult({
      question,
      query,
      title,
      workspaceName,
      semanticModelName,
      maxRows,
      timeoutSeconds
    });
  }
);

async function reportResult(options: {
  question: string;
  query: string;
  title?: string;
  workspaceName?: string;
  semanticModelName?: string;
  maxRows?: number;
  timeoutSeconds?: number;
}) {
  const workspace = options.workspaceName || process.env.POWERBI_DEFAULT_WORKSPACE;
  const model = options.semanticModelName || process.env.POWERBI_DEFAULT_SEMANTIC_MODEL;
  if (!workspace || !model) {
    throw new Error("Missing workspace/model. Set POWERBI_DEFAULT_WORKSPACE and POWERBI_DEFAULT_SEMANTIC_MODEL, or pass workspaceName and semanticModelName.");
  }

  const result = await modelingBridge.executeDaxQuery({
    workspaceName: workspace,
    semanticModelName: model,
    query: options.query,
    maxRows: options.maxRows,
    timeoutSeconds: options.timeoutSeconds
  });
  const dashboard = await buildDashboardResponse({
    question: options.question,
    title: options.title,
    workspaceName: workspace,
    semanticModelName: model,
    query: options.query,
    result
  });

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          source: "microsoft-powerbi-modeling-mcp",
          workspaceName: workspace,
          semanticModelName: model,
          question: options.question,
          summary: dashboard.summary,
          insights: dashboard.insights,
          reportPath: dashboard.dashboardPath,
          reportUri: dashboard.dashboardUri,
          generatedAt: dashboard.generatedAt,
          columns: dashboard.columns,
          rowCount: dashboard.rows.length
        }, null, 2)
      },
      {
        type: "resource" as const,
        resource: {
          uri: dashboard.dashboardUri,
          mimeType: "text/html",
          text: dashboard.html
        }
      }
    ],
    structuredContent: {
      source: "microsoft-powerbi-modeling-mcp",
      workspaceName: workspace,
      semanticModelName: model,
      question: options.question,
      summary: dashboard.summary,
      insights: dashboard.insights,
      reportPath: dashboard.dashboardPath,
      reportUri: dashboard.dashboardUri,
      dashboardPath: dashboard.dashboardPath,
      dashboardUri: dashboard.dashboardUri,
      generatedAt: dashboard.generatedAt,
      columns: dashboard.columns,
      rows: dashboard.rows,
      html: dashboard.html
    }
  };
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

function configuredWorkspaces(): string[] {
  return [
    ...(process.env.POWERBI_KNOWN_WORKSPACES || "").split(","),
    process.env.POWERBI_DEFAULT_WORKSPACE || ""
  ];
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
