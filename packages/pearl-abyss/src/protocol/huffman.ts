import { pearlAbyssProtocolFailure, pearlAbyssProtocolSuccess, type PearlAbyssProtocolResult } from "./models.js";

interface HuffmanNode {
  readonly character: number | null;
  readonly frequency: number;
  readonly left: HuffmanNode | null;
  readonly right: HuffmanNode | null;
}

const HEADER_BYTES = 12;
const FREQUENCY_ENTRY_BYTES = 8;
const SIZE_HEADER_BYTES = 12;

/** Turns the decoder's output bytes into text: every symbol is ASCII, which UTF-8 decodes byte for byte. */
const ASCII = new TextDecoder("utf-8", { fatal: true });

/**
 * The most characters a Huffman body may decode to: 8 MiB, eight times the 1 MiB response ceiling
 * (`MAXIMUM_PEARL_ABYSS_RESPONSE_BYTES`). Every symbol of a multi-symbol table takes at least one encoded bit, so no
 * body under that ceiling legitimately decodes to more. A single-symbol table takes no bits at all, so its size header
 * alone sets its output; without this ceiling a 32-byte body could ask for 4 GiB.
 */
export const MAXIMUM_PEARL_ABYSS_HUFFMAN_OUTPUT_BYTES = 8 * 1_024 * 1_024;

export function decodePearlAbyssHuffman(bytes: Uint8Array): PearlAbyssProtocolResult<string> {
  try {
    return pearlAbyssProtocolSuccess(decode(bytes));
  } catch (error) {
    return pearlAbyssProtocolFailure(
      "upstream/invalid-response",
      error instanceof Error ? error.message : "Invalid Pearl Abyss Huffman response",
    );
  }
}

