// NOT ORIGINAL - where the THUG2 decompilation checkout around this repository is (the decomp's submodule
// tools/anteara; a copy of the content pipeline's lib/decomp.ts, cut down). Found by walking up from this repository to
// the first folder with the decomp's CMakeLists.txt and src/game (or THUG2_DECOMP=<folder>), never a fixed depth.
// Only the default --ns comes from it: NeverScript's ns.exe, which the decomp builds into out\neverscript
// (tools\build_neverscript.ps1). On its own this repository needs --ns.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const isDecompRoot = (dir: string): boolean =>
    fs.existsSync(path.join(dir, "CMakeLists.txt")) && fs.existsSync(path.join(dir, "src", "game"));

export function findDecompRoot(start: string = ROOT): string | null {
    const env = process.env.THUG2_DECOMP;
    if (env) return isDecompRoot(env) ? path.resolve(env) : null;
    for (let dir = path.dirname(path.resolve(start)); ; dir = path.dirname(dir)) {
        if (isDecompRoot(dir)) return dir;
        if (path.dirname(dir) === dir) return null;
    }
}

export const DECOMP: string | null = findDecompRoot();
export const NS_DEFAULT: string = path.join(DECOMP ?? ROOT, "out", "neverscript", "ns.exe");

export const nsMissing = (ns: string): string =>
    DECOMP
        ? `${ns} not found: build it with tools\\build_neverscript.ps1 (in the decomp) or pass --ns`
        : `${ns} not found: NeverScript's ns.exe is built by the THUG2 decomp (tools\\build_neverscript.ps1); pass --ns <ns.exe>`;
