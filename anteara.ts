// NOT ORIGINAL - Anteara Mod (the user's own THUG2 script mod, 2010 + 2011 merged; README.md) as an optional part
// of the data overlay. Only the mod's own changes are stored here (mod\), no game script text: its own files
// (mod\new), and for each game script it changes its edits (mod\edits, the format in lib/edits.ts: the units it removes,
// changes or adds as line operations on the game's own units), and a manifest (which files, its qdir.txt changes).
// The game's scripts come from the user's install each time: the edits are applied to them.
//
// install() (called by tools/pipeline/menu_level/make_menu_level.ts on every run) writes <overlay>\anteara\: the complete
// script set the mod plays with - every file its qdir.txt lists, from the game's loose scripts (Data\scripts, which
// the mod was made from) with the mod's changes applied, plus the data overlay's own edits re-applied to the files the
// overlay also changes (Levels.qb, the pause menu, the level select, the front end's roundbar menu...). The DLL reads
// it first while thug2-decomp.ini [features] anteara_mod=1 (src/game/front/data_overlay.h).
//
//   node tools/anteara/anteara.ts extract --unified <scripts_unified folder> [--game C:\Games\THUG2]
//           [--thug1 C:\Games\THUG1]
//       (re)makes mod\ from a merged mod folder (its src\*.ns and qdir.txt) and the game's loose scripts (and its
//       Data\pre script archives; THUG1's qb.pre for the files THUG2 ships empty - the mod's vehicle scripts)
//   node tools/anteara/anteara.ts check --unified <scripts_unified folder> --overlay <game>\thug2-decomp-data
//       compares an installed anteara\ set with the merged mod's .ns, names ignored (the overlay's edits listed)
//   node tools/anteara/anteara.ts install [--game C:\Games\THUG2] [--overlay <folder>] [--thug1 C:\Games\THUG1]
//       the set alone, without the overlay's edits (make_menu_level.ts installs it with them); without THUG1 the
//       vehicle scripts stay THUG2's empty ones (said in its output)
//
// .ns text is Latin-1 here: some strings hold bytes >= 0x80 (the fonts' button glyphs) that NeverScript reads and
// writes byte for byte.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";
import { parseCli } from "./lib/cli.ts";
import { NS_DEFAULT, nsMissing } from "./lib/decomp.ts";
import { unifiedDiff } from "./lib/difflib.ts";
import {
    applyOwnEdits,
    type Block,
    blockLines,
    type Edits,
    EditsError,
    formatEdits,
    keyOf,
    makeOps,
    ownEdits,
    parseEdits,
    textCrc,
    UNIT_START,
    UnitIndex,
    type UnitLookup,
} from "./lib/edits.ts";
import { findCaseless, findInstall, resolveInstall } from "./lib/install.ts";
import { fileKey, prxFiles } from "./lib/prx.ts";
import {
    compareStr,
    encodeLatin1,
    isMain,
    print,
    pyExit,
    pyJoin,
    pyJsonDumps,
    pySplit,
    pyStrip,
    pyStrRepr,
    runMain,
    writeTextPy,
} from "./lib/py.ts";
import { search, sub } from "./lib/re.ts";

const USAGE =
    "usage: anteara.ts {extract,check,install} [--unified UNIFIED] [--game GAME] [--overlay OVERLAY] [--thug1 THUG1] " +
    "[--ns NS]";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOD = path.join(HERE, "mod");
export const MANIFEST = path.join(MOD, "manifest.json");
export const QDIR_PREFIX = "c:\\ports\\THUG2\\THUG2XB\\Skate6\\data\\scripts\\";

// Python's whitespace (re's \s and str.strip() on str: \x1c-\x1f and \x85 too, not \ufeff).
const WS = "[ \\t\\n\\r\\x0b\\x0c\\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";

// --- Latin-1 text files as Python's open(..., encoding="latin-1") ---------------------------------------------------

// open(path, encoding="latin-1").read(): universal newlines.
function readLatin1(file: string): string {
    return fs.readFileSync(file).toString("latin1").replace(/\r\n?/g, "\n");
}

// open(path, "w", encoding="latin-1", newline="").write(text): no newline translation (raises past U+00FF).
function writeLatin1(file: string, text: string): void {
    fs.writeFileSync(file, encodeLatin1(text));
}

// ntpath.dirname / basename
function ntDirname(p: string): string {
    const at = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    if (at < 0) return /^[A-Za-z]:/.test(p) ? p.slice(0, 2) : "";
    let head = p.slice(0, at + 1);
    if (!/^[\\/]+$/.test(head) && !/^[A-Za-z]:[\\/]+$/.test(head)) head = head.replace(/[\\/]+$/, "");
    return head;
}

function ntBasename(p: string): string {
    const at = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return at < 0 ? p.replace(/^[A-Za-z]:/, "") : p.slice(at + 1);
}

// --- .ns text as units (scripts and globals) ----------------------------------------------------------------------

export function crc(name: string): number {
    return (zlib.crc32(encodeLatin1(name.toLowerCase())) ^ 0xffffffff) >>> 0;
}

// (a unit name as NeverScript shows its checksum: lib/edits.ts)
export { keyOf };

// A unit: [kind ("script" / "global"), name, text].
export type Unit = [string, string, string];

