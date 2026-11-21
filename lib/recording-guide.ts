import "server-only";
import { readFileSync } from "node:fs";
import path from "node:path";

// docs/RECORDING-GUIDE.md shown on the consent page, as plain sections.
// One source of truth: edit the Markdown file, the page follows.

export type GuideSection = { heading: string; lines: string[] };

export function parseGuide(markdown: string): GuideSection[] {
  const sections: GuideSection[] = [];
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      sections.push({ heading: heading[1].trim(), lines: [] });
      continue;
    }
    const clean = line
      .replace(/^(-\s+\[\s?x?\s?\]\s+|-\s+|\d+\.\s+)/i, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .trim();
    if (!sections.length) sections.push({ heading: "", lines: [] });
    sections[sections.length - 1].lines.push(clean);
  }
  return sections;
}

export function loadRecordingGuide(): GuideSection[] {
  return parseGuide(readFileSync(path.join(process.cwd(), "docs", "RECORDING-GUIDE.md"), "utf8"));
}
