// NOT ORIGINAL - number formatting and arithmetic the tools' output depends on, bit for bit: floats that stay
// floats in written data (Float), round-half-even, %g / %f / shortest float text, compensated sums and distances,
// floored division and modulo, strict number parsing, min / max of iterables.

import { quotedText } from "./text.ts";

// A Python float where JavaScript's number can't tell it from an int: a qb value (1.0 is written "1.0", 1 is "1"),
// a json.dump'd 1.0. Everything else uses plain numbers.
export class Float {
    readonly value: number;
    constructor(value: number) {
        this.value = value;
    }
}

// Python's round(x) of a float: to the nearest integer, halves to the even one (round(0.5) = 0, round(2.5) = 2) -
// not Math.round (halves up). Raises on inf / nan as Python.
export function roundHalfEven(x: number): number {
    if (!Number.isFinite(x)) throw new RangeError(`cannot round ${x} to an integer`);
    const f = Math.floor(x);
    const d = x - f; // (exact for every double)
    let r: number;
    if (d > 0.5) r = f + 1;
    else if (d < 0.5) r = f;
    else r = f % 2 === 0 ? f : f + 1;
    return r === 0 ? 0 : r; // (an int has no -0)
}

// Python's round(x, ndigits) of a float: the double nearest the exact value rounded to ndigits decimals, halves to
// even on the exact binary value (round(2.675, 2) = 2.67, round(0.125, 2) = 0.12).
export function roundTo(x: number, ndigits: number): number {
    if (!Number.isFinite(x)) return x;
    return Number.parseFloat(formatFixed(x, ndigits));
}

function decompose(x: number): { negative: boolean; mantissa: bigint; exponent: number } {
    // |x| = mantissa * 2^exponent exactly (x finite)
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    const hi = view.getUint32(0);
    const lo = view.getUint32(4);
    const negative = (hi & 0x80000000) !== 0;
    const biased = (hi >>> 20) & 0x7ff;
    let mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    let exponent: number;
    if (biased === 0) {
        exponent = -1074;
    } else {
        mantissa |= 1n << 52n;
        exponent = biased - 1075;
    }
    return { negative, mantissa, exponent };
}

// Python's "%.<digits>f" % x: the exact binary value correctly rounded (halves to even), the sign kept on a negative
// value that rounds to zero ("-0.000"), "inf" / "-inf" / "nan". (Number.toFixed rounds halves up and goes
// exponential from 1e21.)
export function formatFixed(x: number, digits: number): string {
    if (Number.isNaN(x)) return "nan";
    if (x === Number.POSITIVE_INFINITY) return "inf";
    if (x === Number.NEGATIVE_INFINITY) return "-inf";
    const { negative, mantissa, exponent } = decompose(x);
    const scale = 10n ** BigInt(digits);
    let q: bigint;
    if (exponent >= 0) {
        q = (mantissa << BigInt(exponent)) * scale;
    } else {
        const num = mantissa * scale;
        const den = 1n << BigInt(-exponent);
        q = num / den;
        const twice = (num % den) * 2n;
        if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;
    }
    let text = q.toString();
    if (digits > 0) {
        text = text.padStart(digits + 1, "0");
        text = `${text.slice(0, text.length - digits)}.${text.slice(text.length - digits)}`;
    }
    return (negative ? "-" : "") + text;
}

