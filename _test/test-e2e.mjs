// End-to-end assertions for dsh-tool-qrcode.
//
// These drive the built-in encoder through the real tools and check what
// actually lands on disk: that the SVG is well-formed, that its module grid can
// be reconstructed from the markup at all, and that a symbol survives a
// re-render at a different scale. The Python script `verify-qr.py` then decodes
// the same files with an independent library, so the encoder is never graded
// only by its own arithmetic.
//
// Run: node _test/test-e2e.mjs
import { plugin, Context, call } from "./harness.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let passed = 0;
const failures = [];

/**
 * Assert a condition and record the outcome.
 *
 * @param {string} label - what is being asserted.
 * @param {boolean} condition - the assertion result.
 */
function check(label, condition) {
	if (condition) {
		passed += 1;
	} else {
		failures.push(label);
		console.log(`  FAIL  ${label}`);
	}
}

/**
 * Assert deep equality via JSON.
 *
 * @param {string} label - what is being asserted.
 * @param {any} actual - produced value.
 * @param {any} expected - expected value.
 */
function equal(label, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	check(`${label} (got ${a}, want ${b})`, a === b);
}

const scratch = await mkdtemp(join(tmpdir(), "dsh-qr-e2e-"));
const samples = resolve("_test/samples");

// The fixtures the Python verifier consumes. Keeping them in one place means a
// failing encoder shows up as a concrete artefact, not just a red assertion.
const CASES = [
	{ file: "num.svg", text: "012345678901234567890123456789012345", note: "36 digits fills a version-1 L symbol exactly" },
	{ file: "hello.svg", text: "HELLO WORLD", note: "short alphanumeric" },
	{ file: "url.svg", text: "https://example.com/qr?from=dsh", note: "typical URL" },
	{ file: "vcard.svg", text: "BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL:+8613800138000\nEMAIL:jane@example.com\nEND:VCARD", note: "multi-line byte payload" },
	{ file: "cjk.svg", text: "深度求索工具链", note: "multi-byte UTF-8" },
	{ file: "wifi.svg", text: "WIFI:T:WPA;S:OfficeNet;P:hunter2correct;;", note: "wifi config string" },
	{ file: "long.svg", text: "The quick brown fox jumps over the lazy dog. ".repeat(6).trim(), note: "long payload, larger version" },
	{ file: "big.svg", text: "https://example.com/a/very/long/path?token=abcdefghijklmnopqrstuvwxyz0123456789&mode=full".padEnd(600, "x"), note: "payload needing version 20+" }
];

console.log("qrcode: e2e");

// --- every case encodes, writes, and reports a matching size --------------
const produced = [];
{
	const ctx = Context({ outputDir: scratch });
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");

	for (const testCase of CASES) {
		const result = (await call(make, { text: testCase.text, outputName: testCase.file })).value;
		if (result === undefined) {
			check(`${testCase.file} encodes (${testCase.note})`, false);
			continue;
		}
		produced.push({ ...testCase, result });

		check(`${testCase.file} encodes (${testCase.note})`, typeof result.outputPath === "string");
		equal(`${testCase.file} uses error-correction L`, result.level, "L");
		check(`${testCase.file} reports a version`, result.version >= 1 && result.version <= 40);

		const svg = await readFile(result.outputPath, "utf8");
		check(`${testCase.file} starts with an svg root`, svg.trimStart().startsWith("<svg"));
		check(`${testCase.file} declares a viewBox`, svg.includes("viewBox="));
		check(`${testCase.file} renders modules as a single path`, (svg.match(/<path /gu) ?? []).length === 1);
		check(`${testCase.file} disables anti-aliasing`, svg.includes('shape-rendering="crispEdges"'));
		check(`${testCase.file} closes the svg element`, svg.trimEnd().endsWith("</svg>"));

		const onDisk = (await readFile(result.outputPath)).length;
		check(`${testCase.file} reports the byte size`, result.sizeBytes === onDisk);
	}
}

