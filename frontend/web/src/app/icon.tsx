import { brandIcon } from "@/lib/brand-icon";

/** Two favicons (16 and 32 px for high-density tabs). */
export function generateImageMetadata() {
  return [
    { id: "16", size: { width: 16, height: 16 }, contentType: "image/png" },
    { id: "32", size: { width: 32, height: 32 }, contentType: "image/png" },
  ];
}

export default function Icon({ id }: { id: string }) {
  return brandIcon(id === "16" ? 16 : 32);
}
