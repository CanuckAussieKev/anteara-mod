// NOT ORIGINAL - edits to game scripts: how this project stores a change to a game's script (or a script made from
// one) without storing the game's text. The edits are applied at install / convert time to the user's own copy of
// the game's scripts (decompiled or rendered as NeverScript text) and give back the changed script exactly. Used by
// the Anteara Mod (tools/anteara: mod\edits\*.edits, its README "How it's stored"; lib/edits.ts there is a copy of
// this file) and by THAW's BMX (thaw_bmx/bike_scripts.edits). Latin-1 text, one directive or operation per line:
//
//   # ...                      a comment
//   base <crc>                 the CRC-32 of the decompiled game script the edits apply to (checked)
//   remove <name>              the change removes this unit (a script or a global)
//   unit <name>                the change changes this unit: the operations below rebuild it from the game's
//   new <name>                 a unit added: placed after the unit "after" names (or first), or - in a file of our
//   after <name> | first       own - at its line "//@unit <name>"
//   from <crc> <file> <name>   the operations below start from this game unit (another script's) instead
//   with <crc> <file> <name>   another game unit the operations copy lines from ("@1" for the first "with"...)
//   head / register            the text before the first unit / the __register_checksums__ line
// (<file>: a script as the tool's UnitLookup names it - the Anteara Mod's: "game\x.qb" in THUG2's Data\scripts,
// "pre:<archive>:<name>" a file in one of THUG2's Data\pre archives, "thug1:<name>" one in THUG1's Data\pre\qb.pre;
// the menu builder's: a file of THUG2's Data\pre archives by its stored name; THAW's BMX: a THAW script file)
// (<crc>: the CRC-32 of the unit's text, checked) and the operations that make a unit's lines, from its source unit's
// lines (numbered from 1):
//   = 4-12                     copy lines 4 to 12 (= 4: line 4 alone; "= 4-12 @2": from the second "with" unit)
//   ~ 7 12 3 text              line 7 with the 3 characters at column 12 (from 0) replaced by "text"
//   + text                     a line of our own ("+" alone: an empty line)
// Lines of the source that no operation copies are the ones the change deleted.

import * as zlib from "node:zlib";
import { SequenceMatcher } from "./difflib.ts";
import { encodeLatin1 } from "./py.ts";

export function textCrc(text: string): string {
    return (zlib.crc32(encodeLatin1(text)) >>> 0).toString(16).padStart(8, "0");
}

