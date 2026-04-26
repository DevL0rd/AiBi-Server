#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_INPUT = "captures/firmware/analysis/1.6.0/-8114815/pocket.bin";
const DEFAULT_OUT = "captures/firmware/decompiled/1.6.0";
const FOCUS_PATTERNS = [
  /aibi/i,
  /ota/i,
  /detectintent/i,
  /imgrecog/i,
  /rockpaper/i,
  /speech\/tts/i,
  /chat/i,
  /tts/i,
  /rec_behavior/i,
  /behavior_paras/i,
  /pre_animation/i,
  /post_animation/i,
  /post_behavior/i,
  /animation/i,
  /interact_/i,
  /ability_/i,
  /animal_/i,
  /Secret/i,
  /Authorization/i,
  /responsetag/i,
  /timeout/i,
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(args.input || DEFAULT_INPUT);
  const outDir = path.resolve(args.out || DEFAULT_OUT);
  const segmentDir = path.join(outDir, "segments");
  fs.mkdirSync(segmentDir, { recursive: true });

  const image = fs.readFileSync(input);
  const metadata = parseEspImage(image);
  writeJson(path.join(outDir, "image-info.json"), metadata);

  const strings = collectStrings(image, metadata.segments);
  writeStrings(path.join(outDir, "strings-addressed.tsv"), strings);
  writeStrings(path.join(outDir, "strings-focused.tsv"), strings.filter((entry) => FOCUS_PATTERNS.some((pattern) => pattern.test(entry.text))));
  writeJson(path.join(outDir, "actions-and-endpoints.json"), summarize(strings));

  for (const segment of metadata.segments) {
    const segmentName = `${segment.kind.toLowerCase()}_${hex(segment.loadAddress)}.bin`;
    const segmentPath = path.join(segmentDir, segmentName);
    fs.writeFileSync(segmentPath, image.subarray(segment.fileOffset, segment.fileOffset + segment.length));
    if (segment.kind === "IROM" || segment.kind === "IRAM") {
      const disassembly = disassemble(segmentPath, segment.loadAddress);
      if (disassembly) fs.writeFileSync(path.join(outDir, `${segment.kind.toLowerCase()}_${hex(segment.loadAddress)}.S`), disassembly);
    }
  }

  fs.writeFileSync(path.join(outDir, "README.md"), renderReadme(metadata), "utf8");
  console.log(`Wrote firmware analysis to ${outDir}`);
  console.log(`Segments: ${metadata.segments.length}`);
  console.log(`Focused strings: ${strings.filter((entry) => FOCUS_PATTERNS.some((pattern) => pattern.test(entry.text))).length}`);
}

function parseEspImage(buffer) {
  if (buffer[0] !== 0xe9) throw new Error(`Not an ESP app image: magic=0x${buffer[0].toString(16)}`);
  const segmentCount = buffer[1];
  const entryAddress = buffer.readUInt32LE(4);
  const segments = [];
  let offset = 24;
  for (let index = 0; index < segmentCount; index += 1) {
    const loadAddress = buffer.readUInt32LE(offset);
    const length = buffer.readUInt32LE(offset + 4);
    const fileOffset = offset + 8;
    segments.push({
      index: index + 1,
      loadAddress,
      length,
      fileOffset,
      endFileOffset: fileOffset + length,
      kind: classifySegment(loadAddress),
    });
    offset = fileOffset + length;
  }
  return {
    source: path.relative(process.cwd(), process.argv.includes("--input") ? process.argv[process.argv.indexOf("--input") + 1] : DEFAULT_INPUT),
    imageSize: buffer.length,
    imageMd5: hashBuffer(buffer, "md5"),
    imageSha256: hashBuffer(buffer, "sha256"),
    imageHeaderHex: buffer.subarray(0, 24).toString("hex"),
    checksum: parseImageChecksum(buffer, segments),
    appendedSha256: parseAppendedSha256(buffer, segments),
    spiMode: buffer[2],
    spiSpeedSize: buffer[3],
    entryAddress,
    entryAddressHex: hex(entryAddress),
    segmentCount,
    segments: segments.map((segment) => ({
      ...segment,
      loadAddressHex: hex(segment.loadAddress),
      fileOffsetHex: hex(segment.fileOffset),
      lengthHex: hex(segment.length),
    })),
  };
}

function parseImageChecksum(buffer, segments) {
  const segmentEnd = segments.at(-1)?.endFileOffset ?? 0;
  const checksumOffset = buffer.length >= segmentEnd + 33 ? buffer.length - 33 : nextChecksumOffset(segmentEnd);
  if (checksumOffset >= buffer.length) return null;
  return {
    offset: checksumOffset,
    offsetHex: hex(checksumOffset),
    value: buffer[checksumOffset],
    valueHex: `0x${buffer[checksumOffset].toString(16).padStart(2, "0")}`,
    calculatedValue: calculateEspChecksum(buffer, segments),
    paddingLength: checksumOffset - segmentEnd,
  };
}

