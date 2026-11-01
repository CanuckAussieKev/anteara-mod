// NOT ORIGINAL - JSON with the exact layout of the files the tools write (indent, ASCII escapes, floats kept as
// floats - Float), read back the same way; truthy() for a JSON value.

import { Float, floatText } from "./numbers.ts";

function jsonString(text: string): string {
    // json.dumps' ensure_ascii form: everything outside space ... "~" escaped (\u00e9, \u007f, \ud83d\ude00)
    let out = '"';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        const c = text.charCodeAt(i);
        if (ch === '"') out += '\\"';
        else if (ch === "\\") out += "\\\\";
        else if (ch === "\n") out += "\\n";
        else if (ch === "\r") out += "\\r";
        else if (ch === "\t") out += "\\t";
        else if (ch === "\b") out += "\\b";
        else if (ch === "\f") out += "\\f";
        else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
        else out += ch;
    }
    return `${out}"`;
}

function jsonFloat(x: number): string {
    if (Number.isNaN(x)) return "NaN";
    if (x === Number.POSITIVE_INFINITY) return "Infinity";
    if (x === Number.NEGATIVE_INFINITY) return "-Infinity";
    return floatText(x);
}

// json.dumps(value, indent=indent) as Python writes it: ", " / ": " separators (",\n" with an indent), ASCII only,
// floats (Float, or non-integral numbers) as repr ("1.0", "1e-05"), integral numbers as ints. Maps and plain objects
// are dicts (keys must be strings; numbers are written as Python writes int keys: "1").
export function jsonText(value: unknown, indent?: number): string {
    const write = (v: unknown, level: number): string => {
        if (v === null || v === undefined) return "null";
        if (v === true) return "true";
        if (v === false) return "false";
        if (typeof v === "string") return jsonString(v);
        if (typeof v === "number") return Number.isInteger(v) ? String(v) : jsonFloat(v);
        if (v instanceof Float) return jsonFloat(v.value);
        const pad = indent === undefined ? "" : `\n${" ".repeat(indent * (level + 1))}`;
        const end = indent === undefined ? "" : `\n${" ".repeat(indent * level)}`;
        const sep = indent === undefined ? ", " : ",";
        if (Array.isArray(v)) {
            if (v.length === 0) return "[]";
            return `[${v.map((x) => pad + write(x, level + 1)).join(sep)}${end}]`;
        }
        const entries = v instanceof Map ? [...v.entries()] : Object.entries(v as object);
        if (entries.length === 0) return "{}";
        return `{${entries.map(([k, x]) => `${pad}${jsonString(String(k))}: ${write(x, level + 1)}`).join(sep)}${end}}`;
    };
    return write(value, 0);
}

type JsonReviverContext = { source?: string };

const SPECIAL: Record<string, number> = {
    "\u0000NaN": Number.NaN,
    "\u0000Infinity": Number.POSITIVE_INFINITY,
    "\u0000-Infinity": Number.NEGATIVE_INFINITY,
};

// json.loads: Python's json also reads NaN, Infinity and -Infinity (json.dump writes them for nan / inf); JSON.parse
// refuses them. floats "Float": numbers written with a "." or an exponent (and NaN / Infinity) come back as Float -
// json.loads gives a float for "1.0" - the others as numbers; "number": all as numbers. Plain objects for dicts.
export function parseJson(text: string, floats: "Float" | "number" = "Float"): unknown {
    // (NaN / Infinity outside strings made strings JSON.parse reads, turned back by the reviver)
    let prepared = "";
    let last = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") i++;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        for (const word of ["-Infinity", "Infinity", "NaN"]) {
            if (text.startsWith(word, i)) {
                prepared += `${text.slice(last, i)}"\\u0000${word}"`;
                i += word.length - 1;
                last = i + 1;
                break;
            }
        }
    }
    prepared += text.slice(last);
    const reviver = (_key: string, value: unknown, context?: JsonReviverContext): unknown => {
        if (typeof value === "string" && value in SPECIAL) {
            return floats === "Float" ? new Float(SPECIAL[value]!) : SPECIAL[value]!;
        }
        if (
            floats === "Float" &&
            typeof value === "number" &&
            context?.source !== undefined &&
            /[.eE]/.test(context.source)
        ) {
            return new Float(value);
        }
        return value;
    };
    return JSON.parse(prepared, reviver as (key: string, value: unknown) => unknown);
}

// Python's truth of a value: None, False, 0, 0.0 (a Float too), "", and empty lists / dicts / sets / Maps / bytes are
// false; other objects true. (JavaScript's: [] and {} are true, NaN false - Python's nan is true.)
export function truthy(value: unknown): boolean {
    if (value === null || value === undefined || value === false) return false;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.length > 0;
    if (value instanceof Float) return value.value !== 0;
    if (Array.isArray(value) || value instanceof Uint8Array) return value.length > 0;
    if (value instanceof Map || value instanceof Set) return value.size > 0;
    if (Object.getPrototypeOf(value) === Object.prototype) return Object.keys(value).length > 0;
    return true;
}