// A unit's first line: "script <name> {" or "<name> = ..." ([1]: a script's name, [2]: a global's).
export const UNIT_START = /^(?:script (\S+?) ?\{|(`[^`\n]+`|[A-Za-z_#][A-Za-z0-9_]*) ?= ?)/;

// A unit name as NeverScript shows its checksum (#xxxxxxxx: the checksum's bytes in file order) - names and raw
// checksums alike, case ignored.
export function keyOf(name: string): string {
    name = name.replace(/^`+|`+$/g, "");
    if (/^#[0-9a-fA-F]{8}$/.test(name)) return name.toLowerCase();
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32LE((zlib.crc32(encodeLatin1(name.toLowerCase())) ^ 0xffffffff) >>> 0);
    return `#${bytes.toString("hex")}`;
}

export interface Source {
    crc: string;
    file: string;
    name: string;
}

export interface Block {
    kind: "remove" | "unit" | "new" | "head" | "register";
    name: string;
    // new: the unit it goes after ("" = first); undefined = at its placeholder line (a file of the mod's own)
    after?: string;
    from?: Source;
    with?: Source[];
    ops: string[];
}

export interface Edits {
    comments: string[];
    base: string | null;
    blocks: Block[];
}

export const PLACEHOLDER = "//@unit ";

function parseSource(rest: string): Source | null {
    const m = /^([0-9a-f]{8}) (\S+) (.+)$/.exec(rest);
    return m ? { crc: m[1]!, file: m[2]!, name: m[3]! } : null;
}

export function parseEdits(text: string, where: string): Edits {
    const edits: Edits = { comments: [], base: null, blocks: [] };
    let current: Block | null = null;
    const fail = (n: number, why: string): never => {
        throw new Error(`${where}:${n + 1}: ${why}`);
    };
    const block = (n: number, word: string): Block => {
        if (!current || current.kind === "remove") return fail(n, `${word} outside a unit`);
        return current;
    };
    text.split("\n").forEach((line, n) => {
        if (line === "") return;
        const sp = line.indexOf(" ");
        const word = sp < 0 ? line : line.slice(0, sp);
        const rest = sp < 0 ? "" : line.slice(sp + 1);
        if (word === "=" || word === "~" || word === "+") {
            block(n, "an operation").ops.push(line);
        } else if (word === "#") {
            if (!edits.blocks.length) edits.comments.push(line);
        } else if (word === "base") {
            edits.base = rest;
        } else if (word === "after" || word === "first") {
            const b = block(n, word);
            if (b.kind !== "new" || b.ops.length) fail(n, `${word} not right after new`);
            b.after = word === "first" ? "" : rest;
        } else if (word === "from" || word === "with") {
            const b = block(n, word);
            const source = parseSource(rest) ?? fail(n, `bad ${word}`);
            if (b.ops.length) fail(n, `${word} after the operations`);
            if (word === "from") b.from = source;
            else b.with = [...(b.with ?? []), source];
        } else if (word === "remove" || word === "unit" || word === "new" || word === "head" || word === "register") {
            current = { kind: word, name: rest, ops: [] };
            edits.blocks.push(current);
        } else {
            fail(n, `unknown line ${JSON.stringify(line.slice(0, 40))}`);
        }
    });
    return edits;
}

function formatSource(word: string, s: Source): string {
    if (/\s/.test(s.file)) throw new Error(`a source file name with a space: ${s.file}`);
    return `${word} ${s.crc} ${s.file} ${s.name}`;
}

export function formatEdits(edits: Edits): string {
    const out = [...edits.comments];
    if (edits.base !== null) out.push(`base ${edits.base}`);
    for (const b of edits.blocks) {
        out.push(b.name ? `${b.kind} ${b.name}` : b.kind);
        if (b.after !== undefined) out.push(b.after === "" ? "first" : `after ${b.after}`);
        if (b.from) out.push(formatSource("from", b.from));
        for (const s of b.with ?? []) out.push(formatSource("with", s));
        out.push(...b.ops);
    }
    return `${out.join("\n")}\n`;
}

// --- operations ----------------------------------------------------------------------------------------------------

// The lines the operations make from src (and the "with" units' lines, extra[0] for "@1"...).
export function applyOps(
    src: readonly string[],
    ops: readonly string[],
    where: string,
    extra: readonly (readonly string[])[] = [],
): string[] {
    const out: string[] = [];
    const line = (from: readonly string[], n: number): string => {
        if (!(n >= 1 && n <= from.length)) throw new Error(`${where}: line ${n} is not in its source (${from.length})`);
        return from[n - 1]!;
    };
    for (const op of ops) {
        if (op[0] === "+") {
            out.push(op.length > 1 ? op.slice(2) : "");
        } else if (op[0] === "=") {
            const m = /^= (\d+)(?:-(\d+))?(?: @(\d+))?$/.exec(op);
            if (!m) throw new Error(`${where}: bad operation ${op}`);
            const from = m[3] ? extra[Number(m[3]) - 1] : src;
            if (!from) throw new Error(`${where}: ${op}: no such "with" unit`);
            const a = Number(m[1]);
            const b = m[2] ? Number(m[2]) : a;
            for (let n = a; n <= b; n++) out.push(line(from, n));
        } else {
            const m = /^~ (\d+) (\d+) (\d+)(?: ([\s\S]*))?$/.exec(op);
            if (!m) throw new Error(`${where}: bad operation ${op}`);
            const s = line(src, Number(m[1]));
            const col = Number(m[2]);
            const len = Number(m[3]);
            if (col + len > s.length) throw new Error(`${where}: ${op} past the end of its line`);
            out.push(s.slice(0, col) + (m[4] ?? "") + s.slice(col + len));
        }
    }
    return out;
}

// The characters of the mod's own an operation list stores.
export function literalChars(ops: readonly string[]): number {
    let n = 0;
    for (const op of ops) {
        if (op[0] === "+") n += Math.max(0, op.length - 2) + 1;
        else if (op[0] === "~") n += (/^~ \d+ \d+ \d+ ?([\s\S]*)$/.exec(op)?.[1] ?? "").length + 1;
    }
    return n;
}

function commonPrefix(a: string, b: string): number {
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

function commonSuffix(a: string, b: string, limit: number): number {
    let n = 0;
    while (n < limit && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
}

// [prefix, suffix, the kept characters that aren't indentation]
function overlap(s: string, t: string): [number, number, number] {
    const p = commonPrefix(s, t);
    const q = commonSuffix(s, t, Math.min(s.length, t.length) - p);
    const indent = /^\s*/.exec(t)![0].length;
    return [p, q, p + q - Math.min(indent, p)];
}

const MIN_KEPT = 10; // (an in-line edit only when it keeps this many characters of the source line)
const MIN_MOVED = 12; // (a line found elsewhere in the source is copied when it has this many characters)

// The operations that make tgt from src.
export function makeOps(src: readonly string[], tgt: readonly string[]): string[] {
    const ops: string[] = [];
    const where = new Map<string, number>();
    src.forEach((l, i) => {
        if (!where.has(l)) where.set(l, i);
    });
    // (the common start and end first: the matcher is quadratic on huge units)
    let lo = 0;
    while (lo < src.length && lo < tgt.length && src[lo] === tgt[lo]) lo++;
    let hi = 0;
    while (hi < src.length - lo && hi < tgt.length - lo && src[src.length - 1 - hi] === tgt[tgt.length - 1 - hi]) hi++;
    const copy = (i: number): void => {
        ops.push(`= ${i + 1}`);
    };
    for (let i = 0; i < lo; i++) copy(i);
    const a = src.slice(lo, src.length - hi);
    const b = tgt.slice(lo, tgt.length - hi);
    const sm = new SequenceMatcher<string>(a, b, false);
    for (const [tag, i1, i2, j1, j2] of sm.getOpcodes()) {
        if (tag === "equal") {
            for (let i = i1; i < i2; i++) copy(lo + i);
            continue;
        }
        let from = i1;
        for (let j = j1; j < j2; j++) {
            const t = b[j]!;
            // the most similar line of the source's replaced lines, in order
            let best = -1;
            let bestKept = 0;
            for (let i = from; i < i2 && tag === "replace"; i++) {
                const kept = overlap(a[i]!, t)[2];
                if (kept > bestKept) {
                    best = i;
                    bestKept = kept;
                }
            }
            if (best >= 0 && bestKept >= MIN_KEPT) {
                const s = a[best]!;
                const [p, q] = overlap(s, t);
                const text = t.slice(p, t.length - q);
                ops.push(`~ ${lo + best + 1} ${p} ${s.length - p - q}${text ? ` ${text}` : ""}`);
                from = best + 1;
                continue;
            }
            const moved = where.get(t);
            if (moved !== undefined && t.trim().length >= MIN_MOVED) {
                copy(moved);
                continue;
            }
            ops.push(t === "" ? "+" : `+ ${t}`);
        }
    }
    for (let i = src.length - hi; i < src.length; i++) copy(i);
    return mergeCopies(ops);
}

// Where a line is in the game's other units: [unit id, its line numbers from 0].
export type LineLookup = (line: string) => readonly [string, number][];

const MIN_SHARED = 20; // (runs of a "+" lines copied from another game unit when they hold this many characters)

// The "+" lines of ops that are in other game units, as copies from those (each a "with" unit): [ops, unit ids].
export function shareLines(
    ops: readonly string[],
    lookup: LineLookup,
    unitLines: (id: string) => readonly string[],
    first = 0, // (the "with" units the block has already: the new ones are numbered after them)
): [string[], string[]] {
    const out: string[] = [];
    const ids: string[] = [];
    const lit = (op: string): string | null => (op[0] === "+" ? op.slice(2) : null);
    for (let k = 0; k < ops.length; ) {
        const t = lit(ops[k]!);
        if (t === null || t.trim().length < 4) {
            out.push(ops[k]!);
            k++;
            continue;
        }
        // the longest run of these lines in one place
        let best: [string, number, number] | null = null; // [id, first line, count]
        let bestChars = 0;
        for (const [id, at] of lookup(t).slice(0, 64)) {
            const lines = unitLines(id);
            let n = 0;
            let chars = 0;
            while (k + n < ops.length && lit(ops[k + n]!) === lines[at + n] && at + n < lines.length) {
                chars += lines[at + n]!.trim().length;
                n++;
            }
            if (chars > bestChars) {
                best = [id, at, n];
                bestChars = chars;
            }
        }
        if (!best || bestChars < MIN_SHARED) {
            out.push(ops[k]!);
            k++;
            continue;
        }
        const [id, at, n] = best;
        let index = ids.indexOf(id);
        if (index < 0) index = ids.push(id) - 1;
        const w = first + index + 1;
        out.push(n === 1 ? `= ${at + 1} @${w}` : `= ${at + 1}-${at + n} @${w}`);
        k += n;
    }
    return [out, ids];
}

function mergeCopies(ops: readonly string[]): string[] {
    const out: string[] = [];
    let run: [number, number] | null = null;
    const flush = (): void => {
        if (run) out.push(run[0] === run[1] ? `= ${run[0]}` : `= ${run[0]}-${run[1]}`);
        run = null;
    };
    for (const op of ops) {
        const m = /^= (\d+)$/.exec(op);
        if (m) {
            const n = Number(m[1]);
            if (run && n === run[1] + 1) run[1] = n;
            else {
                flush();
                run = [n, n];
            }
            continue;
        }
        flush();
        out.push(op);
    }
    flush();
    return out;
}

// --- units from the game's scripts --------------------------------------------------------------------------------------

// The game's units where edits' sources are: a unit's text by its file and name (keyOf), undefined when there's none.
export interface UnitLookup {
    unit(file: string, key: string): string | undefined;
}

export class EditsError extends Error {}

export function sourceLines(look: UnitLookup, from: Source, where: string): string[] {
    const text = look.unit(from.file, keyOf(from.name));
    if (text === undefined) throw new EditsError(`${where}: ${from.name} is not in the game's ${from.file}`);
    if (textCrc(text) !== from.crc) {
        throw new EditsError(`${where}: the game's ${from.name} (${from.file}) isn't the one the edits were made from`);
    }
    return text.split("\n");
}

// A block's lines: its operations on its source (from, else own: the unit it changes) and its "with" units.
export function blockLines(look: UnitLookup, block: Block, own: readonly string[], where: string): string[] {
    const src = block.from ? sourceLines(look, block.from, where) : own;
    const extra = (block.with ?? []).map((s) => sourceLines(look, s, where));
    return applyOps(src, block.ops, `${where} ${block.kind} ${block.name}`, extra);
}

// A file of our own with its units that are stored as edits (adapted game units) in their places.
export function applyOwnEdits(own: string, edits: Edits, look: UnitLookup, where: string): string {
    const lines = own.split("\n");
    for (const block of edits.blocks) {
        if (block.kind !== "new" || block.after !== undefined) {
            throw new EditsError(`${where}: only new units at their placeholders in a file of our own`);
        }
        const at = lines.indexOf(`${PLACEHOLDER}${block.name}`);
        if (at < 0) throw new EditsError(`${where}: no line ${PLACEHOLDER}${block.name}`);
        lines.splice(at, 1, ...blockLines(look, block, [], where));
    }
    return lines.join("\n");
}

// --- making edits ---------------------------------------------------------------------------------------------------

// A unit's name from its first line.
export function unitName(text: string): string {
    // (the first line that starts one: comment lines may come before it)
    for (const line of text.split("\n")) {
        const m = UNIT_START.exec(line);
        if (m) return m[1] ?? m[2]!;
    }
    throw new EditsError(`not a unit: ${JSON.stringify(text.slice(0, 40))}`);
}

// The game's units by the lines they hold: where a unit may be made from, and where its lines are.
export class UnitIndex {
    private readonly owners = new Map<string, Set<string>>();
    private readonly places = new Map<string, [string, number][]>();
    private readonly byKey = new Map<string, string[]>();
    private readonly look: UnitLookup;
    private readonly fallback: UnitIndex | null;
    // (a unit is "<file>\n<key>"; fallback: more game units, tried where none of these makes the unit - derive - and
    // for the lines none of these holds - share)
    constructor(
        look: UnitLookup,
        units: Iterable<readonly [string, string, string]>,
        fallback: UnitIndex | null = null,
    ) {
        this.look = look;
        this.fallback = fallback;
        for (const [file, key, text] of units) {
            const id = `${file}\n${key}`;
            const same = this.byKey.get(key);
            if (same) same.push(id);
            else this.byKey.set(key, [id]);
            text.split("\n").forEach((l, at) => {
                if (l.trim().length < 8) return;
                let list = this.places.get(l);
                if (!list) {
                    list = [];
                    this.places.set(l, list);
                }
                if (list.length < 64) list.push([id, at]);
            });
            for (const l of new Set(text.split("\n").map((x) => x.trim()))) {
                if (l.length < 12) continue;
                let set = this.owners.get(l);
                if (!set) {
                    set = new Set();
                    this.owners.set(l, set);
                }
                set.add(id);
            }
        }
    }

    private text(id: string): string {
        const [file, key] = id.split("\n") as [string, string];
        return this.look.unit(file, key)!;
    }

    private source(id: string): Source {
        const text = this.text(id);
        return { crc: textCrc(text), file: id.split("\n")[0]!, name: unitName(text) };
    }

    // The best game unit to make text from, when that stores less than `share` of the text (a game unit of the same
    // name: less than `sameName`): [source, operations].
    derive(text: string, share = 0.5, sameName = share): [Source, string[]] | null {
        const lines = text.split("\n");
        const count = new Map<string, number>();
        for (const l of new Set(lines.map((x) => x.trim()))) {
            for (const o of this.owners.get(l) ?? []) count.set(o, (count.get(o) ?? 0) + 1);
        }
        const whole = literalChars(lines.map((l) => (l === "" ? "+" : `+ ${l}`)));
        const key = keyOf(unitName(text));
        const candidates = [...count]
            .filter(([, c]) => c >= 2)
            .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .slice(0, 8)
            .map(([id]) => id);
        for (const id of this.byKey.get(key) ?? []) if (!candidates.includes(id)) candidates.push(id);
        let best: [Source, string[]] | null = null;
        let bestChars = Number.POSITIVE_INFINITY;
        for (const id of candidates) {
            const ops = makeOps(this.text(id).split("\n"), lines);
            const chars = literalChars(ops);
            const limit = whole * (id.endsWith(`\n${key}`) ? sameName : share);
            if (chars < limit && chars < bestChars) {
                best = [this.source(id), ops];
                bestChars = chars;
            }
        }
        return best ?? this.fallback?.derive(text, share, sameName) ?? null;
    }

    // The block's lines of our own that are lines of other game units, as copies from those ("with").
    share(block: Block): void {
        const have = block.with ?? [];
        const [ops, ids] = shareLines(
            block.ops,
            (line) => this.places.get(line) ?? [],
            (id) => this.text(id).split("\n"),
            have.length,
        );
        if (ids.length) {
            block.ops = ops;
            block.with = [...have, ...ids.map((id) => this.source(id))];
        }
        this.fallback?.share(block);
    }
}

// A text's units as line ranges [first line, end): from a unit's first line to the comment lines before the next
// one (or the checksum table, or the end).
export function unitRanges(lines: readonly string[]): [number, number][] {
    const starts: number[] = [];
    lines.forEach((l, i) => {
        if (UNIT_START.exec(l)) starts.push(i);
    });
    return starts.map((start, n): [number, number] => {
        let end = n + 1 < starts.length ? starts[n + 1]! : lines.length;
        while (end > start + 1 && lines[end - 1]!.startsWith("//")) end--;
        const reg = lines.slice(start, end).findIndex((l) => l.startsWith("__register_checksums__"));
        if (reg > 0) end = start + reg;
        return [start, end];
    });
}

// A text's units by name (keyOf; the first of a name), as unitRanges cuts them.
export function unitMap(text: string): Map<string, string> {
    const lines = text.split("\n");
    const out = new Map<string, string>();
    for (const [start, end] of unitRanges(lines)) {
        const key = keyOf(unitName(lines[start]!));
        if (!out.has(key)) out.set(key, lines.slice(start, end).join("\n"));
    }
    return out;
}

// A file of our own: [its text with a placeholder line for each unit that's an adapted game unit, their edits] -
// each unit's lines as unitRanges cuts them.
export function ownEdits(
    text: string,
    index: UnitIndex,
    look: UnitLookup,
    where: string,
    comment: string,
    share = 0.5,
    sameName = share,
): [string, Edits | null] {
    const lines = text.split("\n");
    const edits: Edits = { comments: [comment], base: null, blocks: [] };
    const out: string[] = [];
    let copied = 0;
    unitRanges(lines).forEach(([start, end]) => {
        const derived = index.derive(lines.slice(start, end).join("\n"), share, sameName);
        if (!derived) return;
        const block: Block = { kind: "new", name: unitName(lines[start]!), from: derived[0], ops: derived[1] };
        index.share(block);
        edits.blocks.push(block);
        out.push(...lines.slice(copied, start), `${PLACEHOLDER}${block.name}`);
        copied = end;
    });
    if (!edits.blocks.length) return [text, null];
    out.push(...lines.slice(copied));
    const own = out.join("\n");
    if (applyOwnEdits(own, edits, look, where) !== text) throw new EditsError(`${where}: the edits don't give it back`);
    return [own, edits];
}