// Python's "%g" % x / "%.<precision>g" % x: `precision` significant digits (the exact binary value correctly
// rounded, halves to even: "%g" % 100.0625 == "100.062" - toPrecision rounds that half up), fixed notation for
// exponents -4 ... precision - 1, else d.ddde+XX; trailing zeros and a trailing point dropped; "-0", "inf", "nan".
export function formatG(x: number, precision = 6): string {
    if (Number.isNaN(x)) return "nan";
    if (x === Number.POSITIVE_INFINITY) return "inf";
    if (x === Number.NEGATIVE_INFINITY) return "-inf";
    const p = Math.max(precision, 1);
    const sign = x < 0 || Object.is(x, -0) ? "-" : "";
    if (x === 0) return `${sign}0`;
    const { mantissa, exponent } = decompose(x);
    // |x| = num / den exactly
    let num = exponent >= 0 ? mantissa << BigInt(exponent) : mantissa;
    let den = exponent >= 0 ? 1n : 1n << BigInt(-exponent);
    // the decimal exponent X: 10^X <= |x| < 10^(X + 1)
    let X = Math.floor(Math.log10(Math.abs(x)));
    const pow10 = (n: number): bigint => 10n ** BigInt(n);
    const atLeast = (e: number): boolean => (e >= 0 ? num >= pow10(e) * den : num * pow10(-e) >= den);
    while (!atLeast(X)) X -= 1;
    while (atLeast(X + 1)) X += 1;
    // digits = |x| / 10^(X - p + 1), rounded halves to even
    const shift = X - p + 1;
    if (shift >= 0) den *= pow10(shift);
    else num *= pow10(-shift);
    let digits = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && digits % 2n === 1n)) digits += 1n;
    if (digits === pow10(p)) {
        digits /= 10n;
        X += 1;
    }
    let text = digits.toString();
    const strip = (t: string): string => (t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t);
    if (X < -4 || X >= p) {
        const body = strip(text.length > 1 ? `${text[0]}.${text.slice(1)}` : text);
        return `${sign}${body}e${X < 0 ? "-" : "+"}${Math.abs(X).toString().padStart(2, "0")}`;
    }
    const decimals = p - 1 - X;
    if (decimals > 0) {
        text = text.padStart(decimals + 1, "0");
        text = `${text.slice(0, text.length - decimals)}.${text.slice(text.length - decimals)}`;
    }
    return sign + strip(text);
}

// The shortest digits that read back as x, and the decimal exponent: x = 0.d1d2d3... * 10^point.
function shortestDigits(x: number): { digits: string; point: number } {
    const text = String(Math.abs(x)); // (ECMAScript's Number::toString: the shortest round-trip digits)
    const e = text.indexOf("e");
    let mantissa = text;
    let exp = 0;
    if (e >= 0) {
        mantissa = text.slice(0, e);
        exp = Number.parseInt(text.slice(e + 1), 10);
    }
    const dot = mantissa.indexOf(".");
    let whole = mantissa;
    let fraction = "";
    if (dot >= 0) {
        whole = mantissa.slice(0, dot);
        fraction = mantissa.slice(dot + 1);
    }
    let digits = whole + fraction;
    let point = whole.length + exp;
    const lead = digits.length - digits.replace(/^0+/, "").length;
    digits = digits.slice(lead);
    point -= lead;
    digits = digits.replace(/0+$/, "");
    if (!digits) return { digits: "0", point: 1 };
    return { digits, point };
}

