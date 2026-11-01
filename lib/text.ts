// NOT ORIGINAL - strings and bytes: Latin-1 / CP-1252 / ASCII / UTF-8 decoding and encoding, text files written with
// CRLF line ends on every system (the same bytes wherever the tools run), value text for messages and reports, and
// small string helpers with exact whitespace / case rules.

import * as fs from "node:fs";
import { Float, floatText } from "./numbers.ts";

// "%08X" (u32 checksums: give `value >>> 0` if it can be negative)
export function hex8(value: number): string {
    return (value >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

// Python's str.isalnum / str.isdigit / str.isalpha of one character (Unicode-aware, as Python: "é".isalnum() is
// true, "²".isdigit() is true - JavaScript's \w and \d are ASCII only).
export function isAlnumChar(ch: string): boolean {
    return /^[\p{L}\p{N}]$/u.test(ch);
}

export function isDigitChar(ch: string): boolean {
    return /^\p{Nd}$/u.test(ch) || ch === "\u00b2" || ch === "\u00b3" || ch === "\u00b9";
}

export function isAlphaChar(ch: string): boolean {
    return /^\p{L}$/u.test(ch);
}

const PY_WHITESPACE =
    " \t\n\r\x0b\x0c\x1c\x1d\x1e\x1f\x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

// Python's str.strip() (no arguments): Python's whitespace, which differs from String.trim's (trim takes \ufeff,
// strip takes \x1c-\x1f and \x85).
export function stripSpace(text: string): string {
    let a = 0;
    let b = text.length;
    while (a < b && PY_WHITESPACE.includes(text[a]!)) a++;
    while (b > a && PY_WHITESPACE.includes(text[b - 1]!)) b--;
    return text.slice(a, b);
}

// Python's str.splitlines(): splits on \n, \r\n, \r, \v, \f, \x1c-\x1e, \x85, \u2028, \u2029 (not only \n).
// keepends: str.splitlines(keepends=True), each line with its line end.
export function splitLines(text: string, keepends = false): string[] {
    const out: string[] = [];
    const re = /\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/g;
    let last = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
        out.push(text.slice(last, keepends ? m.index + m[0].length : m.index));
        last = m.index + m[0].length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
}

// Python's str.split() (no arguments): runs of Python's whitespace separate, none at the ends.
export function splitWords(text: string): string[] {
    const out: string[] = [];
    let word = "";
    for (const ch of text) {
        if (PY_WHITESPACE.includes(ch)) {
            if (word) out.push(word);
            word = "";
        } else word += ch;
    }
    if (word) out.push(word);
    return out;
}

// Python's str.title() for cased letters: each run of letters capitalised, the rest lower case ("EAST LOS ANGELES"
// -> "East Los Angeles", "it's" -> "It'S" as Python).
export function titleCase(text: string): string {
    let out = "";
    let previousCased = false;
    for (const ch of text) {
        const cased = ch.toLowerCase() !== ch.toUpperCase();
        out += cased ? (previousCased ? ch.toLowerCase() : ch.toUpperCase()) : ch;
        previousCased = cased;
    }
    return out;
}

// Python's repr(str): single quotes unless the text has ' and no ", backslash escapes, \x.. / \u.... for what
// isn't printable.
export function quotedText(text: string): string {
    const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
    let out = quote;
    for (const ch of text) {
        const c = ch.codePointAt(0)!;
        if (ch === quote || ch === "\\") out += `\\${ch}`;
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch !== " " && /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u.test(ch)) {
            // (not str.isprintable(): escaped)
            if (c <= 0xff) out += `\\x${c.toString(16).padStart(2, "0")}`;
            else if (c <= 0xffff) out += `\\u${c.toString(16).padStart(4, "0")}`;
            else out += `\\U${c.toString(16).padStart(8, "0")}`;
        } else out += ch;
    }
    return out + quote;
}

// Python's repr(bytes): b'...' (b"..." when it has ' and no "), \\ \t \n \r escaped, other bytes outside space ... "~"
// as \xhh.
export function bytesText(data: Uint8Array): string {
    const quote = data.includes(0x27) && !data.includes(0x22) ? '"' : "'";
    let out = `b${quote}`;
    for (const b of data) {
        const ch = String.fromCharCode(b);
        if (ch === quote || ch === "\\") out += `\\${ch}`;
        else if (ch === "\t") out += "\\t";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (b < 0x20 || b >= 0x7f) out += `\\x${b.toString(16).padStart(2, "0")}`;
        else out += ch;
    }
    return out + quote;
}

// repr() of plain values as Python prints them (print(a_dict)): str, int, float (Float), bool, None, list, dict
// (a Map or a plain object), tuple (a readonly array tagged with asTuple).
export function valueText(value: unknown): string {
    if (value === null || value === undefined) return "None";
    if (value === true) return "True";
    if (value === false) return "False";
    if (typeof value === "string") return quotedText(value);
    if (typeof value === "number") return Number.isInteger(value) ? String(value) : floatText(value);
    if (value instanceof Float) return floatText(value.value);
    if (Array.isArray(value)) {
        const items = value.map(valueText);
        if (TUPLES.has(value)) return items.length === 1 ? `(${items[0]},)` : `(${items.join(", ")})`;
        return `[${items.join(", ")}]`;
    }
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
    return `{${entries.map(([k, v]) => `${valueText(k)}: ${valueText(v)}`).join(", ")}}`;
}

const TUPLES = new WeakSet<object>();

// Marks an array as a Python tuple for valueText ("(1, 2)").
export function asTuple<T extends unknown[]>(items: T): T {
    TUPLES.add(items);
    return items;
}

// Python's bytes(list_of_ints): raises on a value outside 0 ... 255 (Buffer.from(array) keeps its low byte).
export function bytesOf(values: Iterable<number>): Buffer {
    const list = [...values];
    for (const v of list) {
        if (!Number.isInteger(v) || v < 0 || v > 255) throw new RangeError(`bytes must be in range(0, 256): ${v}`);
    }
    return Buffer.from(list);
}

// bytes.decode("latin-1") / str.encode("latin-1") (raises past U+00FF, as Python - Buffer.from(text, "latin1") would
// keep the low byte).
export function decodeLatin1(data: Uint8Array): string {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("latin1");
}

export function encodeLatin1(text: string): Buffer {
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0xff) {
            throw new RangeError(`'latin-1' codec can't encode character at position ${i}`);
        }
    }
    return Buffer.from(text, "latin1");
}