// [head, units, register]: units = [kind, name, text], each unit's text with the comment lines right before it;
// register = the __register_checksums__ line (or "").
export function split(text: string): [string, Unit[], string] {
    let register = "";
    const m = search(/^__register_checksums__.*$/m, text);
    if (m) {
        register = m.str(0);
        text = text.slice(0, m.start()) + text.slice(m.end());
    }
    const lines = text.split("\n");
    const head: string[] = [];
    const units: [string, string, string[]][] = [];
    let pending: string[] = [];
    let current: [string, string, string[]] | null = null;
    for (const line of lines) {
        const start = UNIT_START.exec(line);
        if (line.startsWith("//")) {
            pending.push(line);
            continue;
        }
        if (start) {
            const kind = start[1] !== undefined ? "script" : "global";
            const name = start[1] !== undefined ? start[1] : start[2]!;
            current = [kind, name, [...pending, line]];
            units.push(current);
            pending = [];
            continue;
        }
        const target = current ? current[2] : head;
        target.push(...pending);
        pending = [];
        target.push(line);
    }
    if (pending.length) (current ? current[2] : head).push(...pending);
    return [head.join("\n"), units.map(([k, n, t]): Unit => [k, n, t.join("\n")]), register];
}

export function join(head: string, units: readonly Unit[], register: string): string {
    let body = head ? [head, ...units.map((u) => u[2])].join("\n") : units.map((u) => u[2]).join("\n");
    body = `${body.replace(/\n+$/, "")}\n`;
    return register ? body + register : body;
}

const IDENT = /"(?:[^"\\\n]|\\.)*"|#[0-9a-fA-F]{8}|`[^`\n]+`|[A-Za-z_][A-Za-z0-9_]*/;

// A unit's code for comparing: comments out, every name as its checksum, spacing collapsed.
export function norm(unitText: string): string {
    const lines = unitText.split("\n").filter((l) => !l.replace(new RegExp(`^${WS}+`), "").startsWith("//"));
    const text = lines.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");
    const one = (t: string): string => {
        if (t.startsWith('"')) return t;
        if (t.startsWith("#")) return t.toLowerCase();
        return keyOf(t);
    };
    return pyStrip(sub(IDENT, (m) => one(m.str(0)), text).replace(new RegExp(`${WS}+`, "g"), " "));
}

// --- NeverScript ---------------------------------------------------------------------------------------------------

// subprocess.run(..., capture_output=True, text=True, errors="replace")'s text: the locale's code page, "\r\n" as "\n"
function textReplace(data: Buffer | null | undefined): string {
    if (!data) return "";
    const decoder = new TextDecoder("windows-1252");
    return decoder.decode(data).replace(/\r\n?/g, "\n");
}

export function ns(tool: string, ...args: string[]): void {
    const result = spawnSync(tool, args, { maxBuffer: 1 << 30 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        pyExit(`ns ${args.join(" ")} failed:\n${textReplace(result.stdout)}${textReplace(result.stderr)}`);
    }
}

export function decompile(tool: string, file: string, work: string): string {
    const out = path.join(work, `d_${crc(file).toString(16).padStart(8, "0")}.ns`);
    const result = spawnSync(tool, ["-d", file, "-o", out], { maxBuffer: 1 << 30 });
    if (result.error) throw result.error;
    if (result.status !== 0) ns(tool, "-lenient", "-d", file, "-o", out); // (a few retail files end in 0x00 padding)
    return readLatin1(out);
}

export function compileTo(tool: string, text: string, target: string, work: string): void {
    const src = path.join(work, `c_${crc(target).toString(16).padStart(8, "0")}.ns`);
    writeLatin1(src, text);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    ns(tool, "-c", src, "-o", target, "-targetGame", "thug2");
}

// --- qdir.txt ------------------------------------------------------------------------------------------------------

export function qdirFiles(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split("\n")) {
        const m = search(/\\scripts\\(.+\.qb)/i, pyStrip(line));
        if (m) out.push(m.str(1));
    }
    return out;
}

// [file, the file it goes after ("" for the first)]
type After = [string, string];

export interface ModManifest {
    qdir: { remove: string[]; insert_after: After[]; move_after?: After[] };
    files: Record<string, FileEntry>;
}

// A file the mod changes or adds: new = a file of the mod's own (path: its .ns in mod\new, with a placeholder line
// for each unit stored as edits); edits = its edits in mod\edits (lib/edits.ts) - for a game script, applied to the
// user's own copy.
export interface FileEntry {
    new?: boolean;
    path?: string;
    edits?: string;
}

// How the mod's changes to a game script are found from a merged mod folder (extract): its changed and new units
// whole (patchText), the units it removes, where each new one goes and line edits for a huge global.
export interface UnitChanges {
    remove?: string[];
    insert_after?: Record<string, string>;
    edits?: { old: string; new: string }[];
}

function indexLower(files: readonly string[], name: string): number {
    const at = files.map((f) => f.toLowerCase()).indexOf(name.toLowerCase());
    if (at < 0) throw new Error(`${pyStrRepr(name.toLowerCase())} is not in list`);
    return at;
}

