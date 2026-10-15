import { describe, expect, it } from 'vitest';
import { describeTable, FbTable, readRoot, tryReadRoot } from './fb.ts';

/**
 * A tiny FlatBuffers writer used only by these tests, so the reader is checked
 * against buffers built to the real layout rather than captured bytes we would
 * have to trust. Alignment padding is skipped: the reader uses unaligned reads.
 */
type FieldSpec =
  | { slot: number; type: 'f64'; value: number }
  | { slot: number; type: 'i64'; value: bigint }
  | { slot: number; type: 'i32'; value: number }
  | { slot: number; type: 'u8'; value: number }
  | { slot: number; type: 'str'; value: string }
  | { slot: number; type: 'table'; value: FieldSpec[] }
  | { slot: number; type: 'tables'; value: FieldSpec[][] };

const INLINE_SIZE = { f64: 8, i64: 8, i32: 4, u8: 1, str: 4, table: 4, tables: 4 } as const;

/** Build a FlatBuffers buffer whose root is the given table. */
function build(fields: FieldSpec[]): Buffer {
  const buf = Buffer.alloc(8192);
  let cursor = 4; // reserve the root uoffset
  const patches: Array<() => void> = [];

  const writeTable = (specs: FieldSpec[]): number => {
    const slots = Math.max(...specs.map((f) => f.slot)) + 1;
    const vtableSize = 4 + slots * 2;
    const vtablePos = cursor;
    cursor += vtableSize;

    // Assign inline offsets in slot order, starting after the soffset.
    const voffsets = new Array<number>(slots).fill(0);
    let inline = 4;
    const ordered = [...specs].sort((a, b) => a.slot - b.slot);
    for (const field of ordered) {
      voffsets[field.slot] = inline;
      inline += INLINE_SIZE[field.type];
    }

    const tablePos = cursor;
    cursor += inline;

    buf.writeUInt16LE(vtableSize, vtablePos);
    buf.writeUInt16LE(inline, vtablePos + 2);
    for (let i = 0; i < slots; i++) buf.writeUInt16LE(voffsets[i]!, vtablePos + 4 + i * 2);
    buf.writeInt32LE(tablePos - vtablePos, tablePos);

    for (const field of ordered) {
      const at = tablePos + voffsets[field.slot]!;
      switch (field.type) {
        case 'f64':
          buf.writeDoubleLE(field.value, at);
          break;
        case 'i64':
          buf.writeBigInt64LE(field.value, at);
          break;
        case 'i32':
          buf.writeInt32LE(field.value, at);
          break;
        case 'u8':
          buf.writeUInt8(field.value, at);
          break;
        case 'str':
          patches.push(() => {
            const strPos = cursor;
            buf.writeUInt32LE(field.value.length, strPos);
            buf.write(field.value, strPos + 4, 'utf8');
            cursor += 4 + field.value.length;
            buf.writeUInt32LE(strPos - at, at);
          });
          break;
        case 'table':
          patches.push(() => {
            const child = writeTable(field.value);
            buf.writeUInt32LE(child - at, at);
          });
          break;
        case 'tables':
          patches.push(() => {
            // Reserve the vector before writing children so every uoffset
            // points forward, the way a real FlatBuffers encoder emits them.
            const count = field.value.length;
            const vecPos = cursor;
            cursor += 4 + count * 4;
            buf.writeUInt32LE(count, vecPos);
            buf.writeUInt32LE(vecPos - at, at);
            field.value.forEach((spec, i) => {
              const child = writeTable(spec);
              const elem = vecPos + 4 + i * 4;
              buf.writeUInt32LE(child - elem, elem);
            });
          });
          break;
      }
    }
    return tablePos;
  };

  const root = writeTable(fields);
  buf.writeUInt32LE(root, 0);
  // Patches append out-of-line data; run until none are left to queue more.
  while (patches.length > 0) patches.shift()!();
  return buf.subarray(0, cursor);
}

const HASH = 'a'.repeat(63) + 'b';

describe('FbTable scalars', () => {
  const buf = build([
    { slot: 0, type: 'f64', value: 2.31 },
    { slot: 1, type: 'f64', value: -1.5 },
    { slot: 2, type: 'str', value: HASH },
    { slot: 3, type: 'i64', value: 1_757_500_000_000n },
    { slot: 4, type: 'i32', value: -42 },
    { slot: 5, type: 'u8', value: 1 },
  ]);
  const table = readRoot(buf);

  it('reads doubles, ints, strings and booleans by slot', () => {
    expect(table.f64(0)).toBeCloseTo(2.31, 12);
    expect(table.f64(1)).toBeCloseTo(-1.5, 12);
    expect(table.str(2)).toBe(HASH);
    expect(table.i64(3)).toBe(1_757_500_000_000);
    expect(table.i64raw(3)).toBe(1_757_500_000_000n);
    expect(table.i32(4)).toBe(-42);
    expect(table.u8(5)).toBe(1);
    expect(table.bool(5)).toBe(true);
  });

  it('reports the slot count and which slots are present', () => {
    expect(table.fieldCount).toBe(6);
    expect(table.has(0)).toBe(true);
    expect(table.has(5)).toBe(true);
    expect(table.has(6)).toBe(false);
  });

  it('returns undefined for slots past the vtable instead of garbage', () => {
    expect(table.f64(6)).toBeUndefined();
    expect(table.str(99)).toBeUndefined();
    expect(table.i64(-1)).toBeUndefined();
    expect(table.table(6)).toBeUndefined();
  });
});

