import { WorkTabPage, workMetadata, type WorkSearch } from "../WorkTab";

export const generateMetadata = () => workMetadata("ops");

export default function Page({ searchParams }: { searchParams: Promise<WorkSearch> }) {
  return WorkTabPage("ops", searchParams);
}