export function modQdir(gameQdir: readonly string[], manifest: ModManifest): string[] {
    const removed = new Set(manifest.qdir.remove.map((r) => r.toLowerCase()));
    let files = gameQdir.filter((f) => !removed.has(f.toLowerCase()));
    for (const [rel, after] of manifest.qdir.insert_after) {
        const at = after ? indexLower(files, after) + 1 : 0;
        files.splice(at, 0, rel);
    }
    for (const [rel, after] of manifest.qdir.move_after ?? []) {
        // (files the mod loads in another order)
        files = files.filter((f) => f.toLowerCase() !== rel.toLowerCase());
        files.splice(after ? indexLower(files, after) + 1 : 0, 0, rel);
    }
    return files;
}

// --- applying the mod to the game's text -----------------------------------------------------------------------------

// str.replace(old, new): every occurrence, taken literally.
function replaceAllLiteral(text: string, old: string, replacement: string): string {
    return text.split(old).join(replacement);
}

// The game's file text with the mod's units in place: changed ones replaced where they are, new ones after the unit
// the manifest names, removed ones dropped, then the manifest's line edits.
export function applyPatch(base: string, patchText: string, entry: UnitChanges, rel: string): string {
    const [head, splitUnits, register] = split(base);
    let units = splitUnits;
    const indexOf = (): Map<string, number> => new Map(units.map(([, n], i) => [keyOf(n), i]));
    let index = indexOf();
    const remove = new Set((entry.remove ?? []).map(keyOf));
    const after = new Map(Object.entries(entry.insert_after ?? {}).map(([k, v]) => [keyOf(k), v]));
    if (patchText) {
        const [, patchUnits] = split(patchText);
        for (const [kind, name, text] of patchUnits) {
            const k = keyOf(name);
            const at = index.get(k);
            if (at !== undefined) {
                units[at] = [kind, name, text];
                continue;
            }
            const prev = after.get(k);
            if (prev === undefined) {
                units.push([kind, name, text]);
            } else {
                let to = 0;
                if (prev !== "") {
                    const found = units.findIndex((u) => keyOf(u[1]) === keyOf(prev));
                    if (found < 0) throw new Error("StopIteration");
                    to = found + 1;
                }
                units.splice(to, 0, [kind, name, text]);
            }
            index = indexOf();
        }
    }
    units = units.filter((u) => !remove.has(keyOf(u[1])));
    let text = join(head, units, register);
    for (const edit of entry.edits ?? []) {
        const n = text.split(edit.old).length - 1;
        if (n !== 1) {
            pyExit(`anteara: ${rel}: the line edit's text ${pyStrRepr(edit.old.slice(0, 60))} found ${n} times`);
        }
        text = replaceAllLiteral(text, edit.old, edit.new);
    }
    // names the mod adds, for decompilers (the checksum table)
    if (patchText && register) {
        const have = new Set(pySplit(register).map((w) => w.toLowerCase()));
        const names = new Set<string>();
        for (const m of patchText.matchAll(/^script ([A-Za-z_][A-Za-z0-9_]*)/gm)) names.add(m[1]!);
        for (const m of patchText.matchAll(/^([A-Za-z_][A-Za-z0-9_]*) =/gm)) names.add(m[1]!);
        const extra = [...names].sort(compareStr).filter((w) => !have.has(w.toLowerCase()));
        if (extra.length) text = replaceAllLiteral(text, register, `${register} ${extra.join(" ")}`);
    }
    return text;
}

// --- the mod's files from its edits (lib/edits.ts) and the user's own scripts ----------------------------------------------

// Where a THUG1 install's qb.pre is (its Data\pre: THUG1's scripts), from a folder the user names (--thug1; the
// install root or its Game folder); null when it isn't there.
export const THUG1_DEFAULT = "C:\\Games\\THUG1";
export function thug1QbPre(folder: string): string | null {
    const install = findInstall(folder, "thug1");
    return install ? findCaseless(install, "Data", "pre", "qb.pre") : null;
}

// Script files the mod's edits name as sources (lib/edits.ts): "game\x.qb" - THUG2's loose Data\scripts;
// "pre:<archive>:<name>" - a file of THUG2's Data\pre\<archive>; "thug1:<name>" - a file of THUG1's Data\pre\qb.pre
// (the mod's vehicle scripts are THUG1's: THUG2 ships player_controlled_vehicle.qb and car_scripts.qb empty).
export const PRE_PREFIX = "pre:";
export const THUG1_PREFIX = "thug1:";

export class Thug1Missing extends EditsError {}

// The user's Data\scripts (and the archives above), decompiled as they are needed. thug1: THUG1's qb.pre, or null
// (thug1Folder: where it was looked for, for the message).
export class GameScripts implements UnitLookup {
    private readonly texts = new Map<string, string>();
    private readonly unitMaps = new Map<string, Map<string, string>>();
    private readonly archives = new Map<string, Map<string, Buffer>>();
    readonly loose: string;
    readonly tool: string;
    readonly work: string;
    readonly thug1: string | null;
    readonly thug1Folder: string;
    constructor(loose: string, tool: string, work: string, thug1: string | null = null, thug1Folder = THUG1_DEFAULT) {
        this.loose = loose;
        this.tool = tool;
        this.work = work;
        this.thug1 = thug1;
        this.thug1Folder = thug1Folder;
    }

