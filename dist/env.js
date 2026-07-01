import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function projectRoot() {
    return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}
export function defaultEnvPath() {
    return process.env.POWERBI_ENV_FILE || resolve(projectRoot(), ".env");
}
export function loadEnvFile(path = defaultEnvPath()) {
    if (!existsSync(path))
        return;
    const content = readFileSync(path, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const separator = line.indexOf("=");
        if (separator < 1)
            continue;
        const key = line.slice(0, separator).trim();
        const value = unquote(line.slice(separator + 1).trim());
        if (!key || process.env[key] !== undefined)
            continue;
        process.env[key] = value;
    }
}
function unquote(value) {
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}
