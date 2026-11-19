/**
 * Two letters for a workspace picture: skip legal prefixes ("Công ty", "Cty", "Tập đoàn", "TNHH",
 * "Co.", "Ltd") so "Công ty An Phát" is "AP", not "CÔ".
 */
const PREFIX = /^(công ty|cong ty|cty|tập đoàn|tap doan|tnhh|cổ phần|co phan|cp|jsc|co\.?|company|ltd\.?)\s+/i;

export function workspaceInitials(name: string): string {
  let n = name.trim();
  for (let i = 0; i < 3 && PREFIX.test(n); i++) n = n.replace(PREFIX, "");
  const words = n.split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : (words[0] ?? name).slice(0, 2);
  return letters.toUpperCase();
}