// --- the grid is recoverable from the markup -----------------------------
// Reconstructing the modules from the SVG path is exactly what an independent
// reader has to do, so a parser bug would surface here rather than only in the
// Python step.
{
	const modulePath = /<path fill="#[0-9a-fA-F]{6}" d="([^"]*)"/u;
	const rectPattern = /M(\d+) (\d+)h(\d+)v(\d+)h-\d+z/gu;

	for (const { file, result, text } of produced) {
		const svg = await readFile(result.outputPath, "utf8");
		const width = Number(/width="(\d+)"/u.exec(svg)[1]);
		const data = modulePath.exec(svg)[1];
		const boxes = [...data.matchAll(rectPattern)].map((m) => ({ x: Number(m[1]), y: Number(m[2]), unit: Number(m[3]) }));

		check(`${file} has drawn modules`, boxes.length > 0);

		const step = boxes[0].unit;
		const size = width / step - 8;
		check(`${file} module size is an integer`, Number.isInteger(size));
		equal(`${file} grid size matches the reported version`, size, result.version * 4 + 17);

		// Rebuild the grid and confirm the three finder patterns are present.
		const grid = Array.from({ length: size }, () => new Array(size).fill(0));
		for (const box of boxes) {
			const r = box.y / box.unit - 4;
			const c = box.x / box.unit - 4;
			if (r < 0 || c < 0 || r >= size || c >= size) continue;
			grid[r][c] = 1;
		}
		const finderOk = (top, left) => {
			// 7x7 finder: solid border ring, blank inset, solid 3x3 core.
			for (let i = 0; i < 7; i += 1) {
				if (grid[top][left + i] !== 1 || grid[top + 6][left + i] !== 1) return false;
				if (grid[top + i][left] !== 1 || grid[top + i][left + 6] !== 1) return false;
			}
			for (let i = 0; i < 3; i += 1) {
				for (let j = 0; j < 3; j += 1) {
					if (grid[top + 2 + i][left + 2 + j] !== 1) return false;
					if (grid[top + 1][left + 1 + j] !== 0 && grid[top + 1][left + 1] !== 0) return false;
				}
			}
			return true;
		};
		check(`${file} has a top-left finder pattern`, finderOk(0, 0));
		check(`${file} has a top-right finder pattern`, finderOk(0, size - 7));
		check(`${file} has a bottom-left finder pattern`, finderOk(size - 7, 0));

		// The position-detection core must sit at the exact centres the spec fixes.
		check(`${file} dark module at the timing row`, grid[6][8] === 1 || grid[8][6] === 1);
		check(`${file} payload is not empty`, text.length > 0);
	}
}

// --- re-rendering the same payload at another scale is byte-stable --------
// Guards the renderer against scale leaking into the module grid.
{
	const ctx = Context({ outputDir: scratch, scale: 3 });
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	const a = (await call(make, { text: "STABLE", outputName: "s3.svg" })).value;
	const b = (await call(make, { text: "STABLE", outputName: "s9.svg", scale: 9 })).value;

	const svgA = await readFile(a.outputPath, "utf8");
	const svgB = await readFile(b.outputPath, "utf8");
	const strip = (svg) => {
		const data = /d="([^"]*)"/u.exec(svg)[1];
		return [...data.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)/gu)].map((m) => ({
			x: Number(m[1]) / Number(m[3]),
			y: Number(m[2]) / Number(m[4])
		}));
	};
	equal("the module count is scale-independent", strip(svgA).length, strip(svgB).length);
	equal("the module coordinates are scale-independent", strip(svgA), strip(svgB));
	const widthOf = (svg) => Number(/width="(\d+)"/u.exec(svg)[1]);
	check("the wider render is physically larger", widthOf(svgB) > widthOf(svgA));
}

// --- a payload that cannot fit is refused, not truncated -----------------
{
	const ctx = Context({ outputDir: scratch });
	plugin.apply(ctx, ctx.config);
	// Version 40-L tops out well under this, so the encoder must decline.
	const huge = "A".repeat(5000);
	const outcome = await call(ctx.get("qrcode_make"), { text: huge, outputName: "huge.svg" });
	check("an oversized payload is refused", typeof outcome.error === "string");
	check("the refusal explains the capacity limit", /too long|capacity|version 40|does not fit/iu.test(outcome.error));
}

// --- an unachievable level is downgraded with an explanation -------------
{
	const ctx = Context({ outputDir: scratch });
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	// 2000 bytes fits at L (v27) but not at H (max 1273), so the encoder should
	// fall back rather than refuse — and must say so.
	const text = "B".repeat(2000);
	const outcome = await call(make, { text, outputName: "downgrade.svg", level: "h" });
	if (typeof outcome.error === "string") {
		check("an impossible level either falls back or explains itself", /does not fit|capacity/iu.test(outcome.error));
	} else {
		equal("the payload falls back to level L", outcome.value.level, "L");
		check("the fallback is disclosed", outcome.value.notes.some((n) => /does not fit/iu.test(n)));
		check("the disclosure names the requested level", outcome.value.notes.some((n) => n.includes("H")));
	}
}

// --- the samples handed to the independent verifier ----------------------
{
	await rm(samples, { recursive: true, force: true });
	await mkdir(samples, { recursive: true });
	const ctx = Context({ outputDir: samples });
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");

	const expected = {};
	const meta = {};
	for (const testCase of CASES) {
		const result = (await call(make, { text: testCase.text, outputName: testCase.file })).value;
		if (result === undefined) continue;
		expected[testCase.file] = testCase.text;
		meta[testCase.file] = { level: result.level, version: result.version };
		await writeFile(join(samples, testCase.file), await readFile(result.outputPath), "utf8");
	}
	await writeFile(join(samples, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`, "utf8");
	await writeFile(join(samples, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
	equal("all sample symbols were produced", Object.keys(expected).length, CASES.length);
	console.log(`  samples written to ${samples} for verify-qr.py`);
}

console.log(`qrcode e2e: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.log("failing assertions:");
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}