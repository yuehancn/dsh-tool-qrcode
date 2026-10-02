// Pure-logic assertions for dsh-tool-qrcode.
//
// Everything here is a plain function call: symbol planning (mode selection,
// capacity arithmetic, version choice, remedies), the built-in encoder's
// structural invariants, and the SVG renderer. No subprocesses.
import { plugin, Context, call } from "./harness.mjs";

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
 * Assert deep equality via JSON, for small structured values.
 *
 * @param {string} label - what is being asserted.
 * @param {any} actual - the produced value.
 * @param {any} expected - the expected value.
 */
function equal(label, actual, expected) {
	const a = JSON.stringify(actual);
	const b = JSON.stringify(expected);
	check(`${label} (got ${a}, want ${b})`, a === b);
}

console.log("qrcode: logic");

// --- plugin shape ---------------------------------------------------------
check("Config is a schemastery constructor", typeof plugin.Config === "function");
equal("plugin name", plugin.name, "tool-qrcode");
equal("inject", plugin.inject, ["tools"]);

// --- registration ---------------------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const names = ctx.names().sort();
	equal("all four tools registered", names, ["qrcode_make", "qrcode_plan", "qrcode_read", "qrcode_status"]);
}

{
	const ctx = Context({ make: false, read: false, plan: false });
	plugin.apply(ctx, ctx.config);
	equal("toggles suppress tools", ctx.names(), ["qrcode_status"]);
}

{
	const ctx = Context({ status: false, make: false, read: false, plan: false });
	plugin.apply(ctx, ctx.config);
	equal("all toggles off registers nothing", ctx.names(), []);
}

// --- schema normalization -------------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	const params = make.parameters;
	equal("make: type is object", params.type, "object");
	equal("make: required hoisted to top level", params.required, ["text"]);
	check("make: text is listed in properties", params.properties.text !== undefined);
	check("make: level has enum", JSON.stringify(params.properties.level.enum) === JSON.stringify(["l", "m", "q", "h"]));

	// `defineTool` omits `additionalProperties` when the tool does not need to
	// reject extras; what matters is that it is never left as an object schema.
	check(
		"make: additionalProperties is absent or a boolean",
		params.additionalProperties === undefined || typeof params.additionalProperties === "boolean"
	);

	const plan = ctx.get("qrcode_plan");
	equal("plan: required is just text", plan.parameters.required, ["text"]);
	check(
		"plan: additionalProperties is absent or a boolean",
		plan.parameters.additionalProperties === undefined || typeof plan.parameters.additionalProperties === "boolean"
	);

	const read = ctx.get("qrcode_read");
	equal("read: required is path", read.parameters.required, ["path"]);

	const status = ctx.get("qrcode_status");
	check("status takes no parameters", Object.keys(status.parameters.properties ?? {}).length === 0);
	equal("status: no required when all optional", status.parameters.required ?? [], []);
}

// --- planning: encoding mode ---------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");

	const digits = (await call(plan, { text: "12345678901234567890" })).value;
	equal("numeric payload picks numeric mode", digits.mode, "numeric");
	check("numeric payload fits", digits.fits === true);

	const upper = (await call(plan, { text: "HELLO WORLD 123" })).value;
	check("uppercase payload uses alphanumeric mode", upper.mode.includes("alphanumeric"));

	const lower = (await call(plan, { text: "hello world" })).value;
	check("lowercase payload falls back to byte mode", lower.mode.includes("byte"));

	const cjk = (await call(plan, { text: "中文字符" })).value;
	check("CJK payload uses byte mode", cjk.mode.includes("byte"));
	equal("CJK byte count is 3 per character", cjk.bytes, 12);
	equal("CJK character count is 4", cjk.characters, 4);
}

// Alphanumeric mode is a real capacity win: the same characters take fewer bits
// because QR packs them 5.5 bits each instead of 8. The observable consequence
// is that an uppercase payload needs less headroom than its lowercase twin.
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");
	const upper = (await call(plan, { text: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" })).value;
	const lower = (await call(plan, { text: "abcdefghijklmnopqrstuvwxyz" })).value;
	check("uppercase reports alphanumeric mode", upper.mode.includes("alphanumeric"));
	check("lowercase reports byte mode", lower.mode.includes("byte"));
	check(
		"uppercase payload leaves more headroom than lowercase",
		upper.headroomBits > lower.headroomBits
	);
}

// --- planning: remedies ---------------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");
	const result = (await call(plan, { text: "hello world" })).value;
	check("mixed-case byte payload suggests upper-casing", result.remedies.some((r) => r.includes("Upper-casing")));

	const numeric = (await call(plan, { text: "12345678" })).value;
	check("pure numeric payload has no case remedy", !numeric.remedies.some((r) => r.includes("Upper-casing")));
}

// --- planning: capacity boundary -----------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");

	// Version 1 level L holds 19 data codewords. Numeric mode spends
	// 4 + 10 + 10 per three digits, so the boundary sits at 36 digits: that
	// payload consumes the symbol exactly, and 37 spills to version 2. Asserting
	// both sides of the edge catches an off-by-one in the capacity arithmetic.
	const boundary = (await call(plan, { text: "9".repeat(36) })).value;
	equal("36 digits fit version 1 exactly", boundary.version, 1);
	equal("36 digits leaves no headroom", boundary.headroomBits, 0);

	const spilled = (await call(plan, { text: "9".repeat(37) })).value;
	equal("37 digits spill to version 2", spilled.version, 2);

	const single = (await call(plan, { text: "1" })).value;
	equal("single digit fits version 1", single.version, 1);
	check("single digit has headroom", single.headroomBits > 0);
}

