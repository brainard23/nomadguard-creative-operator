import sharp from "sharp";

// ffmpeg builds often ship without drawtext (no libfreetype), so on-screen text is
// rendered to PNG with sharp (SVG) and composited by ffmpeg.

export const FONT_STACK = "Helvetica Neue, Helvetica, Arial, sans-serif";
const W = 1080;
const H = 1920;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Greedy word wrap by an approximate average glyph width (0.56em). */
export function wrapText(text: string, fontSize: number, maxWidth: number): string[] {
  const maxChars = Math.max(1, Math.floor(maxWidth / (fontSize * 0.56)));
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function textBlock(lines: string[], y: number, fontSize: number, weight: number, fill: string, spacing = 1.2): { svg: string; bottom: number } {
  const tspans = lines
    .map((l, i) => `<tspan x="${W / 2}" y="${y + i * fontSize * spacing}">${esc(l)}</tspan>`)
    .join("");
  return {
    svg: `<text text-anchor="middle" font-family="${FONT_STACK}" font-weight="${weight}" font-size="${fontSize}" fill="${fill}">${tspans}</text>`,
    bottom: y + lines.length * fontSize * spacing,
  };
}

export interface EndCardText {
  brand: string;
  headline: string;
  cta: string;
}

/** 1080x1920 premium dark-navy end card, text centered with mobile-safe margins. */
export async function renderEndCardPng(outPath: string, text: EndCardText): Promise<void> {
  const maxWidth = W - 2 * 110;
  const headline = wrapText(text.headline, 96, maxWidth);
  const cta = wrapText(text.cta, 64, maxWidth);
  const headBlockH = headline.length * 96 * 1.2;
  const ctaBlockH = cta.length * 64 * 1.2;
  const total = 60 + 90 + headBlockH + 80 + ctaBlockH;
  const top = (H - total) / 2;

  const brand = textBlock([text.brand.toUpperCase()], top + 50, 52, 600, "#C9A24B");
  const head = textBlock(headline, top + 60 + 90 + 80, 96, 700, "#FFFFFF");
  const ctaY = head.bottom + 40;
  const ctaText = textBlock(cta, ctaY + 60, 64, 500, "#E6EAF2");
  const lineY = top + 50 + 40;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0E1B3D"/><stop offset="1" stop-color="#060C20"/></linearGradient></defs>
<rect width="100%" height="100%" fill="url(#g)"/>
<rect x="${W / 2 - 60}" y="${lineY}" width="120" height="4" fill="#C9A24B"/>
${brand.svg}${head.svg}${ctaText.svg}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/** Transparent 1080x1920 overlay with a small label (used for the mock clips). */
export async function renderLabelPng(outPath: string, label: string): Promise<void> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect x="60" y="120" width="${Math.max(260, label.length * 56)}" height="120" rx="16" fill="#000000" fill-opacity="0.6"/>
<text x="90" y="205" font-family="${FONT_STACK}" font-weight="700" font-size="80" fill="#FFFFFF">${esc(label)}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}
