/**
 * Model-facing QR-code tools: encode a payload to an image, decode one back,
 * and ask what the local machine can actually do.
 *
 * The value this plugin adds over a shell one-liner is the *capacity
 * arithmetic*. A QR symbol is a two-dimensional budget: version (1-40, i.e.
 * how many modules), error-correction level (L/M/Q/H, how much redundancy) and
 * encoding mode (numeric / alphanumeric / byte / kanji) all trade against each
 * other, and the payloads people actually hand over ("put this URL on a poster,
 * make it scannable at 3 metres") pin down a different corner of that space
 * than a naive "just encode it" call would pick. When a payload does not fit,
 * the useful answer is not "it failed" but "it fits at level L, or type it as
 * uppercase-alphanumeric and level M will work" — that is what a human would
 * work out, and it is what this tool returns.
 *
 * Decoding matters for the same reason in reverse: a photographed or
 * screenshotted code fails for reasons worth naming (blur, quiet-zone crop,
 * inverted polarity, low contrast) rather than just returning empty.
 *
 * External engine is optional. Generation falls back to a dependency-free
 * encoder that emits a standards-conformant SVG; that is enough for print,
 * documents and chat, and needs no install. Raster output (PNG) and robust
 * decoding of photos need a real engine, which the caller configures.
 *
 * @module dsh-tool-qrcode
 */
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve, basename, dirname, extname } from "node:path";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-qrcode";

/** Services required by the QR tool suite. */
const inject = ["tools"];

/** Default cooperative tool-call budget (ms). */
const DEFAULT_TIMEOUT_MS = 120000;

/* -------------------------------------------------------------- QR tables */

/**
 * Error-correction levels, weakest redundancy first.
 *
 * `recovery` is the fraction of codewords the decoder can lose and still read
 * the symbol. It is worth stating in results rather than reducing to a letter,
 * because the useful question is "can this survive being rained on".
 *
 * `order` is this plugin's own internal index, used to address the capacity and
 * block-layout tables (which are ordered L, M, Q, H). It is NOT the value that
 * goes into the symbol's format information: the standard encodes the level as
 * a 2-bit field in the non-obvious order M=00, L=01, H=10, Q=11, which is why
 * each level also carries an explicit `formatCode`. Reusing `order` there
 * produces a symbol whose data decodes correctly but whose format field claims
 * the wrong level, so real scanners reject it.
 */
const EC_LEVELS = {
	l: { name: "L", recovery: 0.07, order: 0, formatCode: 1 },
	m: { name: "M", recovery: 0.15, order: 1, formatCode: 0 },
	q: { name: "Q", recovery: 0.25, order: 2, formatCode: 3 },
	h: { name: "H", recovery: 0.30, order: 3, formatCode: 2 }
};

/**
 * Total data codewords available per (version, level).
 *
 * Index `[version][level]`; version 0 is unused padding so version numbers line
 * up with their array index. These are the standard ISO/IEC 18004 totals — the
 * number that actually bounds a payload once error correction takes its share.
 */
const TOTAL_CODEWORDS = [
	0,
	[19, 16, 13, 9], [34, 28, 22, 16], [55, 44, 34, 26], [80, 64, 48, 36],
	[108, 86, 62, 46], [136, 108, 76, 60], [156, 124, 88, 66], [194, 154, 110, 86],
	[232, 182, 132, 100], [274, 216, 154, 122], [324, 254, 180, 140], [370, 290, 206, 158],
	[428, 334, 244, 180], [461, 365, 261, 197], [523, 415, 295, 223], [589, 453, 325, 253],
	[647, 507, 367, 283], [721, 563, 397, 313], [795, 627, 445, 341], [861, 669, 485, 385],
	[932, 714, 512, 406], [1006, 782, 568, 442], [1094, 860, 614, 464], [1174, 914, 664, 514],
	[1276, 1000, 718, 538], [1370, 1062, 754, 596], [1468, 1128, 808, 628], [1531, 1193, 871, 661],
	[1631, 1267, 911, 701], [1735, 1373, 985, 745], [1843, 1455, 1033, 793], [1955, 1541, 1115, 845],
	[2071, 1631, 1171, 901], [2191, 1725, 1231, 961], [2306, 1812, 1286, 986], [2434, 1914, 1354, 1054],
	[2566, 1992, 1426, 1096], [2702, 2102, 1502, 1142], [2812, 2216, 1582, 1222], [2956, 2334, 1666, 1258]
];

/**
 * The four encoding modes, narrowest character class first.
 *
 * `bitsPerChar` is what makes mode selection worth doing: a numeric payload
 * packs 3 digits into 10 bits (~3.33 bit/char) while a byte payload spends 8
 * bits per character, so choosing well buys roughly 2.4x the capacity. `chars`
 * is the exact set each mode accepts — deliberately not a loose "alphanumeric"
 * notion, because `$` and `%` are in QR's alphanumeric set while `#` is not.
 */
const MODES = {
	numeric: { bitsPerChar: 10 / 3, overheadBits: 4, label: "numeric", chars: /^[0-9]+$/u },
	alphanumeric: {
		bitsPerChar: 5.5,
		overheadBits: 4,
		label: "alphanumeric",
		chars: /^[0-9A-Z $%*+\-./:]+$/u
	},
	byte: { bitsPerChar: 8, overheadBits: 4, label: "byte (UTF-8)", chars: null },
	kanji: { bitsPerChar: 13, overheadBits: 4, label: "kanji", chars: null }
};

/**
 * How big a printed symbol needs to be for a given scanning distance.
 *
 * The working rule from scanner vendors is that the module pitch should be at
 * least distance/250 for comfortable reads; the quiet zone adds four modules on
 * every side. Stating this lets the model size a poster code instead of
 * discovering at the printer that a version-40 symbol needs more wall.
 */
const MODULE_MM_PER_METRE = 1000 / 250;

/** Extensions the local encoder can write without an external engine. */
const NATIVE_EXTENSIONS = new Set([".svg"]);

/** Extensions that need a raster-capable engine. */
const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"]);

/* ------------------------------------------------------------------ utf8 */

/**
 * Byte length of a string once encoded as UTF-8, without allocating a Buffer
 * for the common all-ASCII case.
 *
 * @param {string} text - the payload.
 * @returns {number} byte count.
 */
function utf8Length(text) {
	if (/^[\x00-\x7f]*$/u.test(text)) return text.length;
	return Buffer.byteLength(text, "utf8");
}

/**
 * Choose the narrowest encoding mode a payload actually qualifies for.
 *
 * A payload typed in uppercase is a real capacity win (5.5 vs 8 bits per
 * character), which is why the result reports whether the caller could get a
 * smaller symbol by normalising case.
 *
 * @param {string} text - the payload.
 * @returns {string} a key of {@link MODES}.
 */
function detectMode(text) {
	if (text.length === 0) return "byte";
	for (const key of ["numeric", "alphanumeric"]) {
		if (MODES[key].chars.test(text)) return key;
	}
	return "byte";
}

