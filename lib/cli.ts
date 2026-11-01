// NOT ORIGINAL - command-line parsing for the tools that used Python's argparse: node:util parseArgs plus argparse's
// manners - `-h` / `--help` prints the usage and exits 0, an unknown or malformed option prints the usage and the
// error to stderr and exits 2 (no stack trace).
//
//   const { values, positionals } = parseCli(USAGE, { options: {...}, allowPositionals: true });

import * as fs from "node:fs";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { valueText } from "./text.ts";

export function parseCli<T extends ParseArgsConfig>(usage: string, config: T): ReturnType<typeof parseArgs<T>> {
    const args = config.args ?? process.argv.slice(2);
    if (args.includes("-h") || args.includes("--help")) {
        process.stdout.write(`${usage}\n`);
        process.exit(0);
    }
    try {
        return parseArgs(config);
    } catch (e) {
        process.stderr.write(`${usage}\nerror: ${e instanceof Error ? e.message : String(e)}\n`);
        process.exit(2);
    }
}

// Python's print(*args): the texts joined with spaces, a line end. (console.log reads "%s" / "%d" in its first
// argument when more follow; this doesn't.) Python on Windows writes "\r\n" - see docs/typescript.md.
export function print(...args: unknown[]): void {
    process.stdout.write(`${args.map((a) => (typeof a === "string" ? a : valueText(a))).join(" ")}\n`);
}

// Python's CliExit: sys.exit("message") prints the message to stderr and exits with 1; sys.exit(n) exits with n.
// Thrown (not process.exit) so output is flushed; runMain turns it into the exit code. Note: a ported
// `except Exception:` must not swallow it (Python's CliExit isn't an Exception) - rethrow it.
export class CliExit extends Error {
    override name = "CliExit";
    readonly code: number;
    readonly text: string | undefined;
    constructor(codeOrMessage: number | string = 0) {
        super(typeof codeOrMessage === "string" ? codeOrMessage : `exit ${codeOrMessage}`);
        this.code = typeof codeOrMessage === "string" ? 1 : codeOrMessage;
        this.text = typeof codeOrMessage === "string" ? codeOrMessage : undefined;
    }
}

export function exitWith(codeOrMessage: number | string = 0): never {
    throw new CliExit(codeOrMessage);
}

// Runs a CLI's main: its return value (a number) or CliExit is the exit code, as Python's
// `sys.exit(main())`.
export async function runMain(main: () => number | undefined | Promise<number | undefined>): Promise<void> {
    try {
        const code = await main();
        if (typeof code === "number") process.exitCode = code;
    } catch (e) {
        if (e instanceof CliExit) {
            if (e.text !== undefined) process.stderr.write(`${e.text}\n`);
            process.exitCode = e.code;
            return;
        }
        throw e;
    }
}

// Whether this module is the one Node was started with (Python's `if __name__ == "__main__":`).
export function isMain(importMetaUrl: string): boolean {
    const entry = process.argv[1];
    if (!entry) return false;
    const url = new URL(importMetaUrl);
    const self = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1");
    const norm = (p: string): string => p.replaceAll("\\", "/").toLowerCase();
    return norm(self) === norm(fs.realpathSync(entry));
}
