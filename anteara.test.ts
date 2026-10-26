// Anteara Mod's tool: unit keys and normalised code (moved from the content pipeline's menu_level tests), and the
// edits format (edits.ts) on made-up text.

import assert from "node:assert/strict";
import { test } from "node:test";
import { keyOf, norm } from "./anteara.ts";
import { applyOps, formatEdits, literalChars, makeOps, parseEdits, shareLines } from "./lib/edits.ts";

test("anteara's unit keys and normalised code", () => {
    assert.equal(keyOf("Load_TestLevel"), "#260db59e");
    assert.equal(keyOf("`Load_TestLevel`"), "#260db59e");
    assert.equal(keyOf("#ABCDEF01"), "#abcdef01");
    assert.equal(norm('foo = { // x\n  bar  "a  b" }'), '#de9a8c73 = { // #7ce92373 #55730089 "a b" }');
});

const SRC = [
    "script alpha {",
    "    first_call one=1 two=2 three=3 ",
    "    second_call ",
    "    if something {",
    "        third_call value=100 other=200 ",
    "    } ",
    "    moved_call_here with=params ",
    "} ",
    "",
];

test("edits: operations rebuild the target exactly", () => {
    const tgt = [
        "script beta {",
        "    moved_call_here with=params ",
        "    first_call one=1 two=5 three=3 ",
        "    my_own_line ",
        "    if something {",
        "        third_call value=100 other=200 ",
        "    } ",
        "",
        "} ",
        "",
    ];
    const ops = makeOps(SRC, tgt);
    assert.deepEqual(applyOps(SRC, ops, "test"), tgt);
    // the changed number is an in-line edit, the moved line a copy: only the mod's own text is stored
    assert.ok(ops.includes("~ 2 25 1 5"), ops.join("\n"));
    assert.ok(ops.includes("= 7"), ops.join("\n"));
    assert.ok(!ops.some((op) => op.includes("first_call") || op.includes("moved_call_here")), ops.join("\n"));
    assert.deepEqual(makeOps(SRC, SRC), ["= 1-9"]);
    assert.deepEqual(applyOps([], makeOps([], ["a", "", " b "]), "test"), ["a", "", " b "]);
    assert.equal(literalChars(["= 1-4", "+ abc", "+", "~ 3 1 2 xy"]), 4 + 1 + 3);
    assert.throws(() => applyOps(SRC, ["= 10"], "test"), /line 10 is not in its source/);
});

test("edits: lines from other units ('with' sources)", () => {
    const other = ["script gamma {", "    shared_long_line_of_the_game a=1 ", "    and_its_next_line b=2 ", "} "];
    const ops = ["= 1", "+     shared_long_line_of_the_game a=1 ", "+     and_its_next_line b=2 ", "+ own"];
    const [shared, ids] = shareLines(
        ops,
        (line) => (other.includes(line) ? [["gamma", other.indexOf(line)]] : []),
        () => other,
    );
    assert.deepEqual(shared, ["= 1", "= 2-3 @1", "+ own"]);
    assert.deepEqual(ids, ["gamma"]);
    assert.deepEqual(applyOps(SRC, shared, "test", [other]), [SRC[0], other[1], other[2], "own"]);
});

test("edits: the file format round-trips", () => {
    const text = [
        "# a comment",
        "base 0123abcd",
        "remove old_unit",
        "unit alpha",
        "= 1-3",
        "~ 4 2 0 x",
        "new beta",
        "after alpha",
        "from 89abcdef game\\menu\\x.qb gamma",
        "with 01234567 game\\y.qb `odd name`",
        "= 1 @1",
        "+ text with trailing space ",
        "+",
        "new delta",
        "first",
        "+ d",
        "register",
        "~ 1 22 0  extra names",
        "",
    ].join("\n");
    const edits = parseEdits(text, "test");
    assert.equal(edits.base, "0123abcd");
    assert.equal(edits.blocks.length, 5);
    assert.deepEqual(edits.blocks[2]!.with, [{ crc: "01234567", file: "game\\y.qb", name: "`odd name`" }]);
    assert.equal(edits.blocks[3]!.after, "");
    assert.equal(formatEdits(edits), text);
    assert.throws(() => parseEdits("= 1\n", "test"), /outside a unit/);
});