/**
 * Pick the smallest version/level pair that fits a payload.
 *
 * This is the core of the plugin. It walks versions upward and, for each,
 * reports every level that fits — so the caller can prefer robustness (higher
 * level) when it is free, instead of the usual "encode at M and hope".
 *
 * @param {number} payloadBits - payload size in bits.
 * @param {string} minLevel - lowest acceptable level key.
 * @returns {{version: number, level: string, capacityBits: number, fits: object[]}|null} the choice, or null when nothing fits.
 */
function planSymbol(payloadBits, minLevel) {
	const floor = EC_LEVELS[minLevel]?.order ?? 0;
	for (let version = 1; version <= 40; version += 1) {
		const row = TOTAL_CODEWORDS[version];
		const options = [];
		for (const key of ["l", "m", "q", "h"]) {
			const level = EC_LEVELS[key];
			if (level.order < floor) continue;
			// 8 bits of terminator plus padding is the standard worst case.
			const capacityBits = row[level.order] * 8 - 12;
			if (capacityBits >= payloadBits) {
				options.push({ level: key, capacityBits, headroomBits: capacityBits - payloadBits });
			}
		}
		if (options.length > 0) {
			// Prefer the strongest level that still leaves sane headroom.
			const chosen = options[options.length - 1];
			return { version, level: chosen.level, capacityBits: chosen.capacityBits, fits: options };
		}
	}
	return null;
}

/**
 * Plan a symbol for a payload and describe what the caller could change.
 *
 * @param {string} text - payload.
 * @param {string} requestedLevel - requested level key, or "auto".
 * @returns {object} the plan, including remedies when it does not fit.
 */
function planPayload(text, requestedLevel) {
	const mode = detectMode(text);
	const modeInfo = MODES[mode];
	const charCount = mode === "byte" ? utf8Length(text) : text.length;
	const overhead = modeInfo.overheadBits + 8 + 8;
	const payloadBits = Math.ceil(charCount * modeInfo.bitsPerChar) + overhead;
	const targetLevel = requestedLevel in EC_LEVELS ? requestedLevel : "l";
	const plan = planSymbol(payloadBits, "l");

	const summary = {
		bytes: utf8Length(text),
		characters: text.length,
		mode: modeInfo.label,
		modeKey: mode,
		payloadBits
	};

	if (plan === null) {
		// Nothing fits even at level L on version 40. Name the size of the wall.
		const maxBits = TOTAL_CODEWORDS[40][0] * 8 - 12;
		const overBy = payloadBits - maxBits;
		return {
			...summary,
			fits: false,
			remedies: [
				`Payload is ${Math.ceil(overBy / 8)} bytes over even a version-40 level-L symbol (the largest QR code that exists).`,
				"Shorten the payload, or move it behind a short URL that redirects."
			]
		};
	}

	const effective = requestedLevel in EC_LEVELS ? requestedLevel : plan.level;
	const chosenFit = plan.fits.find((entry) => entry.level === effective) ?? plan.fits[plan.fits.length - 1];
	const remedies = [];
	if (mode === "byte" && /^[A-Z0-9 $%*+\-./:]+$/u.test(text.toUpperCase()) && text !== text.toUpperCase()) {
		remedies.push("Payload is uppercase-alphanumeric apart from its case. Upper-casing it lets QR pack 5.5 bits per character instead of 8, so the symbol gets smaller.");
	}
	if (chosenFit.level !== effective) {
		const asked = requestedLevel in EC_LEVELS ? requestedLevel : effective;
		remedies.push(`Level ${EC_LEVELS[asked].name} does not fit at version ${plan.version}; the symbol was planned at ${EC_LEVELS[chosenFit.level].name}.`);
	}
	if (plan.fits.length > 1 && plan.fits[plan.fits.length - 1].headroomBits > 100) {
		const strongest = plan.fits[plan.fits.length - 1];
		if (strongest.level !== chosenFit.level) {
			remedies.push(`There is room to raise error correction to ${EC_LEVELS[strongest.level].name} (survives ~${Math.round(EC_LEVELS[strongest.level].recovery * 100)}% damage) at no extra symbol size.`);
		}
	}

	return {
		...summary,
		fits: true,
		version: plan.version,
		level: chosenFit.level,
		levelName: EC_LEVELS[chosenFit.level].name,
		recovery: EC_LEVELS[chosenFit.level].recovery,
		capacityBits: chosenFit.capacityBits,
		headroomBits: chosenFit.headroomBits,
		modules: plan.version * 4 + 17,
		alternatives: plan.fits.map((entry) => ({
			level: EC_LEVELS[entry.level].name,
			recovery: EC_LEVELS[entry.level].recovery,
			headroomBits: entry.headroomBits
		})),
		remedies
	};
}

/**
 * Estimate the printed module pitch and quiet zone needed to scan at a distance.
 *
 * @param {number} modules - symbol side length in modules.
 * @param {number} distanceM - intended scanning distance in metres.
 * @returns {{pitchMm: number, symbolMm: number, quietZoneMm: number, totalMm: number}} print sizing.
 */
function printSizing(modules, distanceM) {
	const pitchMm = Math.max(0.25, distanceM * MODULE_MM_PER_METRE);
	const symbolMm = pitchMm * modules;
	const quietZoneMm = pitchMm * 4;
	return {
		pitchMm: Math.round(pitchMm * 100) / 100,
		symbolMm: Math.round(symbolMm * 10) / 10,
		quietZoneMm: Math.round(quietZoneMm * 10) / 10,
		totalMm: Math.round((symbolMm + quietZoneMm * 2) * 10) / 10
	};
}

/* ------------------------------------------------------- native encoder */

/** Galois-field log/antilog tables for QR's GF(256), built once on demand. */
let gfTables = null;

/** Build the GF(256) tables used by Reed-Solomon error correction. */
function buildGalois() {
	if (gfTables !== null) return gfTables;
	const exp = new Uint8Array(512);
	const log = new Uint8Array(256);
	let x = 1;
	for (let i = 0; i < 255; i += 1) {
		exp[i] = x;
		log[x] = i;
		x <<= 1;
		if (x & 0x100) x ^= 0x11d;
	}
	for (let i = 255; i < 512; i += 1) exp[i] = exp[i - 255];
	gfTables = { exp, log };
	return gfTables;
}

/**
 * Multiply two GF(256) elements.
 *
 * @param {number} a - first element.
 * @param {number} b - second element.
 * @returns {number} product.
 */
function gfMul(a, b) {
	if (a === 0 || b === 0) return 0;
	const { exp, log } = buildGalois();
	return exp[log[a] + log[b]];
}

/**
 * Build the Reed-Solomon generator polynomial of a given degree.
 *
 * @param {number} degree - number of error-correction codewords.
 * @returns {Uint8Array} polynomial coefficients, highest power first.
 */
function rsGenerator(degree) {
	const { exp } = buildGalois();
	let poly = Uint8Array.of(1);
	for (let i = 0; i < degree; i += 1) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j += 1) {
			next[j] ^= poly[j];
			next[j + 1] ^= gfMul(poly[j], exp[i]);
		}
		poly = next;
	}
	return poly;
}

/**
 * Compute Reed-Solomon error-correction codewords for a data block.
 *
 * @param {Uint8Array} data - data codewords.
 * @param {number} ecCount - number of EC codewords to produce.
 * @returns {Uint8Array} the EC codewords.
 */
