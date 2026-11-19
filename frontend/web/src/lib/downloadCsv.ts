import { csvFile } from "./csv";

/** Downloads rows (first row is the header) as a CSV that Excel opens as UTF-8, built in the browser. */
export function downloadCsv(filename: string, rows: unknown[][]) {
  const [header = [], ...body] = rows;
  const url = URL.createObjectURL(new Blob([csvFile(header.map(String), body)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
