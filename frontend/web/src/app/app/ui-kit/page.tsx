import { notFound } from "next/navigation";
import UiKit from "./UiKit";

/**
 * Component gallery for designers and contributors (`/app/ui-kit`). Development only: a production build answers
 * 404, so the sample data and the extra bundle never reach a company's users.
 */
export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <UiKit />;
}
