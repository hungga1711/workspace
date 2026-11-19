import { randomBytes, randomInt } from "node:crypto";
import type { Scene, SceneElement } from "./whiteboard-scene.js";

/**
 * Starting scenes for new whiteboards, built here so their words follow the creator's language (x-locale) like a
 * new project's board columns. They are plain Excalidraw elements: once created they are the board's data, edited
 * like anything drawn by hand. Text sizes are estimates; the editor re-measures text when it loads a scene.
 */
export const TEMPLATES = ["blank", "brainstorm", "retro", "kanban", "flowchart", "user-journey", "swot", "meeting"] as const;
export type TemplateKey = (typeof TEMPLATES)[number];
type Locale = "vi" | "en";

/**
 * Element colours are scene data, not UI styling, so they are literal values here. They come from DESIGN.md's
 * tokens: ink and edge for lines and text, the soft washes for sticky notes (the frontend's sticky palette uses the
 * same six), so a template looks like the rest of the app in either theme's export.
 */
const BOARD_COLORS = {
  ink: "#18181B",
  muted: "#6B6B72",
  edge: "#E4E4E7",
  lane: "#F4F4F5",
} as const;
export const STICKY_COLORS = ["#FEF3C7", "#E6EEFE", "#ECFDF5", "#FEF0F0", "#F4F4F5", "#EFF4FF"] as const;

/** Nunito: the clean sans Excalidraw ships (FONT_FAMILY.Nunito), with its line height. */
const FONT = 6;
const LINE_HEIGHT = 1.35;

const T = {
  blank: { vi: "Trống", en: "Blank" },
  brainstorm: { vi: "Động não", en: "Brainstorm" },
  retro: { vi: "Nhìn lại (retro)", en: "Retrospective" },
  kanban: { vi: "Kanban", en: "Kanban" },
  flowchart: { vi: "Lưu đồ", en: "Flowchart" },
  "user-journey": { vi: "Hành trình khách hàng", en: "User journey" },
  swot: { vi: "SWOT", en: "SWOT" },
  meeting: { vi: "Họp", en: "Meeting" },
} satisfies Record<TemplateKey, Record<Locale, string>>;

const WORDS = {
  topic: { vi: "Chủ đề chính", en: "Main topic" },
  idea: { vi: "Ý tưởng", en: "Idea" },
  wentWell: { vi: "Điều làm tốt", en: "Went well" },
  toImprove: { vi: "Cần cải thiện", en: "To improve" },
  actions: { vi: "Hành động", en: "Actions" },
  todo: { vi: "Cần làm", en: "To do" },
  doing: { vi: "Đang làm", en: "Doing" },
  done: { vi: "Xong", en: "Done" },
  start: { vi: "Bắt đầu", en: "Start" },
  step: { vi: "Bước xử lý", en: "Step" },
  decision: { vi: "Đạt yêu cầu?", en: "Approved?" },
  end: { vi: "Kết thúc", en: "End" },
  yes: { vi: "Có", en: "Yes" },
  no: { vi: "Không", en: "No" },
  stages: { vi: ["Biết đến", "Cân nhắc", "Mua / đăng ký", "Sử dụng", "Gắn bó"], en: ["Discover", "Consider", "Sign up", "Use", "Stay"] },
  rows: { vi: ["Hành động", "Suy nghĩ", "Cảm xúc", "Điểm khó"], en: ["Actions", "Thoughts", "Feelings", "Pain points"] },
  swot: { vi: ["Điểm mạnh", "Điểm yếu", "Cơ hội", "Thách thức"], en: ["Strengths", "Weaknesses", "Opportunities", "Threats"] },
  agenda: { vi: "Nội dung họp", en: "Agenda" },
  notes: { vi: "Ghi chép", en: "Notes" },
  actionItems: { vi: "Việc cần làm", en: "Action items" },
} as const;

/** The localized name of a template (the new board's default title). */
export const templateName = (key: TemplateKey, locale: Locale) => T[key][locale];

/**
 * Builds elements with Excalidraw's required fields. Ids are random (as Excalidraw's own); fractional indices are
 * Excalidraw's base-62 keys in insertion order, so the editor does not have to re-index the scene.
 */