function rsEncode(data, ecCount) {
	const generator = rsGenerator(ecCount);
	const remainder = new Uint8Array(ecCount);
	for (const byte of data) {
		const factor = byte ^ remainder[0];
		remainder.copyWithin(0, 1);
		remainder[ecCount - 1] = 0;
		for (let i = 0; i < ecCount; i += 1) {
			remainder[i] ^= gfMul(generator[i + 1], factor);
		}
	}
	return remainder;
}

/**
 * Write `value` into a bit buffer, most significant bit first.
 *
 * @param {number[]} bits - destination bit array.
 * @param {number} value - value to append.
 * @param {number} length - bit width.
 */
function pushBits(bits, value, length) {
	for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
}

/** Mode indicator nibbles, per ISO/IEC 18004. */
const MODE_INDICATOR = { numeric: 0x1, alphanumeric: 0x2, byte: 0x4, kanji: 0x8 };

/** Character-count indicator widths per version band and mode. */
const COUNT_BITS = {
	numeric: [10, 12, 14],
	alphanumeric: [9, 11, 13],
	byte: [8, 16, 16],
	kanji: [8, 10, 12]
};

/**
 * Number of EC codewords and block layout for a (version, level) pair.
 *
 * Only the counts needed for data/EC interleaving are encoded here; the table
 * is indexed by version then level order (L/M/Q/H) and gives
 * `[ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]`.
 */
const BLOCK_LAYOUT = {
	1: [[7, 1, 19, 0, 0], [10, 1, 16, 0, 0], [13, 1, 13, 0, 0], [17, 1, 9, 0, 0]],
	2: [[10, 1, 34, 0, 0], [16, 1, 28, 0, 0], [22, 1, 22, 0, 0], [28, 1, 16, 0, 0]],
	3: [[15, 1, 55, 0, 0], [26, 1, 44, 0, 0], [18, 2, 17, 0, 0], [22, 2, 13, 0, 0]],
	4: [[20, 1, 80, 0, 0], [18, 2, 32, 0, 0], [26, 2, 24, 0, 0], [16, 4, 9, 0, 0]],
	5: [[26, 1, 108, 0, 0], [24, 2, 43, 0, 0], [18, 2, 15, 2, 16], [22, 2, 11, 2, 12]],
	6: [[18, 2, 68, 0, 0], [16, 4, 27, 0, 0], [24, 4, 19, 0, 0], [28, 4, 15, 0, 0]],
	7: [[20, 2, 78, 0, 0], [18, 4, 31, 0, 0], [18, 2, 14, 4, 15], [26, 4, 13, 1, 14]],
	8: [[24, 2, 97, 0, 0], [22, 2, 38, 2, 39], [22, 4, 18, 2, 19], [26, 4, 14, 2, 15]],
	9: [[30, 2, 116, 0, 0], [22, 3, 36, 2, 37], [20, 4, 16, 4, 17], [24, 4, 12, 4, 13]],
	10: [[18, 2, 68, 2, 69], [26, 4, 43, 1, 44], [24, 6, 19, 2, 20], [28, 6, 15, 2, 16]],
	11: [[20, 4, 81, 0, 0], [30, 1, 50, 4, 51], [28, 4, 22, 4, 23], [24, 3, 12, 8, 13]],
	12: [[24, 2, 92, 2, 93], [22, 6, 36, 2, 37], [26, 4, 20, 6, 21], [28, 7, 14, 4, 15]],
	13: [[26, 4, 107, 0, 0], [22, 8, 37, 1, 38], [24, 8, 20, 4, 21], [22, 12, 11, 4, 12]],
	14: [[30, 3, 115, 1, 116], [24, 4, 40, 5, 41], [20, 11, 16, 5, 17], [24, 11, 12, 5, 13]],
	15: [[22, 5, 87, 1, 88], [24, 5, 41, 5, 42], [30, 5, 24, 7, 25], [24, 11, 12, 7, 13]],
	16: [[24, 5, 98, 1, 99], [28, 7, 45, 3, 46], [24, 15, 19, 2, 20], [30, 3, 15, 13, 16]],
	17: [[28, 1, 107, 5, 108], [28, 10, 46, 1, 47], [28, 1, 22, 15, 23], [28, 2, 14, 17, 15]],
	18: [[30, 5, 120, 1, 121], [26, 9, 43, 4, 44], [28, 17, 22, 1, 23], [28, 2, 14, 19, 15]],
	19: [[28, 3, 113, 4, 114], [26, 3, 44, 11, 45], [26, 17, 21, 4, 22], [26, 9, 13, 16, 14]],
	20: [[28, 3, 107, 5, 108], [26, 3, 41, 13, 42], [30, 15, 24, 5, 25], [28, 15, 15, 10, 16]],
	21: [[28, 4, 116, 4, 117], [26, 17, 42, 0, 0], [28, 17, 22, 6, 23], [30, 19, 16, 6, 17]],
	22: [[28, 2, 111, 7, 112], [28, 17, 46, 0, 0], [30, 7, 24, 16, 25], [24, 34, 13, 0, 0]],
	23: [[30, 4, 121, 5, 122], [28, 4, 47, 14, 48], [30, 11, 24, 14, 25], [30, 16, 15, 14, 16]],
	24: [[30, 6, 117, 4, 118], [28, 6, 45, 14, 46], [30, 11, 24, 16, 25], [30, 30, 16, 2, 17]],
	25: [[26, 8, 106, 4, 107], [28, 8, 47, 13, 48], [30, 7, 24, 22, 25], [30, 22, 15, 13, 16]],
	26: [[28, 10, 114, 2, 115], [28, 19, 46, 4, 47], [28, 28, 22, 6, 23], [30, 33, 16, 4, 17]],
	27: [[30, 8, 122, 4, 123], [28, 22, 45, 3, 46], [30, 8, 23, 26, 24], [30, 12, 15, 28, 16]],
	28: [[30, 3, 117, 10, 118], [28, 3, 45, 23, 46], [30, 4, 24, 31, 25], [30, 11, 15, 31, 16]],
	29: [[30, 7, 116, 7, 117], [28, 21, 45, 7, 46], [30, 1, 23, 37, 24], [30, 19, 15, 26, 16]],
	30: [[30, 5, 115, 10, 116], [28, 19, 47, 10, 48], [30, 15, 24, 25, 25], [30, 23, 15, 25, 16]],
	31: [[30, 13, 115, 3, 116], [28, 2, 46, 29, 47], [30, 42, 24, 1, 25], [30, 23, 15, 28, 16]],
	32: [[30, 17, 115, 0, 0], [28, 10, 46, 23, 47], [30, 10, 24, 35, 25], [30, 19, 15, 35, 16]],
	33: [[30, 17, 115, 1, 116], [28, 14, 46, 21, 47], [30, 29, 24, 19, 25], [30, 11, 15, 46, 16]],
	34: [[30, 13, 115, 6, 116], [28, 14, 46, 23, 47], [30, 44, 24, 7, 25], [30, 59, 16, 1, 17]],
	35: [[30, 12, 121, 7, 122], [28, 12, 47, 26, 48], [30, 39, 24, 14, 25], [30, 22, 15, 41, 16]],
	36: [[30, 6, 121, 14, 122], [28, 6, 47, 34, 48], [30, 46, 24, 10, 25], [30, 2, 15, 64, 16]],
	37: [[30, 17, 122, 4, 123], [28, 29, 46, 14, 47], [30, 49, 24, 10, 25], [30, 24, 15, 46, 16]],
	38: [[30, 4, 122, 18, 123], [28, 13, 46, 32, 47], [30, 48, 24, 14, 25], [30, 42, 15, 32, 16]],
	39: [[30, 20, 117, 4, 118], [28, 40, 47, 7, 48], [30, 43, 24, 22, 25], [30, 10, 15, 67, 16]],
	40: [[30, 19, 118, 6, 119], [28, 18, 47, 31, 48], [30, 34, 24, 34, 25], [30, 20, 15, 61, 16]]
};