{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");
	// A payload larger than the biggest symbol (version 40, level L) must be
	// rejected with an actionable message rather than silently truncated.
	const huge = (await call(plan, { text: "x".repeat(3000) })).value;
	check("oversized payload does not fit", huge.fits === false);
	check("oversized payload explains the overage", huge.remedies.some((r) => r.includes("over")));
	check("oversized payload suggests shortening", huge.remedies.some((r) => r.includes("Shorten") || r.includes("short URL")));
}

// --- planning: level selection -------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");
	const low = (await call(plan, { text: "HELLO", level: "l" })).value;
	equal("requested level L is honoured", low.level, "L");
	check("L reports ~7% recovery", low.recovery === 0.07);

	const high = (await call(plan, { text: "HELLO", level: "h" })).value;
	equal("requested level H is honoured", high.level, "H");
	check("H reports ~30% recovery", high.recovery === 0.3);
	check("higher level needs a bigger symbol", high.version >= low.version);

	const lied = (await call(plan, { text: "9".repeat(200), level: "h" })).value;
	check("an impossible level is reported rather than silently accepted", lied.remedies.some((r) => r.includes("does not fit")));
}

// --- planning: print sizing ----------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const plan = ctx.get("qrcode_plan");
	const near = (await call(plan, { text: "HELLO", distanceMetres: 1 })).value;
	const far = (await call(plan, { text: "HELLO", distanceMetres: 10 })).value;
	check("print size grows with distance", far.printSize.totalMm > near.printSize.totalMm);
	check("1 m distance yields a 4 mm module pitch", near.printSize.pitchMm === 4);
	check("10 m distance yields a 40 mm module pitch", far.printSize.pitchMm === 40);
	check("quiet zone is 4 modules", near.printSize.quietZoneMm === 16);

	const noDistance = (await call(plan, { text: "HELLO" })).value;
	check("no print size without a distance", noDistance.printSize === undefined);
}

// --- built-in encoder: structural invariants -----------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");

	const result = (await call(make, { text: "HELLO", outputName: "t-hello.svg" })).value;
	check("SVG encode reports success", typeof result.outputPath === "string");
	equal("SVG encode reports its engine honestly", result.engine.includes("built-in"), true);
	equal("SVG encode reports format", result.format, "svg");
	check("SVG encode reports a version", result.version >= 1 && result.version <= 40);
	check("SVG encode reports modules", result.modules === result.version * 4 + 17);

	const svg = await (await import("node:fs/promises")).readFile(result.outputPath, "utf8");
	check("SVG has an xml namespace", svg.includes('xmlns="http://www.w3.org/2000/svg"'));
	check("SVG sets a viewBox", svg.includes("viewBox="));
	check("SVG uses crisp edges", svg.includes("shape-rendering"));
	check("SVG has a light background rect", /<rect[^>]*fill="#ffffff"/u.test(svg));
	check("SVG draws modules as a single path", svg.includes("<path fill="));

	// A larger payload must produce a larger symbol.
	const big = (await call(make, { text: "x".repeat(400), outputName: "t-big.svg" })).value;
	check("longer payload yields a bigger symbol", big.modules > result.modules);
}

// --- built-in encoder: output naming -------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	const { stat } = await import("node:fs/promises");

	const unnamed = (await call(make, { text: "A" })).value;
	check("default file name is qrcode.svg", unnamed.outputPath.endsWith("qrcode.svg"));

	const extensionless = (await call(make, { text: "A", outputName: "noext" })).value;
	check("extensionless name gains .svg", extensionless.outputPath.endsWith("noext.svg"));

	const spaced = (await call(make, { text: "A", outputName: "with space.svg" })).value;
	check("names with spaces survive", (await stat(spaced.outputPath)).isFile());

	const cjk = (await call(make, { text: "A", outputName: "中文名.svg" })).value;
	check("CJK file names survive", (await stat(cjk.outputPath)).isFile());
}

// --- built-in encoder: raster refusal ------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	const outcome = await call(make, { text: "HELLO", outputName: "photo.png" });
	check("PNG without an encoder is refused", typeof outcome.error === "string");
	check("PNG refusal names the missing capability", outcome.error.includes("external encoder"));
	check("PNG refusal offers the SVG alternative", outcome.error.includes(".svg"));
}

// --- engine configuration: external paths --------------------------------
{
	const ctx = Context({ encodeCommand: "definitely-not-a-real-binary", outputName: "x.png" });
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	const outcome = await call(make, { text: "HELLO", outputName: "photo.png" });
	check("a broken external encoder fails loudly", typeof outcome.error === "string");
	check("the failure names the configured command", outcome.error.includes("definitely-not-a-real-binary"));
}

// --- read tool: missing decoder ------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const read = ctx.get("qrcode_read");
	const outcome = await call(read, { path: "does-not-exist.png" });
	check("reading a missing file explains the path", outcome.error.includes("no file at"));
}

{
	const { writeFile } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const scratch = join(tmpdir(), "dsh-qr-logic.png");
	await writeFile(scratch, Buffer.alloc(64));
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const read = ctx.get("qrcode_read");
	const outcome = await call(read, { path: scratch });
	check("reading without a decoder names the fix", outcome.error.includes("no decoder is configured"));
	check("the fix names a real tool", outcome.error.includes("zbarimg"));
}

console.log(`qrcode logic: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.log("failing assertions:");
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}