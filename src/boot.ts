import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pathToFileURL } from "node:url";

/**
 * Boot facade. Pi awaits every extension factory before the session is usable,
 * so this file stays free of tool, adapter, sqlite and package imports.
 * The real graph loads once, on the first session_start, after this factory
 * has already returned.
 */
const ROOT = new URL("..", import.meta.url);
const STACK = [
	new URL("./index.ts", import.meta.url).href,
	new URL("./node_modules/pi-subagents/index.js", ROOT).href,
	new URL("./node_modules/pi-web-access/dist/index.js", ROOT).href,
	new URL("./node_modules/pi-btw/extensions/btw.ts", ROOT).href,
	pathToFileURL("/Users/marban/.pi/agent/npm/node_modules/opencode-pi/src/index.ts").href,
];

type FactoryModule = { default?: unknown; sessions?: Array<(ctx: ExtensionContext) => void> };

let arming: Promise<void> | undefined;

async function arm(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const failures: string[] = [];
	for (const href of STACK) {
		try {
			const mod = (await import(href)) as FactoryModule;
			if (typeof mod.default === "function") await mod.default(pi);
			for (const start of mod.sessions ?? []) start(ctx);
		} catch (error) {
			failures.push(`${href} :: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (failures.length > 0) console.error(`cyber boot deferred load failed\n${failures.join("\n")}`);
}

export default function boot(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		arming ??= arm(pi, ctx);
		return arming;
	});
	pi.on("tool_call", () => arming);
}
