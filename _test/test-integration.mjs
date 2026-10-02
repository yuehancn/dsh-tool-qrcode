// Integration assertions for dsh-tool-qrcode.
//
// These exercise the plugin through its real tool definitions: engine probing,
// the external encode/decode round trip against a mock engine subprocess, and
// the modelled failure paths. The point is that a model driving these tools gets
// an actionable message rather than a raw exception.
import { plugin, Context, call } from "./harness.mjs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
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

const node = process.execPath;
const mock = resolve("_test/fixtures/mock-engine.mjs");
const scratch = await mkdtemp(join(tmpdir(), "dsh-qr-int-"));

/** Build a context configured to use the mock engine for encoding. */
function encoderContext(extra = {}) {
	return Context({
		outputDir: scratch,
		encodeCommand: node,
		encodeArgs: [mock, "encode", "{output}", "{level}", "{text}"],
		...extra
	});
}

/** Build a context configured to use the mock engine for decoding. */
function decoderContext(extra = {}) {
	return Context({
		outputDir: scratch,
		decodeCommand: node,
		decodeArgs: [mock, "decode", "{input}"],
		...extra
	});
}

console.log("qrcode: integration");

// --- status: built-in encoder --------------------------------------------
{
	const ctx = Context();
	plugin.apply(ctx, ctx.config);
	const status = ctx.get("qrcode_status");
	const value = (await call(status, {})).value;

	check("reports the built-in encoder as available", value.nativeEncoder === true);
	check("lists SVG as a native format", value.nativeFormats.includes(".svg"));
	equal("no external encoder configured", value.encoder.configured, false);
	equal("no external decoder configured", value.decoder.configured, false);
	check("explains that PNG needs an encoder", value.note.includes("PNG"));
	check("explains that reading needs a decoder", value.note.includes("decodeCommand"));
	check("lists all four levels", value.levels.length === 4);
	check("names the recovery percentage", value.levels.some((l) => l.startsWith("H") && l.includes("30%")));
}

// --- status: working external engine -------------------------------------
// Both slots point at the mock, so the probe output is the mock's own version
// line. A mock script driven through an interpreter must answer `--version`,
// because the plugin tries that flag first.
{
	const ctx = encoderContext({ decodeCommand: node, decodeArgs: [mock, "decode", "{input}"] });
	plugin.apply(ctx, ctx.config);
	const value = (await call(ctx.get("qrcode_status"), {})).value;
	equal("detects the configured encoder", value.encoder.configured, true);
	check("probes the encoder successfully", value.encoder.available === true);
	check("reads the encoder version", typeof value.encoder.version === "string" && value.encoder.version.includes("mock-qr"));
	check("detects the configured decoder", value.decoder.configured === true);
	check("all capabilities reported available", value.note.includes("All capabilities"));
}

// --- status: wrapper commands are probed through, not around -------------
// With `node wrapper.mjs encode {output} ...`, the interpreter is the command but
// the wrapper is the engine. The probe must keep the script path and drop the
// `encode` subcommand, otherwise the wrapper does real work and prints nothing.
{
	const ctx = Context({ outputDir: scratch, encodeCommand: node, encodeArgs: [mock, "encode", "{output}", "{level}", "{text}"] });
	plugin.apply(ctx, ctx.config);
	const value = (await call(ctx.get("qrcode_status"), {})).value;
	equal("a wrapper command is available", value.encoder.available, true);
	check("the version comes from the wrapper, not the interpreter", typeof value.encoder.version === "string" && value.encoder.version.includes("mock-qr"));
}

// --- status: broken external engine --------------------------------------
{
	const ctx = Context({ encodeCommand: "no-such-qr-binary" });
	plugin.apply(ctx, ctx.config);
	const value = (await call(ctx.get("qrcode_status"), {})).value;
	equal("still reports a configured encoder", value.encoder.configured, true);
	equal("but marks it unavailable", value.encoder.available, false);
	check("includes the failure reason", typeof value.encoder.error === "string");
	check("the built-in encoder is unaffected", value.nativeEncoder === true);
}

// --- external encode round trip ------------------------------------------
{
	const ctx = encoderContext();
	plugin.apply(ctx, ctx.config);
	const make = ctx.get("qrcode_make");
	const result = (await call(make, { text: "https://example.com/a b", outputName: "ext.png" })).value;

	check("external encode returns a path", typeof result.outputPath === "string");
	check("external encode reports the configured engine", result.engine === node);
	equal("external encode reports the requested format", result.format, "png");
	check("external encode reports level and version", typeof result.version === "number" && typeof result.level === "string");

	const written = await readFile(result.outputPath, "utf8");
	check("the level reaches the external command", written.startsWith(`MOCKQR ${result.level} `));
	check("a payload with a space survives argument passing", written.includes("https://example.com/a b"));

	const info = await stat(result.outputPath);
	check("the reported size matches the file", result.sizeBytes === info.size);
}

// --- external engine that exits cleanly but writes nothing ----------------
{
	const ctx = Context({
		outputDir: scratch,
		encodeCommand: node,
		encodeArgs: [mock, "silent", "{output}", "{level}", "{text}"]
	});
	plugin.apply(ctx, ctx.config);
	const outcome = await call(ctx.get("qrcode_make"), { text: "HELLO", outputName: "missing.png" });
	check("a silent encoder is treated as a failure", typeof outcome.error === "string");
	check("the failure explains that no file was written", outcome.error.includes("wrote no file"));
	check("the failure points at encodeArgs", outcome.error.includes("encodeArgs"));
}

