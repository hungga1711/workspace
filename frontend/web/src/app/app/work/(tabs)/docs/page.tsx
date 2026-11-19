import { WorkTabPage, workMetadata, type WorkSearch } from "../WorkTab";

export const generateMetadata = () => workMetadata("docs");

export default function Page({ searchParams }: { searchParams: Promise<WorkSearch> }) {
  return WorkTabPage("docs", searchParams);
}
