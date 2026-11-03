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

export interface NotificationText {
  title: string;
  body: string;
}

const APP_LABEL = "NOMADGUARD";

export type OverlayPosition = "top" | "center" | "bottom";

/** Transparent room around the card inside its PNG, for the drop shadow. */
export const NOTIFICATION_MARGIN = 60;

/**
 * Pure: y (in the 1920px frame) of the card's top edge. Bottom sits at ~66% of the height, which
 * keeps the lowest ~15% clear for TikTok/IG captions; top is the upper-third placement.
 */
export function notificationTop(position: OverlayPosition, cardHeight: number): number {
  if (position === "top") return 210;
  if (position === "center") return Math.round((H - cardHeight) / 2);
  return Math.round(H * 0.66);
}

/**
 * Transparent PNG, 1080 wide and just tall enough for an iOS-style notification card plus its
 * shadow: dark translucent rounded card, green check icon, app label, bold title, lighter body.
 * The card's top-left sits at (60, NOTIFICATION_MARGIN); the caller positions the PNG in the frame.
 * Returns the card height and PNG size.
 */
export async function renderNotificationPng(outPath: string, text: NotificationText): Promise<{ cardHeight: number; width: number; height: number }> {
  const card = { x: 60, y: NOTIFICATION_MARGIN, width: W - 120 };
  const pad = 36;
  const icon = 96;
  const textX = card.x + pad + icon + 28;
  const textW = card.x + card.width - pad - textX;

  const title = wrapText(text.title, 42, textW).slice(0, 2);
  const body = wrapText(text.body, 34, textW).slice(0, 3);
  const labelY = card.y + pad + 22;
  const titleY = labelY + 20 + 42;
  const bodyY = titleY + (title.length - 1) * 42 * 1.2 + 14 + 34;
  const height = Math.round(bodyY + (body.length - 1) * 34 * 1.25 + pad + 6 - card.y);

  const lines = (ls: string[], y: number, size: number, weight: number, fill: string, spacing: number) =>
    `<text font-family="${FONT_STACK}" font-weight="${weight}" font-size="${size}" fill="${fill}">${ls
      .map((l, i) => `<tspan x="${textX}" y="${y + i * size * spacing}">${esc(l)}</tspan>`)
      .join("")}</text>`;

  const cx = card.x + pad + icon / 2;
  const cy = card.y + pad + icon / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height + 2 * NOTIFICATION_MARGIN}">
<defs><filter id="sh" x="-10%" y="-20%" width="120%" height="160%"><feGaussianBlur stdDeviation="22"/></filter></defs>
<rect x="${card.x}" y="${card.y + 18}" width="${card.width}" height="${height}" rx="52" fill="#000000" fill-opacity="0.45" filter="url(#sh)"/>
<rect x="${card.x}" y="${card.y}" width="${card.width}" height="${height}" rx="52" fill="#1C1C1E" fill-opacity="0.88"/>
<rect x="${card.x + 1}" y="${card.y + 1}" width="${card.width - 2}" height="${height - 2}" rx="51" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="2"/>
<circle cx="${cx}" cy="${cy}" r="${icon / 2}" fill="#34C759"/>
<path d="M${cx - 22} ${cy + 2} L${cx - 6} ${cy + 18} L${cx + 24} ${cy - 16}" fill="none" stroke="#FFFFFF" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
<text x="${textX}" y="${labelY}" font-family="${FONT_STACK}" font-weight="600" font-size="24" letter-spacing="2" fill="#98989F">${APP_LABEL}</text>
<text x="${card.x + card.width - pad}" y="${labelY}" text-anchor="end" font-family="${FONT_STACK}" font-weight="400" font-size="24" fill="#98989F">now</text>
${lines(title, titleY, 42, 700, "#FFFFFF", 1.2)}
${lines(body, bodyY, 34, 400, "#D1D1D6", 1.25)}
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
  return { cardHeight: height, width: W, height: height + 2 * NOTIFICATION_MARGIN };
}