function decode(bytes: Uint8Array): string {
  if (bytes.byteLength < HEADER_BYTES + SIZE_HEADER_BYTES) throw invalidHuffman("Huffman header is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredFileBytes = view.getUint32(0, true);
  const reserved = view.getUint32(4, true);
  const characterCount = view.getUint32(8, true);
  if (declaredFileBytes !== bytes.byteLength || reserved !== 0 || characterCount === 0 || characterCount > 256) {
    throw invalidHuffman("Huffman file header is invalid");
  }

  const sizeHeaderOffset = HEADER_BYTES + characterCount * FREQUENCY_ENTRY_BYTES;
  if (sizeHeaderOffset + SIZE_HEADER_BYTES > bytes.byteLength) throw invalidHuffman("Huffman table is truncated");

  const heap = new FrequencyHeap();
  const characters = new Set<number>();
  const expectedFrequencies = new Map<number, number>();
  let expectedOutputBytesFromFrequencies = 0;
  for (let index = 0; index < characterCount; index += 1) {
    const offset = HEADER_BYTES + index * FREQUENCY_ENTRY_BYTES;
    const frequency = view.getUint32(offset, true);
    const character = view.getUint8(offset + 4);
    const padding = view.getUint8(offset + 5) | view.getUint8(offset + 6) | view.getUint8(offset + 7);
    if (frequency === 0 || character > 0x7f || padding !== 0 || characters.has(character)) {
      throw invalidHuffman("Huffman frequency table is invalid");
    }
    characters.add(character);
    expectedFrequencies.set(character, frequency);
    expectedOutputBytesFromFrequencies += frequency;
    if (expectedOutputBytesFromFrequencies > MAXIMUM_PEARL_ABYSS_HUFFMAN_OUTPUT_BYTES) {
      throw invalidHuffman("Huffman output exceeds the decoder's ceiling");
    }
    heap.push({ character, frequency, left: null, right: null });
  }

  while (heap.size > 1) {
    const left = heap.pop();
    const right = heap.pop();
    heap.push({
      character: null,
      frequency: left.frequency + right.frequency,
      left,
      right,
    });
  }
  const root = heap.pop();
  const encodedBits = view.getUint32(sizeHeaderOffset, true);
  const encodedBytes = view.getUint32(sizeHeaderOffset + 4, true);
  const expectedOutputBytes = view.getUint32(sizeHeaderOffset + 8, true);
  const payloadOffset = sizeHeaderOffset + SIZE_HEADER_BYTES;
  if (
    encodedBits > encodedBytes * 8 ||
    encodedBytes !== bytes.byteLength - payloadOffset ||
    expectedOutputBytes !== expectedOutputBytesFromFrequencies
  ) {
    throw invalidHuffman("Huffman size header is invalid");
  }

  if (root.left === null && root.right === null) {
    if (encodedBits !== 0 || root.character === null) throw invalidHuffman("Single-symbol Huffman body is invalid");
    return String.fromCharCode(root.character).repeat(expectedOutputBytes);
  }

  // The loop writes one byte per symbol into a buffer of the declared size, which the ceiling above already bounds,
  // and fails before writing past it. Every symbol is ASCII (the table refuses anything above 0x7f), so the bytes are
  // the text.
  const output = new Uint8Array(expectedOutputBytes);
  const actualFrequencies = new Uint32Array(0x80);
  let written = 0;
  let current = root;
  for (let bitIndex = 0; bitIndex < encodedBits; bitIndex += 1) {
    const byte = view.getUint8(payloadOffset + Math.floor(bitIndex / 8));
    const bit = (byte >> (7 - (bitIndex % 8))) & 1;
    const next = bit === 0 ? current.left : current.right;
    if (next === null) throw invalidHuffman("Huffman tree contains a dead end");
    current = next;
    if (current.left === null && current.right === null) {
      if (current.character === null) throw invalidHuffman("Huffman leaf has no character");
      if (written === expectedOutputBytes) throw invalidHuffman("Huffman output exceeds its declared size");
      output[written] = current.character;
      written += 1;
      actualFrequencies[current.character] = (actualFrequencies[current.character] ?? 0) + 1;
      current = root;
    }
  }
  if (current !== root || written !== expectedOutputBytes) {
    throw invalidHuffman("Huffman output does not match its declared size");
  }
  for (const [character, frequency] of expectedFrequencies) {
    if (actualFrequencies[character] !== frequency) {
      throw invalidHuffman("Huffman output does not match its frequency table");
    }
  }
  return ASCII.decode(output);
}

class FrequencyHeap {
  private readonly nodes: HuffmanNode[] = [];

  public get size(): number {
    return this.nodes.length;
  }

  public push(node: HuffmanNode): void {
    this.nodes.push(node);
    let childIndex = this.nodes.length - 1;
    while (childIndex > 0) {
      const parentIndex = Math.floor((childIndex - 1) / 2);
      const parent = this.nodes[parentIndex];
      const child = this.nodes[childIndex];
      if (parent === undefined || child === undefined) throw invalidHuffman("Huffman heap is invalid");
      if (parent.frequency <= child.frequency) return;
      this.nodes[parentIndex] = child;
      this.nodes[childIndex] = parent;
      childIndex = parentIndex;
    }
  }

  public pop(): HuffmanNode {
    const first = this.nodes[0];
    const last = this.nodes.pop();
    if (first === undefined || last === undefined) throw invalidHuffman("Huffman heap is empty");
    if (this.nodes.length === 0) return first;
    this.nodes[0] = last;
    let parentIndex = 0;
    while (true) {
      let childIndex = parentIndex * 2 + 1;
      if (childIndex >= this.nodes.length) return first;
      const left = this.nodes[childIndex];
      const right = this.nodes[childIndex + 1];
      if (left === undefined) throw invalidHuffman("Huffman heap child is missing");
      if (right !== undefined && right.frequency < left.frequency) childIndex += 1;
      const parent = this.nodes[parentIndex];
      const child = this.nodes[childIndex];
      if (parent === undefined || child === undefined) throw invalidHuffman("Huffman heap is invalid");
      if (parent.frequency <= child.frequency) return first;
      this.nodes[parentIndex] = child;
      this.nodes[childIndex] = parent;
      parentIndex = childIndex;
    }
  }
}

function invalidHuffman(message: string): Error {
  return new Error(`Invalid Pearl Abyss Huffman response: ${message}`);
}
