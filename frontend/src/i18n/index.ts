// frontend/src/i18n/index.ts
// Central i18n (spec §59). One key set, two dictionaries — adding a
// language later means adding one more JSON file here.

import en from "./en.json";
import kh from "./kh.json";

export type Lang = "en" | "kh";
type Dict = Record<string, string>;

const DICTS: Record<Lang, Dict> = { en, kh };

export function translate(lang: Lang, key: string, vars: Record<string, string | number> = {}): string {
  const dict = DICTS[lang] ?? DICTS.en;
  let s = dict[key] ?? DICTS.en[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    s = s.replaceAll(`{${k}}`, String(v));
  }
  return s;
}
