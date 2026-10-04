const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length))

const uint32le = (bytes: Uint8Array, offset: number) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true)

/**
 * Reads WebP container metadata without decoding image frames. Bytes that are not a WebP
 * container (e.g. PNGs saved as .webp) are not animated WebPs; decoders sniff them by content.
 */
export function isAnimatedWebP(bytes: Uint8Array): boolean {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WEBP") {
    return false
  }

  const declaredEnd = uint32le(bytes, 4) + 8
  if (declaredEnd > bytes.length || declaredEnd < 12) {
    throw new RangeError("Truncated WebP container")
  }

  let offset = 12
  while (offset + 8 <= declaredEnd) {
    const kind = ascii(bytes, offset, 4)
    const size = uint32le(bytes, offset + 4)
    const dataOffset = offset + 8
    const nextOffset = dataOffset + size + (size & 1)
    if (nextOffset > declaredEnd) throw new RangeError("Truncated WebP chunk")
    if (kind === "ANIM") return true
    if (kind === "VP8X" && size >= 1 && ((bytes[dataOffset] ?? 0) & 0x02) !== 0) return true
    offset = nextOffset
  }
  return false
}
