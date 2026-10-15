/**
 * Minimal FlatBuffers reader.
 *
 * Bustabit does not publish its schemas, so rather than generate code we read
 * the handful of tables we need directly. FlatBuffers is simple enough to
 * decode by hand: a table is a vtable of field offsets followed by inline data,
 * and anything variable-length is reached through a relative offset.
 *
 * Every field access is bounds-checked and returns undefined when the field is
 * absent, so a schema change surfaces as a missing field rather than garbage.
 */

export class FbTable {
  readonly buf: Buffer;
  readonly pos: number;
  private readonly vtable: number;
  private readonly vtableSize: number;

  constructor(buf: Buffer, pos: number) {
    if (pos < 0 || pos + 4 > buf.length) {
      throw new RangeError(`flatbuffers: table position ${pos} outside buffer of ${buf.length}`);
    }
    this.buf = buf;
    this.pos = pos;
    this.vtable = pos - buf.readInt32LE(pos);
    if (this.vtable < 0 || this.vtable + 2 > buf.length) {
      throw new RangeError(`flatbuffers: vtable at ${this.vtable} outside buffer of ${buf.length}`);
    }
    this.vtableSize = buf.readUInt16LE(this.vtable);
    if (this.vtableSize < 4 || this.vtable + this.vtableSize > buf.length) {
      throw new RangeError(`flatbuffers: vtable size ${this.vtableSize} is not usable`);
    }
  }

  /** Number of field slots this table's vtable describes. */
  get fieldCount(): number {
    return Math.max(0, (this.vtableSize - 4) >> 1);
  }

  /** Absolute position of a field's data, or undefined when the field is absent. */
  fieldPos(index: number): number | undefined {
    const slot = this.vtable + 4 + index * 2;
    if (index < 0 || slot + 2 > this.vtable + this.vtableSize) return undefined;
    const offset = this.buf.readUInt16LE(slot);
    if (offset === 0) return undefined;
    const at = this.pos + offset;
    return at < this.buf.length ? at : undefined;
  }

  has(index: number): boolean {
    return this.fieldPos(index) !== undefined;
  }

  f64(index: number): number | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 8 > this.buf.length) return undefined;
    return this.buf.readDoubleLE(at);
  }

  f32(index: number): number | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 4 > this.buf.length) return undefined;
    return this.buf.readFloatLE(at);
  }

  i32(index: number): number | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 4 > this.buf.length) return undefined;
    return this.buf.readInt32LE(at);
  }

  u32(index: number): number | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 4 > this.buf.length) return undefined;
    return this.buf.readUInt32LE(at);
  }

  u8(index: number): number | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 1 > this.buf.length) return undefined;
    return this.buf.readUInt8(at);
  }

  bool(index: number): boolean | undefined {
    const value = this.u8(index);
    return value === undefined ? undefined : value !== 0;
  }

  i64raw(index: number): bigint | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 8 > this.buf.length) return undefined;
    return this.buf.readBigInt64LE(at);
  }

  /** 64-bit integer as a number. Throws if it cannot be represented exactly. */
  i64(index: number): number | undefined {
    const value = this.i64raw(index);
    if (value === undefined) return undefined;
    if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
      throw new RangeError(`flatbuffers: int64 field ${index} (${value}) is not a safe number`);
    }
    return Number(value);
  }

  str(index: number): string | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 4 > this.buf.length) return undefined;
    const start = at + this.buf.readUInt32LE(at);
    if (start + 4 > this.buf.length) return undefined;
    const length = this.buf.readUInt32LE(start);
    const from = start + 4;
    if (from + length > this.buf.length) return undefined;
    return this.buf.toString('utf8', from, from + length);
  }

  table(index: number): FbTable | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 4 > this.buf.length) return undefined;
    const target = at + this.buf.readUInt32LE(at);
    if (target + 4 > this.buf.length) return undefined;
    try {
      return new FbTable(this.buf, target);
    } catch {
      return undefined;
    }
  }

  /** Start position and length of a vector field. */
  private vector(index: number): { start: number; length: number } | undefined {
    const at = this.fieldPos(index);
    if (at === undefined || at + 4 > this.buf.length) return undefined;
    const target = at + this.buf.readUInt32LE(at);
    if (target + 4 > this.buf.length) return undefined;
    return { start: target + 4, length: this.buf.readUInt32LE(target) };
  }

  vectorLength(index: number): number {
    return this.vector(index)?.length ?? 0;
  }

  /** Element `i` of a vector of tables. */
  vectorTable(index: number, i: number): FbTable | undefined {
    const vec = this.vector(index);
    if (!vec || i < 0 || i >= vec.length) return undefined;
    const at = vec.start + i * 4;
    if (at + 4 > this.buf.length) return undefined;
    try {
      return new FbTable(this.buf, at + this.buf.readUInt32LE(at));
    } catch {
      return undefined;
    }
  }

  /** Every element of a vector of tables. */
  vectorTables(index: number): FbTable[] {
    const out: FbTable[] = [];
    const length = this.vectorLength(index);
    for (let i = 0; i < length; i++) {
      const table = this.vectorTable(index, i);
      if (table) out.push(table);
    }
    return out;
  }
}

/** Read the root table of a FlatBuffers payload. */
export function readRoot(buf: Buffer): FbTable {
  if (buf.length < 8) {
    throw new RangeError(`flatbuffers: payload of ${buf.length} bytes is too short for a table`);
  }
  return new FbTable(buf, buf.readUInt32LE(0));
}

/** Read the root table, returning null instead of throwing on malformed input. */
export function tryReadRoot(buf: Buffer): FbTable | null {
  try {
    return readRoot(buf);
  } catch {
    return null;
  }
}

export interface FieldGuess {
  index: number;
  offset: number;
  asF64: number | null;
  asF32: number | null;
  asI32: number | null;
  asI64: string | null;
  asString: string | null;
  looksLikeGameHash: boolean;
  looksLikeMsEpoch: boolean;
  looksLikeBust: boolean;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Describe every field slot of a table with each plausible interpretation.
 * Used once by discovery mode to pin field indices against real frames, so the
 * decoders never have to guess at runtime.
 */
export function describeTable(table: FbTable): FieldGuess[] {
  const out: FieldGuess[] = [];
  for (let index = 0; index < table.fieldCount; index++) {
    const offset = table.fieldPos(index);
    if (offset === undefined) continue;
    let asI64: string | null = null;
    try {
      asI64 = table.i64raw(index)?.toString() ?? null;
    } catch {
      asI64 = null;
    }
    const asString = safeString(table, index);
    const asF64 = table.f64(index) ?? null;
    const i64Number = asI64 === null ? null : Number(asI64);
    out.push({
      index,
      offset: offset - table.pos,
      asF64,
      asF32: table.f32(index) ?? null,
      asI32: table.i32(index) ?? null,
      asI64,
      asString,
      looksLikeGameHash: asString !== null && HEX64.test(asString),
      looksLikeMsEpoch:
        i64Number !== null && i64Number > 1_400_000_000_000 && i64Number < 4_000_000_000_000,
      looksLikeBust:
        asF64 !== null && Number.isFinite(asF64) && asF64 >= 1 && asF64 < 1_000_000,
    });
  }
  return out;
}

function safeString(table: FbTable, index: number): string | null {
  try {
    const value = table.str(index);
    if (value === undefined) return null;
    // Reject strings that are almost certainly a misread of binary data.
    return /^[\x20-\x7e]*$/.test(value) && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
