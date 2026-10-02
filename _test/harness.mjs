// Shared minimal harness for the dsh-tool-qrcode tests.
//
// It rebuilds the plugin's `apply` against the REAL @deepseek-ai/dsh-tools, so
// schema normalization (`required` hoisting, `additionalProperties`, enum
// retention) is exercised for real rather than against a hand-written stub.
//
// `apply(ctx, config)` in the plugin receives an already schema-resolved config,
// so this context runs the caller's options through the real `Config` first and
// fills any missing key with its default. Passing a partial object straight
// through would silently register zero tools.
import { readFile } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const source = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");

const body = source
	.replace(/^import .*$/gm, "")
	.replace(/^export \{.*\};$/m, "");

const { mkdir, writeFile, readFile: read, stat } = await import("node:fs/promises");
const { join, resolve, basename, dirname, extname } = await import("node:path");
const { spawn } = await import("node:child_process");

const build = new Function(
	"z", "defineTool",
	"mkdir", "writeFile", "readFile", "stat",
	"join", "resolve", "basename", "dirname", "extname", "spawn",
	`${body}\nreturn { Config, apply, inject, name };`
);

/** The plugin's real exports, with imports wired to genuine modules. */
export const plugin = build(
	z, defineTool,
	mkdir, writeFile, read, stat,
	join, resolve, basename, dirname, extname, spawn
);

/**
 * Build a minimal cordis-like context that records registered tools.
 *
 * @param {object} [options] - partial plugin config; missing keys take defaults.
 * @returns {{tools: object, config: object, names: () => string[], get: (n: string) => any, has: (n: string) => boolean}} the context.
 */
export function Context(options = {}) {
	const config = plugin.Config(options);
	const registry = new Map();
	const tools = {
		register(definition) {
			registry.set(definition.name, definition);
		}
	};
	return {
		tools,
		config,
		names: () => [...registry.keys()],
		get: (n) => registry.get(n),
		has: (n) => registry.has(n)
	};
}

/**
 * Run a tool call and capture either its value or the thrown error, so tests can
 * assert on modelled failure paths without try/catch noise.
 *
 * @param {any} definition - a tool definition whose signature has `execute`.
 * @param {object} args - tool arguments.
 * @returns {Promise<{value?: any, error?: string}>} the outcome.
 */
export async function call(definition, args) {
	try {
		return { value: await definition.execute(args, { signal: undefined }) };
	} catch (error) {
		return { error: String(error?.message ?? error) };
	}
}

export default { plugin, Context, call };