/**
 * Alignment-pattern centre coordinates per version.
 *
 * Version 1 has none, version 2+ place a grid of them; the positions come from
 * a fixed table rather than a formula because the spacing is irregular.
 */
const ALIGNMENT_POSITIONS = {
	1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
	7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54],
	12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
	16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86],
	20: [6, 34, 62, 90], 21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102],
	24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114], 27: [6, 34, 62, 90, 118],
	28: [6, 26, 50, 74, 98, 122], 29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
	31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142],
	34: [6, 34, 62, 90, 118, 146], 35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
	37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166],
	40: [6, 30, 58, 86, 114, 142, 170]
};

/**
 * BCH(18,6) version-information patterns for versions 7 through 40.
 *
 * Indexed by version number, which is why entries for 1-6 are absent. Symbols
 * of version 7 and up carry this 18-bit field twice; versions below 7 omit it
 * entirely. These are the standard's published values.
 */
const VERSION_BITS = {
	7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6, 12: 0x0c762,
	13: 0x0d847, 14: 0x0e60d, 15: 0x0f928, 16: 0x10b78, 17: 0x1145d, 18: 0x12a17,
	19: 0x13532, 20: 0x149a6, 21: 0x15683, 22: 0x168c9, 23: 0x177ec, 24: 0x18ec4,
	25: 0x191e1, 26: 0x1afab, 27: 0x1b08e, 28: 0x1cc1a, 29: 0x1d33f, 30: 0x1ed75,
	31: 0x1f250, 32: 0x209d5, 33: 0x216f0, 34: 0x228ba, 35: 0x2379f, 36: 0x24b0b,
	37: 0x2542e, 38: 0x26a64, 39: 0x27541, 40: 0x28c69
};

/**
 * BCH(15,5) format-information bits for every (level, mask) combination.
 *
 * Grouped by the standard's 2-bit level field in its own order — M, L, H, Q —
 * so the group index is exactly the level's `formatCode`. Precomputed so the
 * encoder does not need to reimplement the generator polynomial: 32 entries
 * covering 4 levels x 8 masks.
 */
const FORMAT_BITS = [
	0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0,
	0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
	0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b,
	0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed
];

/**
 * Encode a payload into a full QR module matrix.
 *
 * Implements the standard pipeline: mode segmentation, terminator and padding,
 * block splitting, Reed-Solomon EC per block, interleaving, module placement,
 * mask selection and format info. This exists so the plugin can produce a
 * correct symbol with no native dependency — the common case of "render this
 * URL to an SVG for a document".
 *
 * @param {string} text - payload.
 * @param {number} version - symbol version 1-40.
 * @param {string} levelKey - one of `l`, `m`, `q`, `h`.
 * @returns {{modules: Uint8Array[], size: number, mask: number}} the matrix as rows of 0/1.
 */