    // An archive's files ("pre:<archive>" or "thug1:").
    archive(which: string): Map<string, Buffer> {
        let files = this.archives.get(which.toLowerCase());
        if (!files) {
            let file: string | null;
            if (which === THUG1_PREFIX) {
                file = this.thug1;
                if (!file) {
                    throw new Thug1Missing(
                        `THUG1's Data\\pre\\qb.pre not found in ${this.thug1Folder} (or its Game folder): the mod's ` +
                            "vehicle scripts are made from THUG1's - pass --thug1 <THUG1's install folder>",
                    );
                }
            } else {
                const name = which.slice(PRE_PREFIX.length);
                file = findCaseless(path.dirname(this.loose), "pre", name);
                if (!file) throw new EditsError(`THUG2's Data\\pre\\${name} not found`);
            }
            files = prxFiles(file);
            this.archives.set(which.toLowerCase(), files);
        }
        return files;
    }

    // [archive ("pre:<archive>" / "thug1:"), the file's name in it] of an archived file's name, or null (Data\scripts)
    private static archived(rel: string): [string, string] | null {
        if (rel.startsWith(THUG1_PREFIX)) return [THUG1_PREFIX, rel.slice(THUG1_PREFIX.length)];
        if (!rel.startsWith(PRE_PREFIX)) return null;
        const at = rel.indexOf(":", PRE_PREFIX.length);
        if (at < 0) throw new EditsError(`${rel}: not pre:<archive>:<name>`);
        return [rel.slice(0, at), rel.slice(at + 1)];
    }

    has(rel: string): boolean {
        const archived = GameScripts.archived(rel);
        if (archived) return this.archive(archived[0]).has(fileKey(archived[1]));
        return fs.existsSync(path.join(this.loose, rel));
    }

    text(rel: string): string {
        const key = rel.toLowerCase();
        let text = this.texts.get(key);
        if (text === undefined) {
            const archived = GameScripts.archived(rel);
            if (archived) {
                const data = this.archive(archived[0]).get(fileKey(archived[1]));
                if (!data) throw new EditsError(`${archived[1]} is not in ${archived[0]}`);
                const file = path.join(this.work, `a_${crc(rel).toString(16).padStart(8, "0")}.qb`);
                fs.writeFileSync(file, data);
                // (an archived file NeverScript can't read has no units to offer)
                const out = `${file}.ns`;
                const result = spawnSync(this.tool, ["-lenient", "-d", file, "-o", out], { maxBuffer: 1 << 30 });
                if (result.error) throw result.error;
                text = result.status === 0 && fs.existsSync(out) ? readLatin1(out) : "";
            } else {
                const file = path.join(this.loose, rel);
                if (!fs.existsSync(file)) pyExit(`anteara: ${rel} missing from ${this.loose}`);
                text = decompile(this.tool, file, this.work);
            }
            this.texts.set(key, text);
        }
        return text;
    }

    // Every unit of an archive's .qb files (as [file, key, text], file as the edits name it), each file for which
    // wanted(name) is true.
    *archiveUnits(which: string, wanted: (name: string) => boolean = () => true): Generator<[string, string, string]> {
        const names = [...this.archive(which).keys()].filter((n) => n.endsWith(".qb") && wanted(n)).sort(compareStr);
        for (const name of names) {
            const rel = which === THUG1_PREFIX ? `${which}${name}` : `${which}:${name}`;
            for (const [key, text] of this.units(rel)) yield [rel, key, text];
        }
    }

    unit(rel: string, key: string): string | undefined {
        return this.has(rel) ? this.units(rel).get(key) : undefined;
    }

    // a unit's text by name (the first of that name)
    units(rel: string): Map<string, string> {
        const key = rel.toLowerCase();
        let units = this.unitMaps.get(key);
        if (!units) {
            units = new Map();
            for (const [, name, text] of split(this.text(rel))[1])
                if (!units.has(keyOf(name))) units.set(keyOf(name), text);
            this.unitMaps.set(key, units);
        }
        return units;
    }
}

// A game script with the mod's edits: its units changed, added, removed (base: the decompiled game script).
export function applyScriptEdits(base: string, edits: Edits, scripts: GameScripts, where: string): string {
    if (edits.base !== null && textCrc(base) !== edits.base) {
        pyExit(`anteara: ${where}: the game's script isn't the one the mod was made from (Data\\scripts changed?)`);
    }
    let [head, units, register] = split(base);
    const at = (name: string): number => {
        const i = units.findIndex((u) => keyOf(u[1]) === keyOf(name));
        if (i < 0) pyExit(`anteara: ${where}: no unit ${name}`);
        return i;
    };
    for (const block of edits.blocks) {
        if (block.kind === "remove") {
            units = units.filter((u) => keyOf(u[1]) !== keyOf(block.name));
        } else if (block.kind === "unit") {
            const i = at(block.name);
            units[i] = [
                units[i]![0],
                units[i]![1],
                blockLines(scripts, block, units[i]![2].split("\n"), where).join("\n"),
            ];
        } else if (block.kind === "new") {
            const text = blockLines(scripts, block, [], where).join("\n");
            if (block.after === undefined) pyExit(`anteara: ${where}: new ${block.name} has no place`);
            units.splice(block.after === "" ? 0 : at(block.after) + 1, 0, ["", block.name, text]);
        } else if (block.kind === "head") {
            head = blockLines(scripts, block, head.split("\n"), where).join("\n");
        } else {
            register = blockLines(scripts, block, register.split("\n"), where).join("\n");
        }
    }
    return join(head, units, register);
}

