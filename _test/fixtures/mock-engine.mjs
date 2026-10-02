// A stand-in QR encoder and decoder, so the external-engine paths can be
// exercised without qrencode or zbarimg installed.
//
// Called as:
//   node mock-engine.mjs encode <output> <level> <text...>   -> writes a file
//   node mock-engine.mjs decode <input>                      -> prints payload
//   node mock-engine.mjs fail   <...>                        -> exits non-zero
//   node mock-engine.mjs silent <output> <level> <text...>   -> exits 0, writes nothing
//   node mock-engine.mjs version                             -> prints a version line
import { writeFile } from "node:fs/promises";

const [, , mode, ...rest] = process.argv;

// A `version` probe is how the plugin detects an engine. Node rejects `-V` and
// `-version`, so a wrapper has to answer `--version` to behave like a real tool.
if (mode === "version" || mode === "--version") {
	process.stdout.write("mock-qr 1.4.2\n");
} else if (mode === "encode") {
	const [output, level, ...words] = rest;
	const text = words.join(" ");
	await writeFile(output, `MOCKQR ${level} ${text}\n`, "utf8");
} else if (mode === "silent") {
	// Exit cleanly without producing the file, to model a mis-specified command.
	process.exit(0);
} else if (mode === "decode") {
	const [input] = rest;
	const { readFile } = await import("node:fs/promises");
	try {
		const contents = await readFile(input, "utf8");
		const match = /^MOCKQR \w+ (.*)\n$/u.exec(contents);
		if (match === null) {
			process.stderr.write("no QR symbol found\n");
			process.exit(1);
		}
		process.stdout.write(`${match[1]}\n`);
	} catch {
		process.stderr.write("cannot read input\n");
		process.exit(1);
	}
} else if (mode === "fail") {
	process.stderr.write("mock engine: simulated failure\n");
	process.exit(3);
} else {
	process.stderr.write(`unknown mode ${mode}\n`);
	process.exit(2);
}