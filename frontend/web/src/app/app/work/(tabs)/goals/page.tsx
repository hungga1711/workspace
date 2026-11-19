import { WorkTabPage, workMetadata, type WorkSearch } from "../WorkTab";

export const generateMetadata = () => workMetadata("goals");

export default function Page({ searchParams }: { searchParams: Promise<WorkSearch> }) {
  return WorkTabPage("goals", searchParams);
}