describe('FbTable absent fields', () => {
  it('treats a zero voffset as an absent field', () => {
    // Slot 1 is never written, so its voffset stays 0.
    const buf = build([
      { slot: 0, type: 'f64', value: 7 },
      { slot: 2, type: 'f64', value: 9 },
    ]);
    const table = readRoot(buf);
    expect(table.f64(0)).toBe(7);
    expect(table.has(1)).toBe(false);
    expect(table.f64(1)).toBeUndefined();
    expect(table.f64(2)).toBe(9);
  });
});

describe('FbTable nested tables and vectors', () => {
  const buf = build([
    {
      slot: 0,
      type: 'table',
      value: [
        { slot: 0, type: 'i64', value: 13_600_000n },
        { slot: 1, type: 'f64', value: 4.44 },
        { slot: 2, type: 'str', value: HASH },
      ],
    },
    {
      slot: 1,
      type: 'tables',
      value: [
        [{ slot: 0, type: 'f64', value: 10 }],
        [{ slot: 0, type: 'f64', value: 20 }],
        [{ slot: 0, type: 'f64', value: 30 }],
      ],
    },
    { slot: 2, type: 'f64', value: 0.01 },
  ]);
  const table = readRoot(buf);

  it('descends into a nested table', () => {
    const nested = table.table(0)!;
    expect(nested).toBeInstanceOf(FbTable);
    expect(nested.i64(0)).toBe(13_600_000);
    expect(nested.f64(1)).toBeCloseTo(4.44, 12);
    expect(nested.str(2)).toBe(HASH);
  });

  it('reads a vector of tables by index and in bulk', () => {
    expect(table.vectorLength(1)).toBe(3);
    expect(table.vectorTable(1, 0)!.f64(0)).toBe(10);
    expect(table.vectorTable(1, 2)!.f64(0)).toBe(30);
    expect(table.vectorTable(1, 3)).toBeUndefined();
    expect(table.vectorTables(1).map((t) => t.f64(0))).toEqual([10, 20, 30]);
  });

  it('reports zero length for a missing vector', () => {
    expect(table.vectorLength(9)).toBe(0);
    expect(table.vectorTables(9)).toEqual([]);
  });

  it('still reads sibling scalars after the variable-length fields', () => {
    expect(table.f64(2)).toBeCloseTo(0.01, 12);
  });
});

describe('malformed input', () => {
  it('throws on a payload too short to hold a table', () => {
    expect(() => readRoot(Buffer.alloc(4))).toThrow(/too short/);
  });

  it('throws when the root offset points outside the buffer', () => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(9999, 0);
    expect(() => readRoot(buf)).toThrow(/outside buffer/);
  });

  it('throws when the vtable offset is nonsense', () => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(8, 0);
    buf.writeInt32LE(-9999, 8); // vtable would sit past the end
    expect(() => readRoot(buf)).toThrow(/vtable/);
  });

  it('tryReadRoot returns null rather than throwing', () => {
    expect(tryReadRoot(Buffer.alloc(4))).toBeNull();
    expect(tryReadRoot(build([{ slot: 0, type: 'f64', value: 1 }]))).not.toBeNull();
  });

  it('refuses an int64 too large to be a safe number', () => {
    const buf = build([{ slot: 0, type: 'i64', value: 9_007_199_254_740_995n }]);
    const table = readRoot(buf);
    expect(() => table.i64(0)).toThrow(/not a safe number/);
    expect(table.i64raw(0)).toBe(9_007_199_254_740_995n);
  });
});

describe('describeTable', () => {
  it('flags the fields that look like a hash, a timestamp and a bust', () => {
    const buf = build([
      { slot: 0, type: 'f64', value: 2.31 },
      { slot: 1, type: 'f64', value: 0 },
      { slot: 2, type: 'str', value: HASH },
      { slot: 3, type: 'i64', value: 1_757_500_000_000n },
    ]);
    const guesses = describeTable(readRoot(buf));
    expect(guesses).toHaveLength(4);

    const hash = guesses.find((g) => g.looksLikeGameHash)!;
    expect(hash.index).toBe(2);
    expect(hash.asString).toBe(HASH);

    const created = guesses.find((g) => g.looksLikeMsEpoch)!;
    expect(created.index).toBe(3);

    expect(guesses[0]!.looksLikeBust).toBe(true);
    expect(guesses[0]!.asF64).toBeCloseTo(2.31, 12);
    // A bust is never below 1, so a zero field must not be mistaken for one.
    expect(guesses[1]!.looksLikeBust).toBe(false);
  });

  it('reports each field offset relative to the table', () => {
    const guesses = describeTable(readRoot(build([{ slot: 0, type: 'f64', value: 1.5 }])));
    expect(guesses[0]!.offset).toBe(4);
  });
});