// Python's repr(float) / str(float): the shortest round-trip digits, fixed notation for exponents -4 ... 15
// ("0.0001", "1e-05", "1e+16", "100.0"), "inf", "nan", "-0.0". (JavaScript's String(number) switches at 1e-7 / 1e21
// and drops ".0".)
export function floatText(x: number): string {
    if (Number.isNaN(x)) return "nan";
    if (x === Number.POSITIVE_INFINITY) return "inf";
    if (x === Number.NEGATIVE_INFINITY) return "-inf";
    const sign = x < 0 || Object.is(x, -0) ? "-" : "";
    if (x === 0) return `${sign}0.0`;
    const { digits, point } = shortestDigits(x);
    const exp = point - 1; // x = d.ddd * 10^exp
    if (exp < -4 || exp >= 16) {
        const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
        const e = Math.abs(exp).toString().padStart(2, "0");
        return `${sign}${mantissa}e${exp < 0 ? "-" : "+"}${e}`;
    }
    if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

// Python's float(text): strict (no "", no hex, no trailing junk), whitespace and underscores between digits allowed,
// inf / nan / infinity in any case. Raises a ValueError-like RangeError otherwise.
export function parseFloatStrict(text: string): number {
    const t = text.trim();
    const special = t.toLowerCase().replace(/^[+-]/, "");
    if (special === "inf" || special === "infinity") {
        return t.startsWith("-") ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    }
    if (special === "nan") return Number.NaN;
    const number = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
    if (!number.test(t)) throw new RangeError(`could not convert string to float: ${quotedText(text)}`);
    return Number(t.replaceAll("_", ""));
}

// Python's sum() of floats (3.12+): Neumaier's compensated summation, not plain left-to-right addition - a sum of
// squares can differ in the last bit. (Python's sum of ints is exact: plain addition here.) An empty sum is 0.
export function sumOf(values: Iterable<number>): number {
    let total = 0;
    let c = 0;
    let first = true;
    for (const x of values) {
        if (first) {
            total = 0 + x;
            first = false;
            continue;
        }
        const t = total + x;
        if (Math.abs(total) >= Math.abs(x)) c += total - t + x;
        else c += x - t + total;
        total = t;
    }
    if (c !== 0 && Number.isFinite(c)) total += c;
    return total;
}

// Exact x * y as hi + lo (Dekker / Veltkamp; Python's dl_mul uses fma - the same exact result without overflow).
function twoProduct(x: number, y: number): [number, number] {
    const p = x * y;
    const SPLIT = 134217729; // 2^27 + 1
    let t = SPLIT * x;
    const xh = t - (t - x);
    const xl = x - xh;
    t = SPLIT * y;
    const yh = t - (t - y);
    const yl = y - yh;
    const lo = xh * yh - p + xh * yl + xl * yh + xl * yl;
    return [p, lo];
}

function fastSum(a: number, b: number): [number, number] {
    const x = a + b;
    const z = x - a;
    return [x, b - z];
}

const DBL_MIN = 2.2250738585072014e-308;

function frexpExponent(x: number): number {
    // e with x = m * 2^e, 0.5 <= m < 1 (x > 0, finite)
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    const biased = (view.getUint16(0) >>> 4) & 0x7ff;
    if (biased === 0) return frexpExponent(x * 2 ** 64) - 64;
    return biased - 1022;
}

// CPython's vector_norm (math.hypot / math.dist): scaled by the largest, squares and sums kept to double-double
// precision, one differential correction - correctly rounded in nearly all cases, so it can differ from
// Math.sqrt(sum of squares) and from Math.hypot in the last bit.
function vectorNorm(vec: number[], max: number, foundNan: boolean): number {
    if (max === Number.POSITIVE_INFINITY) return max;
    if (foundNan) return Number.NaN;
    if (max === 0 || vec.length <= 1) return max;
    const maxE = frexpExponent(max);
    if (maxE < -1023) {
        return (
            DBL_MIN *
            vectorNorm(
                vec.map((v) => v / DBL_MIN),
                max / DBL_MIN,
                foundNan,
            )
        );
    }
    const scale = 2 ** -maxE;
    let csum = 1.0;
    let frac1 = 0.0;
    let frac2 = 0.0;
    for (const v of vec) {
        const x = v * scale;
        const [hi, lo] = twoProduct(x, x);
        const [sHi, sLo] = fastSum(csum, hi);
        csum = sHi;
        frac1 += lo;
        frac2 += sLo;
    }
    let h = Math.sqrt(csum - 1.0 + (frac1 + frac2));
    const [hi, lo] = twoProduct(-h, h);
    const [sHi, sLo] = fastSum(csum, hi);
    csum = sHi;
    frac1 += lo;
    frac2 += sLo;
    const x = csum - 1.0 + (frac1 + frac2);
    h += x / (2.0 * h);
    return h / scale;
}

// Python's math.dist(p, q).
export function distanceOf(p: readonly number[], q: readonly number[]): number {
    if (p.length !== q.length) throw new RangeError("both points must have the same number of dimensions");
    const diffs: number[] = [];
    let max = 0.0;
    let foundNan = false;
    for (let i = 0; i < p.length; i++) {
        const x = Math.abs(p[i]! - q[i]!);
        diffs.push(x);
        if (Number.isNaN(x)) foundNan = true;
        if (x > max) max = x;
    }
    return vectorNorm(diffs, max, foundNan);
}

// Python's math.hypot(*values).
export function hypotOf(...values: number[]): number {
    const vec = values.map(Math.abs);
    let max = 0.0;
    let foundNan = false;
    for (const x of vec) {
        if (Number.isNaN(x)) foundNan = true;
        if (x > max) max = x;
    }
    return vectorNorm(vec, max, foundNan);
}

// Python's floor division and modulo (the result takes the divisor's sign: -7 // 2 = -4, -7 % 2 = 1).
export function floorDiv(a: number, b: number): number {
    if (b === 0) throw new RangeError("integer division or modulo by zero");
    return Math.floor(a / b);
}

export function floorMod(a: number, b: number): number {
    if (b === 0) throw new RangeError("integer division or modulo by zero");
    const r = a % b;
    return r !== 0 && r < 0 !== b < 0 ? r + b : r;
}

// int.from_bytes(data, "little", signed=...) of up to 6 bytes (0 for none).
export function intFromBytesLE(data: Uint8Array, signed = false): number {
    if (data.length > 6) throw new RangeError("intFromBytesLE: more than 6 bytes - use BigInt");
    let value = 0;
    for (let i = data.length - 1; i >= 0; i--) value = value * 256 + data[i]!;
    if (signed && data.length && data[data.length - 1]! & 0x80) value -= 2 ** (8 * data.length);
    return value;
}

// Python's int(text, 16): hex digits (underscores between them, an optional 0x, a sign, surrounding whitespace);
// raises otherwise (parseInt would stop quietly at the first bad character).
export function parseHexInt(text: string): number {
    const m = /^\s*([+-]?)(?:0[xX]_?)?([0-9A-Fa-f](?:_?[0-9A-Fa-f])*)\s*$/.exec(text);
    if (!m) throw new RangeError(`invalid literal for int() with base 16: ${quotedText(text)}`);
    const value = Number.parseInt(m[2]!.replaceAll("_", ""), 16);
    return m[1] === "-" ? -value : value;
}

// Python's int(text) (base 10): strict, surrounding whitespace, a sign and underscores between digits allowed.
export function parseIntStrict(text: string): number {
    const m = /^\s*([+-]?\d(?:_?\d)*)\s*$/.exec(text);
    if (!m) throw new RangeError(`invalid literal for int() with base 10: ${quotedText(text)}`);
    return Number.parseInt(m[1]!.replaceAll("_", ""), 10);
}

// Python's max() / min() of numbers: the first of the greatest / least (a NaN is kept only when first - Math.max
// gives NaN for any NaN), raising on an empty sequence; no argument-count limit (Math.max(...a) overflows the stack
// for big arrays).
export function maxOf(values: Iterable<number>): number {
    let best: number | undefined;
    for (const v of values) if (best === undefined || v > best) best = v;
    if (best === undefined) throw new RangeError("max() arg is an empty sequence");
    return best;
}

export function minOf(values: Iterable<number>): number {
    let best: number | undefined;
    for (const v of values) if (best === undefined || v < best) best = v;
    if (best === undefined) throw new RangeError("min() arg is an empty sequence");
    return best;
}

// Python's min(items, key=key) / max(items, key=key): the first item with the least / greatest key.
export function minBy<T>(items: Iterable<T>, key: (item: T) => number): T {
    let best: T | undefined;
    let bestKey = 0;
    let found = false;
    for (const item of items) {
        const k = key(item);
        if (!found || k < bestKey) {
            best = item;
            bestKey = k;
            found = true;
        }
    }
    if (!found) throw new RangeError("min() arg is an empty sequence");
    return best as T;
}

// Python's sorted() of numbers (Array.sort without a comparator sorts as text: [10, 9] stays [10, 9]).
export function sortedNumbers(values: Iterable<number>): number[] {
    return [...values].sort((a, b) => a - b);
}