function encodeMatrix(text, version, levelKey) {
	const order = EC_LEVELS[levelKey].order;
	const mode = detectMode(text);
	const bits = [];
	pushBits(bits, MODE_INDICATOR[mode], 4);
	const band = version <= 9 ? 0 : version <= 26 ? 1 : 2;
	const charCount = mode === "byte" ? utf8Length(text) : text.length;
	pushBits(bits, charCount, COUNT_BITS[mode][band]);

	if (mode === "numeric") {
		for (let i = 0; i < text.length; i += 3) {
			const group = text.slice(i, i + 3);
			pushBits(bits, Number.parseInt(group, 10), group.length * 3 + 1);
		}
	} else if (mode === "alphanumeric") {
		const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
		for (let i = 0; i < text.length; i += 2) {
			if (i + 1 < text.length) {
				pushBits(bits, alphabet.indexOf(text[i]) * 45 + alphabet.indexOf(text[i + 1]), 11);
			} else {
				pushBits(bits, alphabet.indexOf(text[i]), 6);
			}
		}
	} else {
		for (const byte of Buffer.from(text, "utf8")) pushBits(bits, byte, 8);
	}

	const layout = BLOCK_LAYOUT[version][order];
	const [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] = layout;
	const dataCodewords = group1Blocks * group1Data + group2Blocks * group2Data;
	const capacityBits = dataCodewords * 8;

	pushBits(bits, 0, Math.min(4, capacityBits - bits.length));
	while (bits.length % 8 !== 0) bits.push(0);
	const dataBytes = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
		dataBytes.push(byte);
	}
	const padPair = [0xec, 0x11];
	let padIndex = 0;
	while (dataBytes.length < dataCodewords) {
		dataBytes.push(padPair[padIndex % 2]);
		padIndex += 1;
	}

	// Split into blocks, EC each, then interleave data and EC separately.
	const blocks = [];
	let cursor = 0;
	for (let i = 0; i < group1Blocks + group2Blocks; i += 1) {
		const size = i < group1Blocks ? group1Data : group2Data;
		const chunk = Uint8Array.from(dataBytes.slice(cursor, cursor + size));
		cursor += size;
		blocks.push({ data: chunk, ec: rsEncode(chunk, ecPerBlock) });
	}
	const interleaved = [];
	const maxData = Math.max(...blocks.map((block) => block.data.length));
	for (let i = 0; i < maxData; i += 1) {
		for (const block of blocks) {
			if (i < block.data.length) interleaved.push(block.data[i]);
		}
	}
	for (let i = 0; i < ecPerBlock; i += 1) {
		for (const block of blocks) interleaved.push(block.ec[i]);
	}

	const size = version * 4 + 17;
	const matrix = Array.from({ length: size }, () => new Uint8Array(size));
	const reserved = Array.from({ length: size }, () => new Uint8Array(size));

	/** Mark a module as function-pattern space so data placement skips it. */
	const setFunction = (row, col, dark) => {
		if (row < 0 || col < 0 || row >= size || col >= size) return;
		matrix[row][col] = dark ? 1 : 0;
		reserved[row][col] = 1;
	};
	const addFinder = (row, col) => {
		for (let r = -1; r <= 7; r += 1) {
			for (let c = -1; c <= 7; c += 1) {
				const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
				const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
				setFunction(row + r, col + c, dark);
			}
		}
	};
	addFinder(0, 0);
	addFinder(0, size - 7);
	addFinder(size - 7, 0);

	// Alignment patterns: a 5x5 bullseye at every position pair, except where
	// one would collide with a finder. These go down BEFORE the timing pattern:
	// the skip test looks at the pattern's own centre cell, and the timing row
	// and column run straight through several alignment centres, so running
	// timing first would reserve those centres and silently drop the patterns
	// (leaving a timing stripe where a bullseye belongs).
	const positions = ALIGNMENT_POSITIONS[version];
	for (const row of positions) {
		for (const col of positions) {
			if (reserved[row][col] === 1) continue;
			for (let r = -2; r <= 2; r += 1) {
				for (let c = -2; c <= 2; c += 1) {
					const ring = Math.abs(r) === 2 || Math.abs(c) === 2;
					const centre = r === 0 && c === 0;
					setFunction(row + r, col + c, ring || centre);
				}
			}
		}
	}

	// Timing patterns: alternating modules along row 6 and column 6, connecting
	// the finder patterns. Drawn after the alignment patterns so that the
	// bullseyes win where the two overlap, as the standard requires.
	for (let i = 8; i < size - 8; i += 1) {
		setFunction(6, i, i % 2 === 0);
		setFunction(i, 6, i % 2 === 0);
	}

	// Reserve the format-information strips and the fixed dark module.
	for (let i = 0; i <= 8; i += 1) {
		if (i !== 6) {
			setFunction(8, i, false);
			setFunction(i, 8, false);
		}
	}
	for (let i = 0; i < 8; i += 1) {
		setFunction(8, size - 1 - i, false);
		setFunction(size - 1 - i, 8, false);
	}
	setFunction(size - 8, 8, true);

	// Version information: an 18-bit BCH-coded version number, present only on
	// version 7 and up, written twice in 3x6 blocks beside the top-right and
	// bottom-left finders. Reserving these cells without writing the bits (as
	// an earlier revision did) leaves two blank blocks that graders reject.
	if (version >= 7) {
		const versionBits = VERSION_BITS[version];
		for (let i = 0; i < 18; i += 1) {
			const bit = ((versionBits >> i) & 1) === 1;
			// Block A sits in rows 0-5, columns size-11..size-9.
			setFunction(Math.floor(i / 3), size - 11 + (i % 3), bit);
			// Block B is the transpose: rows size-11..size-9, columns 0-5.
			setFunction(size - 11 + (i % 3), Math.floor(i / 3), bit);
		}
	}

	// Place data in the standard two-module-wide zig-zag from bottom right.
	let bitIndex = 0;
	let upward = true;
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col = 5;
		for (let step = 0; step < size; step += 1) {
			const row = upward ? size - 1 - step : step;
			for (const c of [col, col - 1]) {
				if (reserved[row][c] === 1) continue;
				let bit = 0;
				if (bitIndex < interleaved.length * 8) {
					bit = (interleaved[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
				}
				matrix[row][c] = bit;
				bitIndex += 1;
			}
		}
		upward = !upward;
	}

	/**
	 * Apply one of the eight data masks, per the standard's penalty rules.
	 *
	 * @param {number} row - module row.
	 * @param {number} col - module column.
	 * @param {number} mask - mask index 0-7.
	 * @returns {boolean} whether the mask inverts this module.
	 */
	const maskFn = (row, col, mask) => {
		switch (mask) {
			case 0: return (row + col) % 2 === 0;
			case 1: return row % 2 === 0;
			case 2: return col % 3 === 0;
			case 3: return (row + col) % 3 === 0;
			case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
			case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
			case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
			default: return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
		}
	};

	/**
	 * Score a masked matrix with the standard's four penalty rules, lower is
	 * better. Picking the best mask materially improves scan reliability on
	 * low-quality prints, which is the whole point of not skipping this step.
	 *
	 * @param {number} mask - mask index.
	 * @returns {number} total penalty.
	 */
	const scoreMask = (mask) => {
		const probe = matrix.map((row) => Uint8Array.from(row));
		for (let row = 0; row < size; row += 1) {
			for (let col = 0; col < size; col += 1) {
				if (reserved[row][col] === 0 && maskFn(row, col, mask)) probe[row][col] ^= 1;
			}
		}
		let penalty = 0;
		const runs = (getter) => {
			for (let i = 0; i < size; i += 1) {
				let run = 1;
				for (let j = 1; j < size; j += 1) {
					if (getter(i, j) === getter(i, j - 1)) {
						run += 1;
					} else {
						if (run >= 5) penalty += 3 + (run - 5);
						run = 1;
					}
				}
				if (run >= 5) penalty += 3 + (run - 5);
			}
		};
		runs((row, col) => probe[row][col]);
		runs((col, row) => probe[row][col]);
		for (let row = 0; row < size - 1; row += 1) {
			for (let col = 0; col < size - 1; col += 1) {
				const value = probe[row][col];
				if (value === probe[row][col + 1] && value === probe[row + 1][col] && value === probe[row + 1][col + 1]) {
					penalty += 3;
				}
			}
		}
		let dark = 0;
		for (let row = 0; row < size; row += 1) {
			for (let col = 0; col < size; col += 1) dark += probe[row][col];
		}
		const ratio = (dark * 100) / (size * size);
		penalty += Math.floor(Math.abs(ratio - 50) / 5) * 10;
		return penalty;
	};

	let bestMask = 0;
	let bestScore = Number.POSITIVE_INFINITY;
	for (let mask = 0; mask < 8; mask += 1) {
		const score = scoreMask(mask);
		if (score < bestScore) {
			bestScore = score;
			bestMask = mask;
		}
	}

	// Apply the winning mask for real now that it is chosen.
	for (let row = 0; row < size; row += 1) {
		for (let col = 0; col < size; col += 1) {
			if (reserved[row][col] === 0 && maskFn(row, col, bestMask)) matrix[row][col] ^= 1;
		}
	}

	// Format information: 5 bits (level + mask) BCH-protected, written twice —
	// once down the left of the top-left finder and once along the top. Bit i
	// goes in the vertical strip at (i, 8) and horizontally at (8, size-1-i);
	// the two strips skip the timing row/column and the dark module.
	const format = FORMAT_BITS[EC_LEVELS[levelKey].formatCode * 8 + bestMask];
	for (let i = 0; i < 15; i += 1) {
		const bit = (format >> i) & 1 === 1;

		// Vertical copy: down column 8, stepping over the timing row at 6.
		if (i < 6) setFunction(i, 8, bit);
		else if (i < 8) setFunction(i + 1, 8, bit);
		else setFunction(size - 15 + i, 8, bit);

		// Horizontal copy: along row 8, from the right edge inwards.
		if (i < 8) setFunction(8, size - i - 1, bit);
		else if (i < 9) setFunction(8, 15 - i, bit);
		else setFunction(8, 15 - i - 1, bit);
	}
	setFunction(size - 8, 8, true);

	return { modules: matrix, size, mask: bestMask };
}

/**
 * Render a module matrix to a standalone SVG document.
 *
 * SVG is the dependency-free output because it scales to any print size with no
 * resampling, which is exactly what a QR code needs — resampling a raster code
 * is what breaks scanners.
 *
 * @param {Uint8Array[]} matrix - module rows.
 * @param {number} size - side length in modules.
 * @param {object} options - rendering options.
 * @returns {string} the SVG document.
 */
