// NOT ORIGINAL - the games' file archives, read: THUG2's .prx and THUG1's .pre are the same format (a cut-down copy of
// the content pipeline's level_port/prx.ts, so this repository stands alone).
//   i32 total size, u32 version, i32 file count, then per file {i32 size, i32 compressed size (0: stored),
//   i16 name size, u16 use count, u32 checksum}, its name, and its data (LZSS when compressed) padded to 4 bytes.

import * as fs from "node:fs";

// The LZSS the archives use: a 4096-byte window filled with spaces, writing from 4096 - 18.
export function lzssDecode(data: Uint8Array, size: number): Buffer {
    const window = Buffer.alloc(4096, 0x20);
    let r = 4096 - 18;
    const out = Buffer.alloc(Math.max(0, size) + 18);
    let length = 0;
    let i = 0;
    let flags = 0;
    while (length < size && i < data.length) {
        flags >>= 1;
        if (!(flags & 0x100)) {
            flags = data[i]! | 0xff00;
            i += 1;
        }
        if (flags & 1) {
            if (i >= data.length) break;
            const c = data[i]!;
            i += 1;
            out[length++] = c;
            window[r] = c;
            r = (r + 1) & 4095;
        } else {
            if (i + 1 >= data.length) break;
            const position = data[i]! | ((data[i + 1]! & 0xf0) << 4);
            const last = (data[i + 1]! & 0x0f) + 2;
            i += 2;
            for (let k = 0; k < last + 1; k++) {
                const c = window[(position + k) & 4095]!;
                out[length++] = c;
                window[r] = c;
                r = (r + 1) & 4095;
            }
        }
    }
    return Buffer.from(out.subarray(0, length));
}

// An archive's files: name (as stored, lower case, "\" separators) -> data.
export function prxFiles(file: string): Map<string, Buffer> {
    const data = fs.readFileSync(file);
    const files = new Map<string, Buffer>();
    const count = data.readInt32LE(8);
    let offset = 12;
    for (let k = 0; k < count; k++) {
        const size = data.readInt32LE(offset);
        const compressed = data.readInt32LE(offset + 4);
        const nameSize = data.readInt16LE(offset + 8);
        const stored = compressed || size;
        const body = offset + 16 + nameSize;
        const rawName = data.subarray(offset + 16, body);
        const nul = rawName.indexOf(0);
        const name = (nul >= 0 ? rawName.subarray(0, nul) : rawName).toString("latin1");
        const raw = data.subarray(body, body + stored);
        files.set(fileKey(name), compressed ? lzssDecode(raw, size) : Buffer.from(raw));
        offset = body + ((stored + 3) & ~3);
    }
    return files;
}

export function fileKey(name: string): string {
    return name.toLowerCase().replaceAll("/", "\\");
}