function parseAppendedSha256(buffer, segments) {
  const segmentEnd = segments.at(-1)?.endFileOffset ?? 0;
  if (buffer.length < segmentEnd + 33) return null;
  const digest = buffer.subarray(buffer.length - 32).toString("hex");
  const calculatedDigest = hashBuffer(buffer.subarray(0, buffer.length - 32), "sha256");
  return {
    offset: buffer.length - 32,
    offsetHex: hex(buffer.length - 32),
    value: digest,
    calculatedValue: calculatedDigest,
    matches: digest === calculatedDigest,
  };
}

function nextChecksumOffset(segmentEnd) {
  let offset = segmentEnd;
  while (offset % 16 !== 15) offset += 1;
  return offset;
}

function calculateEspChecksum(buffer, segments) {
  let checksum = 0xef;
  for (const segment of segments) {
    for (const byte of buffer.subarray(segment.fileOffset, segment.endFileOffset)) {
      checksum ^= byte;
    }
  }
  return checksum;
}

function classifySegment(address) {
  if (address >= 0x42000000 && address < 0x43000000) return "IROM";
  if (address >= 0x40370000 && address < 0x40400000) return "IRAM";
  if (address >= 0x3c000000 && address < 0x3d000000) return "DROM";
  if (address >= 0x3fc00000 && address < 0x40000000) return "DRAM";
  if (address >= 0x60000000 && address < 0x60100000) return "RTC";
  return "DATA";
}

function collectStrings(buffer, segments) {
  const entries = [];
  let start = -1;
  for (let offset = 0; offset <= buffer.length; offset += 1) {
    const byte = buffer[offset];
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable && start === -1) start = offset;
    if ((!printable || offset === buffer.length) && start !== -1) {
      const end = offset;
      if (end - start >= 3) {
        const text = buffer.subarray(start, end).toString("utf8");
        const mapped = mapOffset(start, segments);
        entries.push({
          address: mapped ? hex(mapped.address) : "",
          fileOffset: start,
          fileOffsetHex: hex(start),
          segment: mapped?.kind || "",
          text,
        });
      }
      start = -1;
    }
  }
  return entries;
}

function mapOffset(fileOffset, segments) {
  for (const segment of segments) {
    if (fileOffset >= segment.fileOffset && fileOffset < segment.endFileOffset) {
      return {
        kind: segment.kind,
        address: segment.loadAddress + (fileOffset - segment.fileOffset),
      };
    }
  }
  return null;
}

function summarize(strings) {
  const focused = strings.filter((entry) => FOCUS_PATTERNS.some((pattern) => pattern.test(entry.text)));
  return {
    endpoints: uniqueText(focused, /^(GET|POST) /),
    responseFields: uniqueText(focused, /^(responsetag|rec_behavior|behavior_paras|pre_animation|post_animation|post_behavior|animation_name|queryText|resultCode)$/),
    behaviors: uniqueText(focused, /^(ability_|interact_|chatgpt_)/),
    animations: uniqueText(focused, /^(aibi_|animal_|chatgpt_|food_|interact_|multi_|pirate_|setting_|sing_|voice__)/),
    headers: uniqueText(focused, /^(Authorization|Secret|Connection|Keep-Alive|Host|Content-Type)/),
    focused,
  };
}

function uniqueText(entries, pattern) {
  return [...new Set(entries.filter((entry) => pattern.test(entry.text)).map((entry) => entry.text))].sort();
}

function disassemble(segmentPath, loadAddress) {
  const result = spawnSync("xtensa-lx106-elf-objdump", [
    "-D",
    "-b",
    "binary",
    "-m",
    "xtensa",
    `--adjust-vma=0x${loadAddress.toString(16)}`,
    segmentPath,
  ], { encoding: "utf8", maxBuffer: 1024 * 1024 * 128 });
  if (result.error) {
    console.warn(`objdump skipped for ${path.basename(segmentPath)}: ${result.error.message}`);
    return "";
  }
  return `${result.stdout}${result.stderr}`;
}

function writeStrings(filePath, entries) {
  const rows = entries.map((entry) => `${entry.address}\t${entry.fileOffsetHex}\t${entry.segment}\t${entry.text}`);
  fs.writeFileSync(filePath, `${rows.join("\n")}\n`, "utf8");
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hashBuffer(buffer, algorithm) {
  return crypto.createHash(algorithm).update(buffer).digest("hex");
}

function renderReadme(metadata) {
  return `# Firmware 1.6.0 Analysis

- Project: pocket
- Target: ESP32-S3
- ESP-IDF: v4.4.6-dirty
- Entry: ${hex(metadata.entryAddress)}
- Segments: ${metadata.segmentCount}

Generated files:

- \`image-info.json\`: parsed ESP image header and segment map.
- \`strings-addressed.tsv\`: all printable strings with mapped load addresses when possible.
- \`strings-focused.tsv\`: API, action, animation, OTA, and timeout related strings.
- \`actions-and-endpoints.json\`: extracted endpoint, behavior, animation, and field names.
- \`irom_*.S\`, \`iram_*.S\`: raw Xtensa disassembly by load segment.

Note: this is raw disassembly from an ESP app image, not original C source. The image has no symbol table, so names come from embedded strings and ESP-IDF log paths.
`;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=");
    args[toCamel(key)] = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
  }
  return args;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function hex(value) {
  return `0x${value.toString(16).padStart(8, "0")}`;
}

main();
