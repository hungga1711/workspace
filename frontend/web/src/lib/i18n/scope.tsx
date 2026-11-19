import { I18nProvider } from "./client";
import { getLocale, getMessages, type MessageArea } from "./server";

/** Gives a layout's client components the message groups of its area (see AREAS in server.ts). */
export async function I18nScope({ area, children }: { area: MessageArea; children: React.ReactNode }) {
  return (
    <I18nProvider locale={await getLocale()} messages={await getMessages(area)}>
      {children}
    </I18nProvider>
  );
}