// --- external engine that exits non-zero ---------------------------------
{
	const ctx = Context({
		outputDir: scratch,
		encodeCommand: node,
		encodeArgs: [mock, "fail"]
	});
	plugin.apply(ctx, ctx.config);
	const outcome = await call(ctx.get("qrcode_make"), { text: "HELLO", outputName: "x.png" });
	check("a failing encoder produces an error", typeof outcome.error === "string");
}

// --- decode round trip ---------------------------------------------------
{
	const ctx = decoderContext();
	plugin.apply(ctx, ctx.config);
	const read = ctx.get("qrcode_read");
	const fixture = join(scratch, "decodable.txt");
	await writeFile(fixture, "MOCKQR Q https://example.com\n", "utf8");

	const value = (await call(read, { path: fixture })).value;
	equal("decodes the payload", value.decoded, true);
	equal("returns the payload text", value.text, "https://example.com");
	equal("reports the configured engine", value.engine, node);
	check("reports a byte size", value.sizeBytes > 0);
}

// --- decode: a file with no symbol ---------------------------------------
{
	const ctx = decoderContext();
	plugin.apply(ctx, ctx.config);
	const read = ctx.get("qrcode_read");
	const fixture = join(scratch, "blank.txt");
	await writeFile(fixture, "this file has no qr payload\n", "utf8");

	const value = (await call(read, { path: fixture })).value;
	equal("reports nothing decoded", value.decoded, false);
	check("does not invent a text field", value.text === undefined);
	check("explains the likely causes", value.warnings.some((w) => w.includes("quiet zone")));
	check("mentions blur or inversion", value.warnings.some((w) => w.includes("blurred") || w.includes("inverted")));
}

// --- decode: decoder that fails ------------------------------------------
{
	const ctx = Context({
		outputDir: scratch,
		decodeCommand: node,
		decodeArgs: [mock, "fail"]
	});
	plugin.apply(ctx, ctx.config);
	const fixture = join(scratch, "whatever.txt");
	await writeFile(fixture, "x", "utf8");
	const value = (await call(ctx.get("qrcode_read"), { path: fixture })).value;
	equal("a failing decoder still returns a result", value.decoded, false);
	check("surfaces the decoder's exit code", value.warnings.some((w) => w.includes("exit") || w.includes("code")));
}

// --- decode: format sniffing ---------------------------------------------
{
	const ctx = decoderContext();
	plugin.apply(ctx, ctx.config);
	const read = ctx.get("qrcode_read");

	// A PNG header must be recognised, and a bogus header must be flagged.
	const fakePng = join(scratch, "fake.png");
	await writeFile(fakePng, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]));
	const pngValue = (await call(read, { path: fakePng })).value;
	equal("recognises a PNG header", pngValue.format, "png");
	check("a PNG does not raise a format warning", !pngValue.warnings.some((w) => w.includes("Header does not match")));

	const notImage = join(scratch, "not-an-image.bin");
	await writeFile(notImage, Buffer.alloc(2000, 0x11));
	const binValue = (await call(read, { path: notImage })).value;
	check("flags an unrecognised header", binValue.warnings.some((w) => w.includes("Header does not match")));
}

// --- decode: tiny file warning -------------------------------------------
{
	const ctx = decoderContext();
	plugin.apply(ctx, ctx.config);
	const tiny = join(scratch, "tiny.png");
	await writeFile(tiny, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	const value = (await call(ctx.get("qrcode_read"), { path: tiny })).value;
	check("warns about a suspiciously small file", value.warnings.some((w) => w.includes("under 1 KB")));
}

// --- read: path that is a directory --------------------------------------
{
	const ctx = decoderContext();
	plugin.apply(ctx, ctx.config);
	const outcome = await call(ctx.get("qrcode_read"), { path: scratch });
	check("a directory path is rejected", typeof outcome.error === "string");
	check("the rejection says it is not a file", outcome.error.includes("is not a file"));
}

// --- SVG output honours colour and scale ---------------------------------
{
	const ctx = Context({ outputDir: scratch, scale: 4 });
	plugin.apply(ctx, ctx.config);
	const result = (await call(ctx.get("qrcode_make"), {
		text: "COLOURS",
		outputName: "colour.svg",
		lightColor: "#f5f5f0",
		darkColor: "#123456",
		scale: 3
	})).value;
	const svg = await readFile(result.outputPath, "utf8");
	check("background colour is applied", svg.includes('fill="#f5f5f0"'));
	check("module colour is applied", svg.includes('fill="#123456"'));
	check("scale is applied", svg.includes('h3v3'));
}

// --- SVG respects the configured quiet zone ------------------------------
{
	const ctx = Context({ outputDir: scratch, quietZone: 0, scale: 2 });
	plugin.apply(ctx, ctx.config);
	const result = (await call(ctx.get("qrcode_make"), { text: "NOQUIET", outputName: "noquiet.svg" })).value;
	const svg = await readFile(result.outputPath, "utf8");
	check("zero quiet zone starts the first module at the origin", svg.includes("M0 0h2v2h-2z"));
}

// --- data url / long text -------------------------------------------------
{
	const ctx = Context({ outputDir: scratch });
	plugin.apply(ctx, ctx.config);
	const payload = "BEGIN:VCARD\nVERSION:3.0\nFN:Jane Doe\nTEL:+8613800138000\nEMAIL:jane@example.com\nEND:VCARD";
	const result = (await call(ctx.get("qrcode_make"), { text: payload, outputName: "vcard.svg" })).value;
	check("multi-line payloads encode", typeof result.outputPath === "string");
	check("multi-line payload reports a version", result.version >= 2);
	const svg = await readFile(result.outputPath, "utf8");
	check("multi-line payload produces modules", svg.includes("<path fill="));
}

console.log(`qrcode integration: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
	console.log("failing assertions:");
	for (const failure of failures) console.log(`  - ${failure}`);
	process.exit(1);
}