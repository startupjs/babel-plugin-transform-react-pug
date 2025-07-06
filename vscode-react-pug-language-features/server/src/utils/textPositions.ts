import { Position, Range } from 'vscode-languageserver/node';

/**
 * Converts a zero-based offset in a string to a Position (line, character).
 */
export function offsetToPosition(text: string, offset: number): Position {
  if (offset < 0) return Position.create(0, 0);
  let line = 0;
  let character = 0;
  let currentOffset = 0;
  while (currentOffset < offset && currentOffset < text.length) {
    if (text[currentOffset] === '\n') {
      line++;
      character = 0;
    } else {
      character++;
    }
    currentOffset++;
  }
  // If offset is beyond text length, clamp to end of text
  if (offset > text.length) {
      const lines = text.split('\n');
      line = lines.length -1;
      character = lines[line]?.length || 0;
  }
  return Position.create(line, character);
}

/**
 * Converts a Position (line, character) to a zero-based offset in a string.
 */
export function positionToOffset(text: string, position: Position): number {
  let offset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < position.line && i < lines.length; i++) {
    offset += lines[i].length + 1; // +1 for the newline character
  }
  if (position.line < lines.length) {
    offset += Math.min(position.character, lines[position.line]?.length || 0);
  } else { // Position line is out of bounds, clamp to end of text
    return text.length;
  }
  return Math.min(offset, text.length); // Ensure offset doesn't exceed text length
}