export class Builder {
  readonly elements: SceneElement[] = [];
  private readonly now = Date.now();

  private index(n: number): string {
    const D = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    // "a0".."az" for the first 62, then "b00".."bzz" (3,844 more): valid, increasing fractional-indexing keys.
    return n < 62 ? `a${D[n]}` : `b${D[Math.floor((n - 62) / 62)]}${D[(n - 62) % 62]}`;
  }

  private base(type: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): SceneElement {
    const e: SceneElement = {
      id: randomBytes(15).toString("base64url"),
      type,
      x,
      y,
      width,
      height,
      angle: 0,
      strokeColor: BOARD_COLORS.ink,
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 1,
      strokeStyle: "solid",
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      index: this.index(this.elements.length),
      roundness: null,
      seed: randomInt(1, 2 ** 31 - 1),
      version: 1,
      versionNonce: randomInt(1, 2 ** 31 - 1),
      isDeleted: false,
      boundElements: null,
      updated: this.now,
      link: null,
      locked: false,
      ...extra,
    };
    this.elements.push(e);
    return e;
  }

  text(
    x: number,
    y: number,
    text: string,
    o: { size?: number; width?: number; color?: string; align?: "left" | "center"; containerId?: string; height?: number; locked?: boolean } = {},
  ) {
    const size = o.size ?? 20;
    const lines = text.split("\n");
    const width = o.width ?? Math.max(...lines.map((l) => l.length)) * size * 0.55;
    return this.base("text", x, y, width, o.height ?? lines.length * size * LINE_HEIGHT, {
      strokeColor: o.color ?? BOARD_COLORS.ink,
      text,
      originalText: text,
      fontSize: size,
      fontFamily: FONT,
      textAlign: o.align ?? "left",
      verticalAlign: o.containerId ? "middle" : "top",
      containerId: o.containerId ?? null,
      autoResize: true,
      lineHeight: LINE_HEIGHT,
      locked: o.locked ?? false,
    });
  }

  shape(
    type: "rectangle" | "ellipse" | "diamond",
    x: number,
    y: number,
    w: number,
    h: number,
    o: { fill?: string; stroke?: string; label?: string; size?: number; sticky?: boolean; locked?: boolean } = {},
  ) {
    const e = this.base(type, x, y, w, h, {
      backgroundColor: o.fill ?? "transparent",
      strokeColor: o.stroke ?? BOARD_COLORS.ink,
      roundness: type === "rectangle" ? { type: 3 } : { type: 2 },
      locked: o.locked ?? false,
      ...(o.sticky ? { customData: { sticky: true } } : {}),
    });
    if (o.label !== undefined) {
      const size = o.size ?? 20;
      const t = this.text(x + 10, y + h / 2 - (size * LINE_HEIGHT) / 2, o.label, { size, width: w - 20, align: "center", containerId: e.id, locked: o.locked ?? false });
      e.boundElements = [{ type: "text", id: t.id }];
    }
    return e;
  }

  /**
   * A column or cell: a light frame with a clear heading inside at the top (28px, like a card title on the board's
   * scale). Both are locked: they are the board's background, so clicks, drags and select-all go to the notes on
   * them, as in Miro; "Unlock" in the canvas's menu frees them.
   */
  column(x: number, y: number, w: number, h: number, title: string, fill: string = BOARD_COLORS.lane) {
    this.shape("rectangle", x, y, w, h, { fill, stroke: BOARD_COLORS.edge, locked: true });
    this.text(x + 20, y + 18, title, { size: 28, locked: true });
  }

  /** A sticky note as our sticky tool makes it: no outline, a wash fill, centred text. */
  sticky(x: number, y: number, text: string, color: string = STICKY_COLORS[0]) {
    return this.shape("rectangle", x, y, 200, 200, { fill: color, stroke: "transparent", label: text, sticky: true });
  }

