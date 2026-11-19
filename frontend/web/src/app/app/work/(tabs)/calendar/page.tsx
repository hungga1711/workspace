import { WorkTabPage, workMetadata, type WorkSearch } from "../WorkTab";

export const generateMetadata = () => workMetadata("calendar");

export default function Page({ searchParams }: { searchParams: Promise<WorkSearch> }) {
  return WorkTabPage("calendar", searchParams);
}
