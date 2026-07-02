import { spawn } from "node:child_process";
export class ModelingMcpBridge {
    child;
    buffer = "";
    nextId = 1;
    pending = new Map();
    currentConnection;
    async listSemanticModelsInWorkspace(workspaceName) {
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
        return (payload?.data ?? []).map((db) => ({
            id: String(db.id ?? ""),
            name: String(db.name ?? ""),
            state: optionalString(db.state),
            compatibilityLevel: optionalNumber(db.compatibilityLevel),
            modelType: optionalString(db.modelType),
            estimatedSize: optionalNumber(db.estimatedSize),
            lastProcessed: optionalString(db.lastProcessed),
            lastUpdate: optionalString(db.lastUpdate),
            lastSchemaUpdate: optionalString(db.lastSchemaUpdate)
        })).filter((m) => m.id && m.name);
    }
    async executeDaxQuery(options) {
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
    async connectFabric(workspaceName, semanticModelName) {
        await this.start();
        if (this.currentConnection?.workspaceName === workspaceName &&
            this.currentConnection?.semanticModelName === semanticModelName) {
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
    async start() {
        if (this.child)
            return;
        const command = process.env.POWERBI_MODELING_MCP_COMMAND || "npx";
        const args = process.env.POWERBI_MODELING_MCP_ARGS
            ? splitArgs(process.env.POWERBI_MODELING_MCP_ARGS)
            : ["-y", "@microsoft/powerbi-modeling-mcp@latest", "--start"];
        const useWindowsShell = shouldUseWindowsShell(command);
        this.child = spawn(command, args, {
            shell: useWindowsShell,
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
    stop() {
        this.child?.kill("SIGTERM");
        this.child = undefined;
        this.currentConnection = undefined;
        this.pending.clear();
    }
    async callTool(name, args) {
        return this.send("tools/call", { name, arguments: args }, 300_000);
    }
    send(method, params, timeoutMs = 30_000) {
        if (!this.child)
            throw new Error("Modeling MCP bridge is not started.");
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
    pump() {
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim())
                continue;
            let message;
            try {
                message = JSON.parse(line);
            }
            catch {
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
function shouldUseWindowsShell(command) {
    if (process.platform !== "win32")
        return false;
    const normalized = command.trim().toLowerCase();
    return normalized === "npx" || normalized === "npx.cmd" || normalized.endsWith(".cmd");
}
function parseToolJson(response) {
    const content = response.result?.content ?? [];
    const text = content.map((c) => c.text ?? "").join("\n").trim();
    const resources = content
        .map((c) => c.resource)
        .filter((resource) => resource?.mimeType === "text/csv" && typeof resource.text === "string");
    const csvRows = resources.flatMap((resource) => parseCsv(resource.text));
    if (!text) {
        return csvRows.length ? { data: csvRows } : undefined;
    }
    try {
        const payload = JSON.parse(text);
        if (csvRows.length && isRecord(payload))
            return { ...payload, data: csvRows };
        if (csvRows.length)
            return { data: csvRows, text: payload };
        return payload;
    }
    catch {
        return csvRows.length ? { rawText: text, data: csvRows } : { rawText: text };
    }
}
function parseCsv(input) {
    const rows = input
        .split(/\r?\n/)
        .filter(line => line.trim().length > 0)
        .map(parseCsvLine);
    const headers = rows.shift();
    if (!headers?.length)
        return [];
    return rows.map(row => Object.fromEntries(headers.map((header, index) => [
        cleanCsvHeader(header),
        coerceCsvValue(row[index] ?? "")
    ])));
}
function parseCsvLine(line) {
    const values = [];
    let current = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        const next = line[index + 1];
        if (char === '"' && quoted && next === '"') {
            current += '"';
            index += 1;
            continue;
        }
        if (char === '"') {
            quoted = !quoted;
            continue;
        }
        if (char === "," && !quoted) {
            values.push(current);
            current = "";
            continue;
        }
        current += char;
    }
    values.push(current);
    return values;
}
function cleanCsvHeader(value) {
    const trimmed = value.trim();
    const measure = trimmed.match(/^\[([^\]]+)\]$/);
    return measure?.[1] ?? trimmed;
}
function coerceCsvValue(value) {
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    if (/^-?\d+$/.test(trimmed))
        return Number(trimmed);
    if (/^-?\d+\.\d+$/.test(trimmed))
        return Number(trimmed);
    if (/^-?\d+,\d+$/.test(trimmed))
        return Number(trimmed.replace(",", "."));
    if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(trimmed))
        return Number(trimmed.replace(/\./g, "").replace(",", "."));
    if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed))
        return Number(trimmed.replace(/,/g, ""));
    return trimmed;
}
function extractMessage(response) {
    const payload = parseToolJson(response);
    return payload?.message ?? payload?.rawText;
}
function optionalString(value) {
    return typeof value === "string" ? value : undefined;
}
function optionalNumber(value) {
    return typeof value === "number" ? value : undefined;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function splitArgs(input) {
    return input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(part => part.replace(/^"|"$/g, "")) ?? [];
}
