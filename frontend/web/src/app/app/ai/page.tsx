import { redirect } from "next/navigation";

/** /app/ai opens Tiến độ; old assistant links (/app/ai?c=…) open that conversation in Hỏi đáp. */
export default async function AiIndex({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  redirect(c ? `/app/ai/ask?c=${encodeURIComponent(c)}` : "/app/ai/progress");
}