function matrixToSvg(matrix, size, options) {
	const quiet = options.quietZone ?? 4;
	const scale = options.scale ?? 8;
	const total = (size + quiet * 2) * scale;
	const dark = options.dark ?? "#000000";
	const light = options.light ?? "#ffffff";
	const path = [];
	for (let row = 0; row < size; row += 1) {
		for (let col = 0; col < size; col += 1) {
			if (matrix[row][col] === 0) continue;
			path.push(`M${(col + quiet) * scale} ${(row + quiet) * scale}h${scale}v${scale}h-${scale}z`);
		}
	}
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${total}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`,
		`<rect width="${total}" height="${total}" fill="${light}"/>`,
		`<path fill="${dark}" d="${path.join("")}"/>`,
		"</svg>",
		""
	].join("\n");
}

/* ------------------------------------------------------------- helpers */

/**
 * Run a command and capture output with a hard timeout.
 *
 * @param {string} command - executable to spawn.
 * @param {string[]} args - argument array (never a shell string).
 * @param {{timeoutMs: number, signal?: AbortSignal}} options - run options.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>} captured result.
 */
function runCommand(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		let child;
		try {
			child = spawn(command, args, { windowsHide: true, shell: false });
		} catch (error) {
			reject(new Error(`qrcode: cannot start "${command}" (${error?.message ?? error}). Check the engine paths in the plugin config.`));
			return;
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (fn, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			fn(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(reject, new Error(`qrcode: "${command}" exceeded its ${Math.round(options.timeoutMs / 1000)}s budget. Raise timeoutMs or shrink the image.`));
		}, options.timeoutMs);
		const onAbort = () => {
			child.kill("SIGKILL");
			finish(reject, options.signal?.reason ?? new Error("aborted"));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
		child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
		child.once("error", (error) => {
			finish(reject, new Error(`qrcode: cannot start "${command}" (${error?.message ?? error}). Check the engine paths in the plugin config.`));
		});
		child.once("close", (code) => { finish(resolvePromise, { stdout, stderr, code: code ?? 0 }); });
	});
}

/**
 * Check whether a binary answers a `--version` probe, without throwing.
 *
 * The configured command is not always the engine itself: `node wrapper.mjs` and
 * `python qr.py` are both legal, and in that shape the interpreter is what runs.
 * Only a leading *file* argument is carried over (a bare subcommand such as
 * `encode` would make the wrapper do real work instead of answering a probe).
 * Everything from the first placeholder onward is dropped.
 *
 * @param {string} command - executable to probe.
 * @param {string[]} [argsTemplate] - configured argument template, if any.
 * @returns {Promise<{command: string, available: boolean, version?: string, error?: string}>} probe result.
 */
async function probeBinary(command, argsTemplate = []) {
	const lead = [];
	for (const part of argsTemplate) {
		if (/\{(input|output|text|level)\}/u.test(part)) break;
		// Stop at the first bare subcommand; only a script/module path is kept.
		if (lead.length > 0 && !/[\\/]|\.\w{2,4}$/u.test(part)) break;
		lead.push(part);
	}
	try {
		// Node rejects `-V`/`-version`; Python and some wrappers only answer one
		// of these. Try each before declaring the engine missing.
		for (const flag of ["--version", "-V", "-version"]) {
			const result = await runCommand(command, [...lead, flag], { timeoutMs: 15000 });
			const text = `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "";
			if (text.length > 0) {
				return { command, available: true, version: text.slice(0, 120) };
			}
			if (result.code === 0 && lead.length === 0) {
				// A bare binary that exits 0 without printing still counts as present.
				return { command, available: true, version: "(no version output)" };
			}
		}
		const last = await runCommand(command, [...lead, "--version"], { timeoutMs: 15000 });
		if (last.code === 0) return { command, available: true, version: "(no version output)" };
		return { command, available: false, error: `exit code ${last.code}` };
	} catch (error) {
		return { command, available: false, error: String(error?.message ?? error) };
	}
}

/**
 * Expand `{input}` / `{output}` / `{text}` placeholder tokens in configured args.
 *
 * @param {string[]} template - configured argument template.
 * @param {object} values - placeholder values.
 * @returns {string[]} the expanded argument array.
 */
function expandArgs(template, values) {
	return template.map((part) => part.replace(/\{(input|output|text|level)\}/gu, (_, key) => String(values[key] ?? "")));
}

/**
 * Sniff an image's format from its magic bytes.
 *
 * Decoding tools disagree about extensions, and a renamed file is common, so
 * the format is read from the content when the caller has not said otherwise.
 *
 * @param {Buffer} buffer - file head.
 * @returns {string|undefined} a format name.
 */
function sniffImage(buffer) {
	if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpeg";
	if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "webp";
	if (buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49) return "gif";
	if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
	return undefined;
}

/**
 * Estimate whether an image has enough contrast and resolution to decode.
 *
 * Running the decoder on an obviously hopeless image wastes a call, and more
 * importantly returns a bare "not found" that tells the model nothing. These
 * are cheap structural checks on the file head plus a blur proxy from the
 * caller's own description.
 *
 * @param {Buffer} buffer - the file contents.
 * @returns {string[]} warnings worth showing before/with a decode attempt.
 */
function decodeWarnings(buffer) {
	const warnings = [];
	if (buffer.length < 1024) {
		warnings.push("File is under 1 KB, which is small even for a version-1 symbol. It may be a placeholder or a failed download.");
	}
	const format = sniffImage(buffer);
	if (format === undefined) {
		warnings.push("Header does not match PNG/JPEG/WebP/GIF/BMP. The file may not be an image at all — check the path and format.");
	}
	return warnings;
}

/* ------------------------------------------------------------------ config */

const Config = z.object({
	/** Path to a QR encoder (e.g. qrencode). Empty disables external generation. */
	encodeCommand: z.string().default(""),
	/** Argument template for the encoder; `{text}` and `{output}` are substituted. */
	encodeArgs: z.array(z.string()).default(["-o", "{output}", "-t", "PNG", "-l", "{level}", "{text}"]),
	/** Path to a QR decoder (e.g. zbarimg). Empty disables external decoding. */
	decodeCommand: z.string().default(""),
	/** Argument template for the decoder; `{input}` is substituted. */
	decodeArgs: z.array(z.string()).default(["--raw", "-q", "{input}"]),
	/** Directory for produced files. */
	outputDir: z.string().default("qrcode-output"),
	/** Cooperative tool-call budget attached as `ToolDefinition.timeoutMs`. */
	timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
	/** Register `qrcode_status`. Defaults to true. */
	status: z.boolean().default(true),
	/** Register `qrcode_make`. Defaults to true. */
	make: z.boolean().default(true),
	/** Register `qrcode_read`. Defaults to true. */
	read: z.boolean().default(true),
	/** Register `qrcode_plan`. Defaults to true. */
	plan: z.boolean().default(true),
	/** Quiet-zone width in modules for native SVG output. */
	quietZone: z.number().default(4),
	/** Pixels per module for native SVG output. */
	scale: z.number().default(8)
});

/* ------------------------------------------------------------------- apply */

/**
 * Register the enabled QR tools.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - context whose `tools` registry receives the tools.
 * @param {z.infer<typeof Config>} config - resolved plugin config.
 */