// The mod's text of a file it changes or adds.
export function modText(rel: string, entry: FileEntry, scripts: GameScripts): string {
    try {
        const edits = entry.edits ? parseEdits(readLatin1(path.join(MOD, "edits", entry.edits)), entry.edits) : null;
        if (entry.new) {
            const own = entry.path ? readLatin1(path.join(MOD, "new", entry.path)) : "";
            return edits ? applyOwnEdits(own, edits, scripts, rel) : own;
        }
        const base = scripts.text(rel);
        return edits ? applyScriptEdits(base, edits, scripts, rel) : base;
    } catch (err) {
        if (err instanceof EditsError) pyExit(`anteara: ${err.message}`);
        throw err;
    }
}

// Every file the mod changes or adds, as text (the overlay's edits not applied).
export function modTexts(game: string, tool: string, work: string, thug1 = THUG1_DEFAULT): Map<string, string> {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8")) as ModManifest;
    const scripts = new GameScripts(pyJoin(game, "Data", "scripts"), tool, work, thug1QbPre(thug1), thug1);
    return new Map(Object.entries(manifest.files).map(([rel, entry]) => [rel, modText(rel, entry, scripts)]));
}

// Whether a file's edits take units from THUG1's scripts.
export function needsThug1(entry: FileEntry): boolean {
    if (!entry.edits) return false;
    const text = readLatin1(path.join(MOD, "edits", entry.edits));
    return text.split("\n").some((l) => /^(?:from|with) [0-9a-f]{8} thug1:/.test(l));
}

// --- making the edits (extract) ------------------------------------------------------------------------------------------

function fail(why: string): never {
    throw new Error(`anteara: ${why}`);
}

// The edits that make target (the mod's text of a game script) from base (the game's).
export function scriptEdits(base: string, target: string, index: UnitIndex, scripts: GameScripts, rel: string): Edits {
    const [bh, bu, br] = split(base);
    const [th, tu, tr] = split(target);
    if (join(th, tu, tr) !== target) fail(`${rel}: the mod's text doesn't split into units and back`);
    const edits: Edits = {
        comments: [`# Anteara Mod's edits to ${rel} (applied to the game's own script: lib/edits.ts)`],
        base: textCrc(base),
        blocks: [],
    };
    if (th !== bh) edits.blocks.push({ kind: "head", name: "", ops: makeOps(bh.split("\n"), th.split("\n")) });
    if (tr !== br) edits.blocks.push({ kind: "register", name: "", ops: makeOps(br.split("\n"), tr.split("\n")) });
    const baseBy = new Map<string, string>();
    for (const [, n, t] of bu) if (!baseBy.has(keyOf(n))) baseBy.set(keyOf(n), t);
    const targetKeys = new Set(tu.map((u) => keyOf(u[1])));
    for (const [, n] of bu) if (!targetKeys.has(keyOf(n))) edits.blocks.push({ kind: "remove", name: n, ops: [] });
    tu.forEach(([, name, text], i) => {
        const was = baseBy.get(keyOf(name));
        if (was === text) return;
        if (was !== undefined) {
            const block: Block = { kind: "unit", name, ops: makeOps(was.split("\n"), text.split("\n")) };
            index.share(block);
            edits.blocks.push(block);
            return;
        }
        const derived = index.derive(text);
        const block: Block = { kind: "new", name, after: i ? tu[i - 1]![1] : "", ops: [] };
        if (derived) [block.from, block.ops] = derived;
        else block.ops = makeOps([], text.split("\n"));
        index.share(block);
        edits.blocks.push(block);
    });
    const again = applyScriptEdits(base, edits, scripts, rel);
    if (again !== target) fail(`${rel}: its edits don't give the mod's text back`);
    return edits;
}

// The data overlay's own changes to a file's text.
export type Edit = (text: string) => string;

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "tmp"));
}