// str.encode("ascii") (raises past U+007F).
export function encodeAscii(text: string): Buffer {
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0x7f) throw new RangeError(`'ascii' codec can't encode character at position ${i}`);
    }
    return Buffer.from(text, "latin1");
}

// bytes.decode("ascii", "replace"): U+FFFD for each byte past 0x7F (Buffer's "ascii" decoding drops the top bit
// instead: 0xE9 -> "i").
export function decodeAsciiReplace(data: Uint8Array): string {
    let out = "";
    for (const b of data) out += b < 0x80 ? String.fromCharCode(b) : "\ufffd";
    return out;
}

// cp1252 (Windows' ANSI code page: what Python's subprocess text=True, print to a pipe and open() without an encoding
// use on this machine). Its five undefined bytes raise, as Python's codec.
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f" + "\u0090‘’“”•–—˜™š›œ\u009džŸ";

export function decodeCp1252(data: Uint8Array): string {
    let out = "";
    for (const b of data) {
        if (b >= 0x80 && b < 0xa0) {
            if (b === 0x81 || b === 0x8d || b === 0x8f || b === 0x90 || b === 0x9d) {
                throw new RangeError(`'charmap' codec can't decode byte 0x${b.toString(16)}`);
            }
            out += CP1252_HIGH[b - 0x80];
        } else {
            out += String.fromCharCode(b);
        }
    }
    return out;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const UTF8_REPLACE = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

// bytes.decode("utf-8") (strict; a BOM is kept as U+FEFF, as Python's "utf-8" - TextDecoder drops it by default).
export function decodeUtf8(data: Uint8Array, errors: "strict" | "replace" = "strict"): string {
    return (errors === "strict" ? UTF8 : UTF8_REPLACE).decode(data);
}

// Python's text mode on Windows writes each "\n" as "\r\n" (open(path, "w", encoding="utf-8")). Use this where the
// Python tool wrote a text file, so the bytes are the same (levels.json, NeverScript sources, reports) - on every
// system: the output doesn't depend on where it runs.
export function writeText(path: string, text: string): void {
    fs.writeFileSync(path, text.replaceAll("\n", "\r\n"), "utf-8");
}

// Python's text mode reading (open(path, encoding=...).read()): "\r\n" and "\r" read as "\n" (universal newlines).
export function readText(path: string, errors: "strict" | "replace" = "strict"): string {
    return decodeUtf8(fs.readFileSync(path), errors).replace(/\r\n?/g, "\n");
}

// datetime.date.today().isoformat(): the local date, "2026-10-20".
export function today(): string {
    const d = new Date();
    const two = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

// Python's comparison of str (by code point; JavaScript's < compares UTF-16 units - the same below U+10000).
export function compareStr(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}
