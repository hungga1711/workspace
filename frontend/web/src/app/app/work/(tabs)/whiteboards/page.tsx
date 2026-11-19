import { WorkTabPage, workMetadata, type WorkSearch } from "../WorkTab";

export const generateMetadata = () => workMetadata("whiteboards");

export default function Page({ searchParams }: { searchParams: Promise<WorkSearch> }) {
  return WorkTabPage("whiteboards", searchParams);
}
