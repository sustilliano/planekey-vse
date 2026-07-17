'use strict';
// mmx.js — JS port of uknocked-mmx's mmx_pack_bytes / mmx_unpack_bytes,
// BYTE-COMPATIBLE with the Rust crate (products/bridge/crates/uknocked-mmx)
// so a blob packed here round-trips through the bridge to a Rust server-core
// (and back) without re-encoding.
//
// Wire format (uknocked-mmx/src/lib.rs::MMXHeader::to_bytes + mmx_pack_bytes):
//   header[32]:
//     [0..4]   magic "MMX\0"
//     [4..8]   version  u32 LE  (= 2)
//     [8..12]  dims     u32 LE  (= 1 for a flat byte payload)
//     [12]     compression u8   (0 None | 1 Lz4 | 2 Zstd-passthrough)
//     [13]     dtype    u8       (3 = U32, what mmx_pack_bytes uses)
//     [14]     has_metadata u8   (0)
//     [15]     padding  u8       (0)
//     [16..24] total_size      u64 LE  (length of the raw len-prefixed body)
//     [24..32] compressed_size u64 LE
//   body: <compressed>( payload_len u64 LE | payload )
//
// pkclient packs with CompressionType::None (0) — no third-party deps. Unpack
// also accepts Zstd (2), which the Rust build treats as pass-through. Lz4 (1)
// unpack would need an lz4 decoder; pkclient never packs Lz4, so it throws
// with a clear message rather than guessing.

const MMX_MAGIC = Buffer.from([0x4d, 0x4d, 0x58, 0x00]); // "MMX\0"
const MMX_VERSION = 2;
const DIMS_FLAT = 1;
const DTYPE_U32 = 3;
const COMPRESSION_NONE = 0;
const COMPRESSION_LZ4 = 1;
const COMPRESSION_ZSTD = 2;

/** Pack arbitrary bytes as an MMX (None-compression) blob. */
function mmxPackBytes(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  // raw = u64 length prefix + payload (matches Rust; makes trailing padding
  // unambiguous on read).
  const raw = Buffer.alloc(8 + buf.length);
  raw.writeBigUInt64LE(BigInt(buf.length), 0);
  buf.copy(raw, 8);
  // None compression → compressed === raw.
  const header = Buffer.alloc(32);
  MMX_MAGIC.copy(header, 0);
  header.writeUInt32LE(MMX_VERSION, 4);
  header.writeUInt32LE(DIMS_FLAT, 8);
  header.writeUInt8(COMPRESSION_NONE, 12);
  header.writeUInt8(DTYPE_U32, 13);
  header.writeUInt8(0, 14); // has_metadata
  header.writeUInt8(0, 15); // padding
  header.writeBigUInt64LE(BigInt(raw.length), 16); // total_size
  header.writeBigUInt64LE(BigInt(raw.length), 24); // compressed_size (== total for None)
  return Buffer.concat([header, raw]);
}

/** Reverse of mmxPackBytes — returns the exact original bytes. */
function mmxUnpackBytes(mmx) {
  const buf = Buffer.isBuffer(mmx) ? mmx : Buffer.from(mmx);
  if (buf.length < 32) throw new Error('short MMX payload');
  if (!buf.subarray(0, 4).equals(MMX_MAGIC)) throw new Error('invalid MMX magic');
  const compression = buf.readUInt8(12);
  let body;
  if (compression === COMPRESSION_NONE || compression === COMPRESSION_ZSTD) {
    body = buf.subarray(32); // None + Zstd(pass-through) are stored raw
  } else if (compression === COMPRESSION_LZ4) {
    throw new Error('MMX Lz4 unpack needs an lz4 decoder; pkclient only packs None');
  } else {
    throw new Error(`unknown MMX compression byte ${compression}`);
  }
  if (body.length < 8) throw new Error('missing length prefix');
  const len = Number(body.readBigUInt64LE(0));
  if (body.length < 8 + len) throw new Error('payload shorter than declared length');
  return body.subarray(8, 8 + len);
}

// ── N-dimensional typed multimedia / tensor path ──────────────────────────
// Mirrors uknocked-mmx::mmx_pack_tensor. Lets a pkclient-enabled device (or
// the web side of the Tauri UI) exchange TYPED N-dim tensors — a robot command
// [n], a camera frame [h,w,c] U8, an inference tensor [n,d] F32 — with a Rust
// server-core / bridge, self-describing (bytes + shape + dtype). Same 32-byte
// header; layout before compression: shape(dims × u64 LE) ++ raw payload.
const DTYPE = { F32: 0, F16: 1, I32: 2, U32: 3, F64: 4, I64: 5, U8: 6, U16: 7 };
const DTYPE_SIZE = { 0: 4, 1: 2, 2: 4, 3: 4, 4: 8, 5: 8, 6: 1, 7: 2 };

/** Pack raw element bytes + shape + dtype into an MMX tensor envelope (None). */
function mmxPackTensor(payload, shape, dtype) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const nElems = shape.length ? shape.reduce((a, b) => a * b, 1) : 0;
  const elem = DTYPE_SIZE[dtype];
  if (elem && buf.length !== nElems * elem) {
    throw new Error(`payload ${buf.length} bytes != shape ${JSON.stringify(shape)} × ${elem} bytes/elem`);
  }
  const raw = Buffer.alloc(shape.length * 8 + buf.length);
  shape.forEach((d, i) => raw.writeBigUInt64LE(BigInt(d), i * 8));
  buf.copy(raw, shape.length * 8);
  const header = Buffer.alloc(32);
  MMX_MAGIC.copy(header, 0);
  header.writeUInt32LE(MMX_VERSION, 4);
  header.writeUInt32LE(shape.length, 8); // dims
  header.writeUInt8(0, 12);              // None
  header.writeUInt8(dtype, 13);
  header.writeUInt8(0, 14);
  header.writeUInt8(0, 15);
  header.writeBigUInt64LE(BigInt(raw.length), 16); // total_size
  header.writeBigUInt64LE(BigInt(raw.length), 24); // compressed_size
  return Buffer.concat([header, raw]);
}

/** Reverse of mmxPackTensor → { payload, shape, dtype }. */
function mmxUnpackTensor(mmx) {
  const buf = Buffer.isBuffer(mmx) ? mmx : Buffer.from(mmx);
  if (buf.length < 32) throw new Error('short MMX payload');
  if (!buf.subarray(0, 4).equals(MMX_MAGIC)) throw new Error('invalid MMX magic');
  const dims = buf.readUInt32LE(8);
  const compression = buf.readUInt8(12);
  const dtype = buf.readUInt8(13);
  let body;
  if (compression === 0 || compression === 2) body = buf.subarray(32);
  else throw new Error('MMX Lz4 unpack needs an lz4 decoder; pkclient packs None');
  if (body.length < dims * 8) throw new Error('body shorter than declared shape');
  const shape = [];
  for (let i = 0; i < dims; i++) shape.push(Number(body.readBigUInt64LE(i * 8)));
  return { payload: body.subarray(dims * 8), shape, dtype };
}

module.exports = {
  mmxPackBytes, mmxUnpackBytes, mmxPackTensor, mmxUnpackTensor,
  DTYPE, MMX_MAGIC, MMX_VERSION,
};