  /** An arrow from one shape's edge to another's, bound to both so it follows them. */
  arrow(from: SceneElement, to: SceneElement, label?: string) {
    const fx = (from.x as number) + (from.width as number) / 2;
    const fy = (from.y as number) + (from.height as number);
    const tx = (to.x as number) + (to.width as number) / 2;
    const ty = to.y as number;
    const sideways = Math.abs(tx - fx) > Math.abs(ty - fy);
    const [sx, sy, ex, ey] = sideways
      ? [(from.x as number) + (from.width as number), (from.y as number) + (from.height as number) / 2, to.x as number, (to.y as number) + (to.height as number) / 2]
      : [fx, fy, tx, ty];
    const a = this.base("arrow", sx, sy, Math.abs(ex - sx), Math.abs(ey - sy), {
      points: [
        [0, 0],
        [ex - sx, ey - sy],
      ],
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap: 4 },
      endBinding: { elementId: to.id, focus: 0, gap: 4 },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
      roundness: { type: 2 },
    });
    for (const s of [from, to]) s.boundElements = [...((s.boundElements as unknown[] | null) ?? []), { type: "arrow", id: a.id }];
    if (label) {
      const t = this.text(sx + (ex - sx) / 2 - 20, sy + (ey - sy) / 2 - 12, label, { size: 16, containerId: a.id, align: "center" });
      a.boundElements = [{ type: "text", id: t.id }];
    }
    return a;
  }
}

/** The scene a new board starts from. */
export function buildTemplate(key: TemplateKey, locale: Locale): Scene {
  const b = new Builder();
  const w = (k: keyof typeof WORDS) => (WORDS[k] as Record<Locale, unknown>)[locale];
  switch (key) {
    case "blank":
      break;
    case "brainstorm": {
      // Outlined, not filled: a filled shape with text reads as a sticky note (boardText), and the topic is not one.
      b.shape("ellipse", 300, 240, 280, 140, { label: w("topic") as string, size: 24 });
      const spots = [
        [40, 40],
        [340, -10],
        [640, 40],
        [40, 420],
        [340, 470],
        [640, 420],
      ] as const;
      spots.forEach(([x, y], i) => b.sticky(x, y, `${w("idea")} ${i + 1}`, STICKY_COLORS[i % STICKY_COLORS.length]));
      break;
    }
    case "retro":
    case "kanban":
    case "meeting": {
      const titles =
        key === "retro" ? [w("wentWell"), w("toImprove"), w("actions")] : key === "kanban" ? [w("todo"), w("doing"), w("done")] : [w("agenda"), w("notes"), w("actionItems")];
      (titles as string[]).forEach((t, i) => b.column(i * 340, 0, 320, 720, t));
      break;
    }
    case "flowchart": {
      const start = b.shape("ellipse", 120, 0, 200, 80, { label: w("start") as string });
      const step = b.shape("rectangle", 120, 160, 200, 90, { label: w("step") as string });
      const decision = b.shape("diamond", 100, 330, 240, 140, { label: w("decision") as string });
      const end = b.shape("ellipse", 120, 550, 200, 80, { label: w("end") as string });
      b.arrow(start, step);
      b.arrow(step, decision);
      b.arrow(decision, end, w("yes") as string);
      const back = b.shape("rectangle", 460, 355, 200, 90, { label: w("step") as string });
      b.arrow(decision, back, w("no") as string);
      break;
    }
    case "user-journey": {
      const stages = w("stages") as readonly string[];
      const rows = w("rows") as readonly string[];
      // The grid is the background (locked); the stage and row headings are 24px so they read at a glance.
      stages.forEach((s, i) => b.shape("rectangle", 200 + i * 240, 0, 220, 60, { stroke: BOARD_COLORS.ink, label: s, size: 24, locked: true }));
      rows.forEach((r, j) => {
        b.text(0, 100 + j * 200 + 70, r, { size: 24, locked: true });
        stages.forEach((_s, i) => b.shape("rectangle", 200 + i * 240, 80 + j * 200, 220, 180, { fill: BOARD_COLORS.lane, stroke: BOARD_COLORS.edge, locked: true }));
      });
      break;
    }
    case "swot": {
      const names = w("swot") as readonly string[];
      const fills = [STICKY_COLORS[2], STICKY_COLORS[3], STICKY_COLORS[1], STICKY_COLORS[0]];
      names.forEach((n, i) => b.column((i % 2) * 520, Math.floor(i / 2) * 420, 500, 400, n, fills[i]));
      break;
    }
  }
  return { elements: b.elements, appState: { viewBackgroundColor: "#ffffff", gridModeEnabled: false }, files: {} };
}
