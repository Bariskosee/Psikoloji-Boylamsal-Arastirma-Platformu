import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generate the PWA icon set (PLAN.md Phase 8).
 *
 * Run with `node scripts/generate-icons.mjs` from `apps/participant`. The
 * output is committed, so this script is not part of any build — it exists so
 * the icons are reproducible rather than four binaries nobody can regenerate or
 * explain.
 *
 * Deliberately dependency-free: it writes PNG chunks directly. Adding an image
 * library to the participant application's dependency tree to produce four
 * static files would be a poor trade, and this is the whole of the PNG format
 * we need — one 8-bit RGBA image, one IDAT, no interlacing.
 *
 * The mark itself is a neutral placeholder: a stack of bars suggesting a short
 * repeated form. It is not a logo and carries no institution's identity, which
 * is correct until the research team supplies one (AGENT.md §16).
 */

const BACKGROUND = [0x1f, 0x2a, 0x37];
const FOREGROUND = [0xff, 0xff, 0xff];

/** Where the icons land, relative to this file. */
const OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");

/**
 * Draw the mark into an RGBA buffer.
 *
 * `inset` is the fraction of the canvas left empty around the mark. Android's
 * maskable icons may be cropped to a circle, so the maskable variant draws the
 * same mark much smaller — anything in the outer 20% of a maskable icon is not
 * guaranteed to survive.
 */
function render(size, inset) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let index = 0; index < size * size; index += 1) {
    pixels[index * 4] = BACKGROUND[0];
    pixels[index * 4 + 1] = BACKGROUND[1];
    pixels[index * 4 + 2] = BACKGROUND[2];
    pixels[index * 4 + 3] = 255;
  }

  const margin = Math.round(size * inset);
  const inner = size - margin * 2;

  // Three bars of decreasing length, evenly spaced.
  const barHeight = Math.max(1, Math.round(inner * 0.14));
  const gap = Math.max(1, Math.round(inner * 0.15));
  const lengths = [1, 0.78, 0.52];
  const blockHeight = barHeight * 3 + gap * 2;
  const top = margin + Math.round((inner - blockHeight) / 2);

  lengths.forEach((fraction, bar) => {
    const y0 = top + bar * (barHeight + gap);
    const width = Math.round(inner * fraction);
    for (let y = y0; y < y0 + barHeight; y += 1) {
      for (let x = margin; x < margin + width; x += 1) {
        const index = (y * size + x) * 4;
        pixels[index] = FOREGROUND[0];
        pixels[index + 1] = FOREGROUND[1];
        pixels[index + 2] = FOREGROUND[2];
        pixels[index + 3] = 255;
      }
    }
  });

  return pixels;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // Compression, filter and interlace methods: the only values PNG defines.
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  // Each scanline is prefixed with its filter type. 0 — "None" — because the
  // image is a handful of flat rectangles and deflate handles it perfectly.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(OUTPUT_DIR, { recursive: true });

const icons = [
  // The two sizes the manifest specification names, plus the 180px Apple
  // touch icon iOS uses for the Home Screen.
  { name: "icon-192.png", size: 192, inset: 0.22 },
  { name: "icon-512.png", size: 512, inset: 0.22 },
  { name: "icon-maskable-512.png", size: 512, inset: 0.3 },
  { name: "apple-touch-icon.png", size: 180, inset: 0.22 },
];

for (const icon of icons) {
  writeFileSync(join(OUTPUT_DIR, icon.name), png(icon.size, render(icon.size, icon.inset)));
  console.log(`wrote ${icon.name} (${icon.size}×${icon.size})`);
}