// Writes <out>\anteara\: every file of the mod's qdir.txt (scripts\...), its qdir.txt and localtext.qb.
// edits / frontEndEdits: {"scripts\\game\\levels.qb" (lower case): function(text) -> text}, the data overlay's own
// changes to re-apply - edits for anteara\, frontEndEdits for anteara\front_end\ (the skate-shop front end's
// versions). thug1: THUG1's install (the mod's vehicle scripts are made from its qb.pre; without it those files stay
// THUG2's own, empty ones, and the description says so). Returns a description, or null when the game has no loose
// scripts to build on.
export function install(
    game: string,
    out: string,
    tool: string,
    edits: ReadonlyMap<string, Edit> = new Map(),
    frontEndEdits: ReadonlyMap<string, Edit> = new Map(),
    thug1 = THUG1_DEFAULT,
): string | null {
    const overlayEdits = new Map([...edits].map(([k, v]) => [k.toLowerCase(), v]));
    const overlayFrontEndEdits = new Map([...frontEndEdits].map(([k, v]) => [k.toLowerCase(), v]));
    const loose = pyJoin(game, "Data", "scripts");
    const target = pyJoin(out, "anteara");
    if (isDir(target)) fs.rmSync(target, { recursive: true, force: true });
    if (!fs.existsSync(path.join(loose, "qdir.txt"))) return null;
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf-8")) as ModManifest;
    const files = new Map(Object.entries(manifest.files).map(([k, v]) => [k.toLowerCase(), v]));
    const gameQdir = qdirFiles(readLatin1(path.join(loose, "qdir.txt")));
    const qdir = modQdir(gameQdir, manifest);
    const made = { patched: 0, new: 0, copied: 0, overlay: 0 };
    const thug1Pre = thug1QbPre(thug1);
    const withoutThug1: string[] = [];
    const work = tempDir();
    try {
        const scripts = new GameScripts(loose, tool, work, thug1Pre, thug1);
        for (const rel of [...qdir, "localtext.qb"]) {
            const key = `scripts\\${rel.toLowerCase()}`;
            let entry = files.get(rel.toLowerCase());
            if (entry && !thug1Pre && needsThug1(entry)) {
                withoutThug1.push(rel);
                entry = undefined;
            }
            const dst = path.join(target, "scripts", rel);
            if (!entry?.new) {
                const src = path.join(loose, rel);
                if (!fs.existsSync(src)) pyExit(`anteara: ${rel} missing from ${loose}`);
                if (!entry && !overlayEdits.has(key) && !overlayFrontEndEdits.has(key)) {
                    fs.mkdirSync(path.dirname(dst), { recursive: true });
                    fs.copyFileSync(src, dst);
                    made.copied += 1;
                    continue;
                }
            }
            let text = entry ? modText(rel, entry, scripts) : scripts.text(rel);
            if (entry?.new) made.new += 1;
            else if (entry) made.patched += 1;
            const frontEnd = overlayFrontEndEdits.get(key);
            if (frontEnd) compileTo(tool, frontEnd(text), path.join(target, "front_end", "scripts", rel), work);
            const edit = overlayEdits.get(key);
            if (edit) {
                text = edit(text);
                made.overlay += 1;
            }
            compileTo(tool, text, dst, work);
        }
        writeLatin1(path.join(target, "scripts", "qdir.txt"), qdir.map((rel) => `${QDIR_PREFIX}${rel}\r\n`).join(""));
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    return (
        `Anteara Mod: ${qdir.length} files in its qdir.txt + localtext.qb -> ${target} (${made.patched} with the mod's ` +
        `changes, ${made.new} its own, ${made.copied} copied from Data\\scripts, ${made.overlay} with the overlay's ` +
        "edits too)" +
        (withoutThug1.length
            ? `\nAnteara Mod: THUG1's Data\\pre\\qb.pre not found in ${thug1} (--thug1): ${withoutThug1.join(", ")} ` +
              "left as THUG2's own (empty) - the mod's drivable cars need THUG1's vehicle scripts"
            : "")
    );
}

// --- extract: the mod's changes from a merged mod folder --------------------------------------------------------------

// For a huge global the mod changes in a line or two (localtext's Translations): line edits instead of the unit.
// null if it isn't that.
export function lineEdits(baseUnit: string, modUnit: string): [string, string][] | null {
    const a = baseUnit.split("\n");
    const b = modUnit.split("\n");
    if (a.length < 500 || a.length !== b.length) return null;
    const diff: [string, string][] = [];
    a.forEach((x, i) => {
        if (x !== b[i]) diff.push([x, b[i]!]);
    });
    if (!diff.length || diff.length > 8) return null;
    return diff;
}

export function extract(unified: string, game: string, tool: string, thug1 = THUG1_DEFAULT): void {
    const srcRoot = pyJoin(unified, "src");
    const loose = pyJoin(game, "Data", "scripts");
    let unifiedQdir = qdirFiles(readLatin1(path.join(unified, "qdir.txt")));
    const gameQdir = qdirFiles(readLatin1(path.join(loose, "qdir.txt")));
    // one spelling per folder (the merged qdir has game\menu\Anteara_Stuff and game\menu\anteara_stuff)
    const spelling = new Map<string, string>();
    for (const f of unifiedQdir) {
        const folder = ntDirname(f);
        if (!spelling.has(folder.toLowerCase())) spelling.set(folder.toLowerCase(), folder);
    }
    unifiedQdir = unifiedQdir.map((f) =>
        ntDirname(f) ? pyJoin(spelling.get(ntDirname(f).toLowerCase())!, ntBasename(f)) : f,
    );
    const lowerGame = gameQdir.map((f) => f.toLowerCase());
    const lowerMod = unifiedQdir.map((f) => f.toLowerCase());
    const manifest: ModManifest = {
        qdir: { remove: gameQdir.filter((f) => !lowerMod.includes(f.toLowerCase())), insert_after: [] },
        files: {},
    };
    unifiedQdir.forEach((f, i) => {
        if (!lowerGame.includes(f.toLowerCase())) manifest.qdir.insert_after.push([f, i ? unifiedQdir[i - 1]! : ""]);
    });
    let current = modQdir(gameQdir, manifest);
    manifest.qdir.move_after = [];
    unifiedQdir.forEach((f, i) => {
        if (current[i]?.toLowerCase() !== f.toLowerCase()) {
            const after = i ? unifiedQdir[i - 1]! : "";
            manifest.qdir.move_after!.push([f, after]);
            current = modQdir(gameQdir, manifest);
        }
    });
    if (current.map((f) => f.toLowerCase()).join("\n") !== unifiedQdir.map((f) => f.toLowerCase()).join("\n")) {
        throw new Error("AssertionError");
    }
    for (const folder of ["new", "patch", "edits"]) {
        if (isDir(path.join(MOD, folder))) fs.rmSync(path.join(MOD, folder), { recursive: true, force: true });
    }
    const write = (folder: string, file: string, text: string): void => {
        const dst = path.join(MOD, folder, file);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        writeLatin1(dst, text);
    };
    const report: string[] = [];
    const work = tempDir();
    try {
        const thug1Pre = thug1QbPre(thug1);
        const scripts = new GameScripts(loose, tool, work, thug1Pre, thug1);
        // (an added unit that is an adapted game unit is stored as edits to it: any of the game's scripts - those of
        // Data\scripts first, then those only in Data\pre's script archives: the levels', the park editor's...)
        const pre = path.join(path.dirname(loose), "pre");
        const archives = fs
            .readdirSync(pre)
            .filter((f) => /scripts.*\.prx$/i.test(f) && f.toLowerCase() !== "qb_scripts.prx")
            .sort(compareStr);
        const archived = new UnitIndex(
            scripts,
            (function* () {
                for (const archive of archives) yield* scripts.archiveUnits(`${PRE_PREFIX}${archive}`);
            })(),
        );
        const index = new UnitIndex(
            scripts,
            (function* () {
                for (const rel of [...gameQdir, "localtext.qb"]) {
                    if (!scripts.has(rel)) continue;
                    for (const [key, text] of scripts.units(rel)) yield [rel, key, text] as const;
                }
            })(),
            archived,
        );
        // (the files THUG2 ships empty - player_controlled_vehicle.qb, misc\car_scripts.qb: the mod's are THUG1's
        // scripts - are made from THUG1's first)
        let thug1Index: UnitIndex | null = null;
        const emptyIndex = (rel: string): UnitIndex => {
            if (!thug1Pre) {
                pyExit(
                    `anteara: ${rel} is empty in THUG2 and the mod's is made from THUG1's: THUG1's Data\\pre\\qb.pre ` +
                        `not found in ${thug1} (or its Game folder) - pass --thug1 <THUG1's install folder>`,
                );
            }
            thug1Index ??= new UnitIndex(scripts, scripts.archiveUnits(THUG1_PREFIX), index);
            return thug1Index;
        };
        for (const rel of [...unifiedQdir, "localtext.qb"]) {
            const modText = readLatin1(path.join(srcRoot, `${rel}.ns`));
            const file = rel.replaceAll("\\", "/");
            if (!scripts.has(rel)) {
                const [own, edits] = ownEdits(
                    modText,
                    index,
                    scripts,
                    rel,
                    `# Anteara Mod's units in ${rel} that are adapted game units (lib/edits.ts)`,
                );
                write("new", `${file}.ns`, own);
                const entry: FileEntry = { new: true, path: `${file}.ns` };
                if (edits) {
                    write("edits", `${file}.edits`, formatEdits(edits));
                    entry.edits = `${file}.edits`;
                }
                manifest.files[rel] = entry;
                report.push(`new      ${rel.padEnd(48)} ${edits ? edits.blocks.length : 0} adapted game units`);
                continue;
            }
            // the mod's text: the game's units where the mod's have the same code, the mod's changed and added
            // units, without the ones it removes (and line edits for a huge global)
            const base = scripts.text(rel);
            const [, baseUnits] = split(base);
            const [, modUnits] = split(modText);
            const baseBy = new Map(baseUnits.map((u) => [keyOf(u[1]), u]));
            const modKeys = new Set(modUnits.map((u) => keyOf(u[1])));
            const changes: UnitChanges = {};
            const outUnits: string[] = [];
            const insertAfter: Record<string, string> = {};
            let prev = "";
            for (const [, name, text] of modUnits) {
                const k = keyOf(name);
                const was = baseBy.get(k);
                if (was !== undefined) {
                    if (norm(was[2]) !== norm(text)) {
                        const edits = lineEdits(was[2], text);
                        if (edits) {
                            changes.edits ??= [];
                            changes.edits.push(...edits.map(([x, y]) => ({ old: `${x}\n`, new: `${y}\n` })));
                        } else {
                            outUnits.push(text);
                        }
                    }
                } else {
                    outUnits.push(text);
                    insertAfter[name] = prev;
                }
                prev = name;
            }
            const removed = baseUnits.filter((u) => !modKeys.has(keyOf(u[1]))).map((u) => u[1]);
            if (removed.length) changes.remove = removed;
            if (Object.keys(insertAfter).length) changes.insert_after = insertAfter;
            if (!outUnits.length && !Object.keys(changes).length) continue;
            const patchText = outUnits.length ? `${outUnits.join("\n").replace(/\n+$/, "")}\n` : "";
            const target = applyPatch(base, patchText, changes, rel);
            const edits = scriptEdits(base, target, baseUnits.length ? index : emptyIndex(rel), scripts, rel);
            write("edits", `${file}.edits`, formatEdits(edits));
            manifest.files[rel] = { edits: `${file}.edits` };
            const count = (kind: string): number => edits.blocks.filter((b) => b.kind === kind).length;
            report.push(
                `patched  ${rel.padEnd(48)} ${count("unit")} changed, ${count("new")} added ` +
                    `(${edits.blocks.filter((b) => b.from).length} adapted game units), ${count("remove")} removed`,
            );
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    writeTextPy(MANIFEST, pyJsonDumps(manifest, 1));
    print(report.join("\n"));
    const all = Object.values(manifest.files);
    print(`${all.length} files: ${all.filter((e) => e.new).length} new, ${all.filter((e) => !e.new).length} patched`);
}

// --- check: an installed set against the merged mod ------------------------------------------------------------------

// A file's code with every name as its checksum (compiled with -removeChecksums, decompiled again).
function codeLines(tool: string, file: string, work: string, fromNs = false): string {
    let src = file;
    if (!fromNs) {
        src = path.join(work, `k_${crc(file).toString(16).padStart(8, "0")}.ns`);
        const text = decompile(tool, file, work);
        writeLatin1(src, text);
    }
    const q = path.join(work, `k_${crc(`${file}q`).toString(16).padStart(8, "0")}.qb`);
    ns(tool, "-c", src, "-o", q, "-removeChecksums");
    const d = path.join(work, `k_${crc(`${file}d`).toString(16).padStart(8, "0")}.d.ns`);
    ns(tool, "-d", q, "-o", d);
    return readLatin1(d);
}

export function check(unified: string, overlay: string, tool: string): void {
    const target = pyJoin(overlay, "anteara", "scripts");
    const unifiedQdir = qdirFiles(readLatin1(path.join(unified, "qdir.txt")));
    const installedQdir = qdirFiles(readLatin1(path.join(target, "qdir.txt")));
    const sameQdir =
        unifiedQdir.map((f) => f.toLowerCase()).join("\n") === installedQdir.map((f) => f.toLowerCase()).join("\n") &&
        unifiedQdir.length === installedQdir.length;
    print(`qdir.txt: ${sameQdir ? "same files, same order" : "DIFFERS"}`);
    let same = 0;
    let unitSame = 0;
    const differ: [string, string[]][] = [];
    const work = tempDir();
    try {
        for (const rel of [...unifiedQdir, "localtext.qb"]) {
            const a = codeLines(tool, path.join(unified, "src", `${rel}.ns`), work, true);
            const b = codeLines(tool, path.join(target, rel), work);
            if (a === b) {
                same += 1;
                continue;
            }
            // same units in another order?
            const ua = split(a)[1]
                .map((u) => norm(u[2]))
                .sort(compareStr);
            const ub = split(b)[1]
                .map((u) => norm(u[2]))
                .sort(compareStr);
            if (ua.length === ub.length && ua.every((x, i) => x === ub[i])) {
                unitSame += 1;
                continue;
            }
            const d = [...unifiedDiff(a.split("\n"), b.split("\n"), "merged", "installed", "", "", 0, "")];
            differ.push([rel, d]);
        }
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
    print(`${same} files the same code, ${unitSame} the same units in another order, ${differ.length} differ:`);
    for (const [rel, d] of differ) {
        print(`--- ${rel} (${d.length} diff lines)`);
        // (Latin-1 bytes, '?' for what isn't, as Python's .encode("latin-1", "replace"))
        const text = `${d.slice(0, 40).join("\n")}\n`.replace(/[^\x00-\xff]/gu, "?");
        process.stdout.write(Buffer.from(text, "latin1"));
    }
}

async function main(): Promise<number> {
    const { values, positionals } = parseCli(USAGE, {
        options: {
            unified: { type: "string" },
            game: { type: "string", default: "C:\\Games\\THUG2\\Game" },
            overlay: { type: "string" },
            thug1: { type: "string", default: THUG1_DEFAULT },
            ns: { type: "string", default: NS_DEFAULT },
        },
        allowPositionals: true,
    });
    const action = positionals[0];
    if (positionals.length !== 1 || !["extract", "check", "install"].includes(action!)) {
        process.stderr.write(`${USAGE}\n`);
        return 2;
    }
    if (!fs.existsSync(values.ns)) pyExit(nsMissing(values.ns));
    let game = values.game;
    // (the install root or the game folder itself: C:\Games\THUG2 -> C:\Games\THUG2\Game - lib/install.ts)
    game = resolveInstall(game, "thug2");
    const need = (value: string | undefined): string => {
        if (value === undefined) throw new TypeError("expected str, bytes or os.PathLike object, not NoneType");
        return value;
    };
    if (action === "extract") {
        extract(need(values.unified), game, values.ns, values.thug1);
    } else if (action === "check") {
        check(need(values.unified), values.overlay ?? pyJoin(game, "thug2-decomp-data"), values.ns);
    } else {
        // (without the overlay's edits - make_menu_level.ts installs it with them)
        const overlay = values.overlay ?? pyJoin(game, "thug2-decomp-data");
        print(install(game, overlay, values.ns, new Map(), new Map(), values.thug1) ?? "None");
    }
    return 0;
}

if (isMain(import.meta.url)) await runMain(() => main());
