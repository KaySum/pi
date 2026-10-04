// Public positions use 1-based UTF-8 byte columns; raw LSP ranges stay explicit.
export function byteIndex(line, index, encoding) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('Invalid LSP character offset');
  let bytes;
  if (encoding === 'utf-8') {
    const buffer = Buffer.from(line);
    if (index > buffer.length || (index < buffer.length && (buffer[index] & 0xc0) === 0x80)) throw new Error('LSP offset is outside the line or splits UTF-8');
    return index;
  }
  if (encoding === 'utf-16') {
    if (index > line.length || (index > 0 && index < line.length && /[\uD800-\uDBFF]/.test(line[index - 1]) && /[\uDC00-\uDFFF]/.test(line[index]))) {
      throw new Error('LSP offset is outside the line or splits a surrogate pair');
    }
    bytes = Buffer.byteLength(line.slice(0, index));
  } else if (encoding === 'utf-32') {
    let count = 0;
    bytes = 0;
    for (const character of line) { if (count === index) break; bytes += Buffer.byteLength(character); count++; }
    if (count !== index) throw new Error('LSP offset is outside the line');
  } else throw new Error(`Unsupported LSP position encoding: ${encoding}`);
  return bytes;
}
export function normalizeRange(text, range, encoding) {
  if (/\r(?!\n)/.test(text)) throw new Error('Bare-CR line endings cannot be safely normalized');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const position = value => {
    if (!value || !Number.isSafeInteger(value.line) || value.line < 0 || value.line >= lines.length) throw new Error('LSP line is outside the file');
    return { line: value.line + 1, column: byteIndex(lines[value.line], value.character, encoding) + 1 };
  };
  const a = position(range?.start), z = position(range?.end);
  if (z.line < a.line || (z.line === a.line && z.column < a.column)) throw new Error('Reversed LSP range');
  return { line: a.line, column: a.column, endLine: z.line, endColumn: z.column };
}
