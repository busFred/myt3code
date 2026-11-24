/** An asar archive holding `files` at its root, laid out as @electron/asar writes one. */
export function encodeAsar(files: Readonly<Record<string, string>>): Uint8Array {
  const encoder = new TextEncoder();
  const contents = Object.entries(files).map(
    ([name, text]) => [name, encoder.encode(text)] as const,
  );
  const index: Record<string, { size: number; offset: string }> = {};
  let dataLength = 0;
  for (const [name, bytes] of contents) {
    index[name] = { size: bytes.byteLength, offset: String(dataLength) };
    dataLength += bytes.byteLength;
  }
  const json = encoder.encode(JSON.stringify({ files: index }));
  const padded = Math.ceil(json.byteLength / 4) * 4;
  const header = new Uint8Array(8 + padded);
  new DataView(header.buffer).setUint32(0, 4 + padded, true);
  new DataView(header.buffer).setUint32(4, json.byteLength, true);
  header.set(json, 8);
  const archive = new Uint8Array(8 + header.byteLength + dataLength);
  new DataView(archive.buffer).setUint32(0, 4, true);
  new DataView(archive.buffer).setUint32(4, header.byteLength, true);
  archive.set(header, 8);
  let position = 8 + header.byteLength;
  for (const [, bytes] of contents) {
    archive.set(bytes, position);
    position += bytes.byteLength;
  }
  return archive;
}
