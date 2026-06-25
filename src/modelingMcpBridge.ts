import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type XmlaSemanticModel = {
  id: string;
  name: string;
  state?: string;
  compatibilityLevel?: number;
  modelType?: string;
  estimatedSize?: number;
  lastProcessed?: string;
  lastUpdate?: string;
  lastSchemaUpdate?: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

export class ModelingMcpBridge {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private currentConnection?: {
    workspaceName: string;
    semanticModelName: string;
    connectionName?: string;
  };

  async listSemanticModelsInWorkspace(workspaceName: string): Promise<XmlaSemanticModel[]> {
    await this.start();
    const connect = await this.callTool("connection_operations", {
      request: {
        operation: "Connect",
        dataSource: `powerbi://api.powerbi.com/v1.0/myorg/${workspaceName}`
      }
    });
    if (connect.result?.isError) {
      throw new Error(extractMessage(connect) || `Failed to connect to workspace ${workspaceName}`);
    }

    const databases = await this.callTool("database_operations", {
      request: { operation: "List" }
    });
    if (databases.result?.isError) {
      throw new Error(extractMessage(databases) || `Failed to list semantic models in ${workspaceName}`);
    }
    const payload = parseToolJson(databases);
    return (payload?.data ?? []).map((db: Record<string, unknown>) => ({
      id: String(db.id ?? ""),
      name: String(db.name ?? ""),
      state: optionalString(db.state),
      compatibilityLevel: optionalNumber(db.compatibilityLevel),
      modelType: optionalString(db.modelType),
      estimatedSize: optionalNumber(db.estimatedSize),
      lastProcessed: optionalString(db.lastProcessed),
      lastUpdate: optionalString(db.lastUpdate),
      lastSchemaUpdate: optionalString(db.lastSchemaUpdate)
    })).filter((m: XmlaSemanticModel) => m.id && m.name);
  }

  async executeDaxQuery(options: {
    workspaceName: string;
    semanticModelName: string;
    query: string;
    maxRows?: number;
    timeoutSeconds?: number;
  }): Promise<unknown> {
    await this.connectFabric(options.workspaceName, options.semanticModelName);
    const response = await this.callTool("dax_query_operations", {
      request: {
        operation: "Execute",
        query: options.query,
        maxRows: options.maxRows ?? 100,
        timeoutSeconds: options.timeoutSeconds ?? 120,
        getExecutionMetrics: false
      }
    });
    if (response.result?.isError) {
      throw new Error(extractMessage(response) || "DAX query failed.");
    }
    return parseToolJson(response) ?? {};
  }

  async connectFabric(workspaceName: string, semanticModelName: string): Promise<void> {
    await this.start();
    if (
      this.currentConnection?.workspaceName === workspaceName &&
      this.currentConnection?.semanticModelName === semanticModelName
    ) {
      return;
    }

    const response = await this.callTool("connection_operations", {
      request: {
        operation: "ConnectFabric",
        workspaceName,
        semanticModelName
      }
    });
    if (response.result?.isError) {
      throw new Error(extractMessage(response) || `Failed to connect to ${workspaceName}/${semanticModelName}`);
    }
    const payload = parseToolJson(response);
    this.currentConnection = {
      workspaceName,
      semanticModelName,
      connectionName: optionalString(payload?.data?.connectionName)
    };
  }

  private async start(): Promise<void> {
    if (this.child) return;

    const command = process.env.POWERBI_MODELING_MCP_COMMAND || "npx";
    const args = process.env.POWERBI_MODELING_MCP_ARGS
      ? splitArgs(process.env.POWERBI_MODELING_MCP_ARGS)
      : ["-y", "@microsoft/powerbi-modeling-mcp@latest", "--start"];

    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.on("exit", () => {
      this.child = undefined;
      this.currentConnection = undefined;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Microsoft Modeling MCP process exited."));
      }
      this.pending.clear();
    });
    this.child.stdout.on("data", chunk => {
      this.buffer += chunk.toString();
      this.pump();
    });
    this.child.stderr.on("data", () => {
      // Microsoft Modeling MCP logs heavily to stderr; suppress in MCP responses.
    });
    await new Promise(resolve => setTimeout(resolve, 2500));
    await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-powerbi-bridge", version: "0.1.0" }
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }

  stop(): void {
    this.child?.kill("SIGTERM");
    this.child = undefined;
    this.currentConnection = undefined;
    this.pending.clear();
  }

  private async callTool(name: string, args: unknown): Promise<any> {
    return this.send("tools/call", { name, arguments: args }, 120_000);
  }

  private send(method: string, params: unknown, timeoutMs = 30_000): Promise<any> {
    if (!this.child) throw new Error("Modeling MCP bridge is not started.");
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for Modeling MCP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private pump(): void {
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        pending.resolve(message);
      }
    }
  }
}

function parseToolJson(response: any): any {
  const text = (response.result?.content ?? []).map((c: any) => c.text ?? "").join("\n").trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function extractMessage(response: any): string | undefined {
  const payload = parseToolJson(response);
  return payload?.message ?? payload?.rawText;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function splitArgs(input: string): string[] {
  return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(part => part.replace(/^"|"$/g, "")) ?? [];
}