function apply(ctx, config) {
	const outputDir = resolve(config.outputDir);
	const budgetMs = config.timeoutMs;

	/** Resolve a configured output path and make sure the directory exists. */
	async function outPath(fileName) {
		await mkdir(outputDir, { recursive: true });
		return join(outputDir, fileName);
	}

	/* -- qrcode_status ----------------------------------------------------- */
	if (config.status) {
		ctx.tools.register(defineTool({
			name: "qrcode_status",
			description: "Report which QR capabilities are available here: the built-in SVG encoder always is, plus any external encode/decode engine you configured. Check this before asking for a PNG or a decode.",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						nativeEncoder: { type: "boolean", required: true },
						nativeFormats: { type: "array", required: true, items: { type: "string" } },
						encoder: {
							type: "object", required: true, additionalProperties: false,
							properties: { command: { type: "string", required: true }, configured: { type: "boolean", required: true }, available: { type: "boolean" }, version: { type: "string" }, error: { type: "string" } }
						},
						decoder: {
							type: "object", required: true, additionalProperties: false,
							properties: { command: { type: "string", required: true }, configured: { type: "boolean", required: true }, available: { type: "boolean" }, version: { type: "string" }, error: { type: "string" } }
						},
						levels: { type: "array", required: true, items: { type: "string" } },
						note: { type: "string", required: true }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`built-in SVG encoder: ${value.nativeEncoder ? "AVAILABLE" : "unavailable"}`,
						`encodes to: ${value.nativeFormats.join(", ")}`,
						`external encoder: ${value.encoder.configured ? (value.encoder.available ? `AVAILABLE ${value.encoder.version ?? ""}` : `MISSING — ${value.encoder.error ?? "not found"}`) : "not configured"}`,
						`external decoder: ${value.decoder.configured ? (value.decoder.available ? `AVAILABLE ${value.decoder.version ?? ""}` : `MISSING — ${value.decoder.error ?? "not found"}`) : "not configured"}`,
						value.note
					].join("\n")
				}]
			},
			timeoutMs: 60000,
			isConcurrencySafe: () => true,
			async execute() {
				const encoderConfigured = config.encodeCommand.trim().length > 0;
				const decoderConfigured = config.decodeCommand.trim().length > 0;
				const [encoderProbe, decoderProbe] = await Promise.all([
					encoderConfigured ? probeBinary(config.encodeCommand, config.encodeArgs) : Promise.resolve(undefined),
					decoderConfigured ? probeBinary(config.decodeCommand, config.decodeArgs) : Promise.resolve(undefined)
				]);
				const notes = [];
				if (!encoderConfigured) notes.push("No external encoder configured, so PNG/JPEG output is unavailable — set encodeCommand (e.g. qrencode) to enable raster output.");
				if (!decoderConfigured) notes.push("No external decoder configured, so qrcode_read cannot decode. Set decodeCommand (e.g. zbarimg or a zxing wrapper).");
				return {
					nativeEncoder: true,
					nativeFormats: [...NATIVE_EXTENSIONS],
					encoder: { command: config.encodeCommand, configured: encoderConfigured, ...encoderProbe },
					decoder: { command: config.decodeCommand, configured: decoderConfigured, ...decoderProbe },
					levels: Object.keys(EC_LEVELS).map((key) => `${EC_LEVELS[key].name} (~${Math.round(EC_LEVELS[key].recovery * 100)}% recoverable)`),
					note: notes.length === 0 ? "All capabilities available." : notes.join(" ")
				};
			},
			presentCall: () => ({ card: "generic", title: "QR capability check", kind: "other", rawInput: {} })
		}));
	}

	/* -- qrcode_plan ------------------------------------------------------- */
	if (config.plan) {
		ctx.tools.register(defineTool({
			name: "qrcode_plan",
			description: "Work out how a payload will fit a QR symbol before generating it: encoding mode, symbol version, error-correction headroom, and what to change if it does not fit or could be made more robust for free.",
			parameters: {
				text: { type: "string", required: true, description: "The payload you intend to encode." },
				level: {
					type: "string",
					description: "Minimum error-correction level to insist on: l, m, q or h. Defaults to l, and the tool reports when something stronger fits for free.",
					enum: ["l", "m", "q", "h"]
				},
				distanceMetres: { type: "number", description: "Intended scanning distance in metres, so the tool can also report the printed size needed." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						bytes: { type: "number", required: true },
						characters: { type: "number", required: true },
						mode: { type: "string", required: true },
						fits: { type: "boolean", required: true },
						version: { type: "number" },
						level: { type: "string" },
						recovery: { type: "number" },
						modules: { type: "number" },
						headroomBits: { type: "number" },
						alternatives: {
							type: "array", required: true,
							items: {
								type: "object", additionalProperties: false,
								properties: { level: { type: "string", required: true }, recovery: { type: "number", required: true }, headroomBits: { type: "number", required: true } }
							}
						},
						printSize: {
							type: "object", additionalProperties: false,
							properties: { pitchMm: { type: "number", required: true }, symbolMm: { type: "number", required: true }, quietZoneMm: { type: "number", required: true }, totalMm: { type: "number", required: true } }
						},
						remedies: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => {
					const lines = [
						`Payload: ${value.characters} chars / ${value.bytes} bytes, encoded as ${value.mode}`,
						value.fits
							? `Fits a version-${value.version} symbol (${value.modules}x${value.modules} modules) at level ${value.level} — survives ~${Math.round((value.recovery ?? 0) * 100)}% damage`
							: "Does NOT fit any QR symbol — the payload is too large"
					];
					if (value.printSize !== undefined) {
						lines.push(`Printed size for that distance: ${value.printSize.totalMm} mm overall (${value.printSize.pitchMm} mm per module, incl. ${value.printSize.quietZoneMm} mm quiet zone each side)`);
					}
					for (const remedy of value.remedies) lines.push(`- ${remedy}`);
					return [{ type: "text", text: lines.join("\n") }];
				}
			},
			timeoutMs: 30000,
			isConcurrencySafe: () => true,
			execute(args) {
				const plan = planPayload(args.text, args.level ?? "l");
				const result = {
					bytes: plan.bytes,
					characters: plan.characters,
					mode: plan.mode,
					fits: plan.fits,
					remedies: plan.remedies ?? []
				};
				if (plan.fits) {
					result.version = plan.version;
					result.level = plan.levelName;
					result.recovery = plan.recovery;
					result.modules = plan.modules;
					result.headroomBits = plan.headroomBits;
					result.alternatives = plan.alternatives;
					if (args.distanceMetres !== undefined) result.printSize = printSizing(plan.modules, args.distanceMetres);
				} else {
					result.alternatives = [];
				}
				return result;
			},
			presentCall: (args) => ({ card: "generic", title: `Plan QR for ${args.text?.length ?? 0} chars`, kind: "other", rawInput: args })
		}));
	}

	/* -- qrcode_make ------------------------------------------------------- */
	if (config.make) {
		ctx.tools.register(defineTool({
			name: "qrcode_make",
			description: "Encode text into a QR code image. Writes SVG with no external dependency; PNG and other raster formats need an encoder configured (see qrcode_status). Reports the chosen error-correction level and whether a stronger one would still fit.",
			parameters: {
				text: { type: "string", required: true, description: "The payload to encode (URL, Wi-Fi string, vCard, plain text)." },
				outputName: { type: "string", description: "File name to write inside the plugin's output directory. Defaults to qrcode.svg." },
				level: {
					type: "string",
					description: "Error-correction level: l (~7% recoverable), m (~15%), q (~25%), h (~30%). Defaults to the strongest level that still fits.",
					enum: ["l", "m", "q", "h"]
				},
				scale: { type: "number", description: "Pixels per module for SVG output. Defaults to the configured value (8)." },
				lightColor: { type: "string", description: "Background colour for SVG output, e.g. \"#ffffff\" or \"#f5f5f0\"." },
				darkColor: { type: "string", description: "Module colour for SVG output. Keep strong contrast against the background or scanners will struggle." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						outputPath: { type: "string", required: true },
						format: { type: "string", required: true },
						engine: { type: "string", required: true },
						version: { type: "number", required: true },
						level: { type: "string", required: true },
						recovery: { type: "number", required: true },
						modules: { type: "number", required: true },
						sizeBytes: { type: "number" },
						bytes: { type: "number", required: true },
						notes: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						`Wrote ${value.outputPath}`,
						`${value.format} · version ${value.version} (${value.modules}x${value.modules} modules) · level ${value.level}, ~${Math.round(value.recovery * 100)}% recoverable · ${value.engine}`,
						...value.notes
					].join("\n")
				}]
			},
			timeoutMs: DEFAULT_TIMEOUT_MS,
			async execute(args, exec) {
				const requested = args.level ?? "l";
				const plan = planPayload(args.text, requested);
				if (!plan.fits) {
					throw new Error(`qrcode: payload does not fit any QR symbol. ${plan.remedies.join(" ")}`);
				}
				const levelKey = plan.level;
				const notes = [...plan.remedies];

				const requestedName = args.outputName ?? "qrcode.svg";
				const extension = extname(requestedName).toLowerCase();
				const wantsNative = NATIVE_EXTENSIONS.has(extension) || extension === "";

				if (wantsNative) {
					const matrix = encodeMatrix(args.text, plan.version, levelKey);
					const svg = matrixToSvg(matrix.modules, matrix.size, {
						quietZone: config.quietZone,
						scale: args.scale ?? config.scale,
						light: args.lightColor,
						dark: args.darkColor
					});
					const destination = await outPath(extension === "" ? `${requestedName}.svg` : requestedName);
					await writeFile(destination, svg, "utf8");
					const info = await stat(destination).catch(() => undefined);
					return {
						outputPath: destination,
						format: "svg",
						engine: "built-in encoder (no external dependency)",
						version: plan.version,
						level: plan.levelName,
						recovery: plan.recovery,
						modules: plan.modules,
						...info === undefined ? {} : { sizeBytes: info.size },
						bytes: plan.bytes,
						notes
					};
				}

				if (RASTER_EXTENSIONS.has(extension) && config.encodeCommand.trim().length === 0) {
					throw new Error(`qrcode: ${extension.slice(1).toUpperCase()} output needs an external encoder, and none is configured. Either ask for a .svg (works here with no install), or set encodeCommand in the plugin config to a QR encoder such as qrencode.`);
				}
				if (config.encodeCommand.trim().length === 0) {
					throw new Error(`qrcode: cannot write "${extension || "unknown"}" files. The built-in encoder writes SVG only. Ask for a .svg file, or configure encodeCommand for other formats.`);
				}

				const destination = await outPath(requestedName);
				await runCommand(config.encodeCommand, expandArgs(config.encodeArgs, {
					text: args.text,
					output: destination,
					level: plan.levelName
				}), { timeoutMs: budgetMs, signal: exec.signal });

				const info = await stat(destination).catch(() => undefined);
				if (info === undefined) {
					throw new Error(`qrcode: the configured encoder (${config.encodeCommand}) exited cleanly but wrote no file at "${destination}". Check encodeArgs — the output placeholder must match the encoder's own flag.`);
				}
				return {
					outputPath: destination,
					format: extension.replace(".", ""),
					engine: config.encodeCommand,
					version: plan.version,
					level: plan.levelName,
					recovery: plan.recovery,
					modules: plan.modules,
					sizeBytes: info.size,
					bytes: plan.bytes,
					notes
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Encode QR (${args.text?.length ?? 0} chars)`, kind: "other", rawInput: args })
		}));
	}

	/* -- qrcode_read ------------------------------------------------------- */
	if (config.read) {
		ctx.tools.register(defineTool({
			name: "qrcode_read",
			description: "Decode the QR code in an image file. Reports structural warnings (wrong format, suspiciously small file) alongside the result, so a failure explains itself instead of returning nothing.",
			parameters: {
				path: { type: "string", required: true, description: "Absolute path to the image containing the QR code." }
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						path: { type: "string", required: true },
						decoded: { type: "boolean", required: true },
						text: { type: "string" },
						format: { type: "string" },
						sizeBytes: { type: "number" },
						engine: { type: "string", required: true },
						warnings: { type: "array", required: true, items: { type: "string" } }
					}
				},
				render: (_args, value) => [{
					type: "text",
					text: [
						value.decoded ? `Decoded: ${value.text}` : "No QR code could be decoded.",
						`${value.format ?? "unknown format"} · ${value.sizeBytes ?? "?"} bytes · via ${value.engine}`,
						...value.warnings
					].join("\n")
				}]
			},
			timeoutMs: DEFAULT_TIMEOUT_MS,
			async execute(args, exec) {
				const source = resolve(args.path);
				let info;
				try {
					info = await stat(source);
				} catch {
					throw new Error(`qrcode: no file at "${source}". Pass an absolute path to an existing image.`);
				}
				if (!info.isFile()) throw new Error(`qrcode: "${source}" is not a file.`);

				const warnings = [];
				let format;
				try {
					const head = await readFile(source);
					format = sniffImage(head);
					warnings.push(...decodeWarnings(head));
				} catch {
					// Reading failed; the decoder will produce its own error.
				}

				if (config.decodeCommand.trim().length === 0) {
					throw new Error(`qrcode: no decoder is configured, so this image cannot be read. Set decodeCommand in the plugin config to a QR decoder such as zbarimg (zbar-tools) or a zxing CLI wrapper.`);
				}

				const result = await runCommand(config.decodeCommand, expandArgs(config.decodeArgs, { input: source }), {
					timeoutMs: budgetMs,
					signal: exec.signal
				});
				const text = result.stdout.trim();
				if (text.length === 0) {
					if (result.code !== 0) {
						warnings.push(`Decoder exited with code ${result.code}: ${result.stderr.trim().slice(0, 300) || "no output"}`);
					}
					// A decoder that fails usually fails for one of a handful of
					// reasons, and the model cannot see the image. Spell them out
					// either way so the next attempt has somewhere to go.
					warnings.push("Decoder found no symbol. Common causes: the crop cut into the quiet zone (keep 4 blank modules around the code), the image is too small or blurred, or the code is inverted (light-on-dark).");
				}
				return {
					path: source,
					decoded: text.length > 0,
					...text.length === 0 ? {} : { text },
					...format === undefined ? {} : { format },
					sizeBytes: info.size,
					engine: config.decodeCommand,
					warnings
				};
			},
			presentCall: (args) => ({ card: "generic", title: `Decode QR from ${basename(args.path ?? "image")}`, kind: "other", rawInput: args })
		}));
	}
}

export { Config, apply, inject, name };