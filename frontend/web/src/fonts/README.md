# Fonts

Self-hosted subsets, Latin and Vietnamese only (see `src/app/layout.tsx` for why).

- Geist and Geist Mono (variable, wght 100–900): Copyright (c) 2023 Vercel, in collaboration with basement.studio
  (https://github.com/vercel/geist-font)
- Inter and Inter Tight (variable, wght 100–900): Copyright 2016 The Inter Project Authors (https://github.com/rsms/inter).
  `inter-latin.woff2` is only used by `docs/assets/social-preview.html`.

All are licensed under the SIL Open Font License, Version 1.1 (full text in `OFL.txt`).
To update, take the `latin` and `vietnamese` files from the family's Google Fonts CSS
(`https://fonts.googleapis.com/css2?family=Inter:wght@100..900`, fetched with a modern browser user agent).

Geist files: take `dist/fonts/geist-*/Geist*-Variable.woff2` from the `geist` npm package (1.9 or later: older ones
lack the Vietnamese letters) and subset each with fonttools to the characters the current file has plus the Vietnamese
ones (U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-030F, U+031B, U+0323,
U+0329, U+1EA0-1EF9, U+20AB): `pyftsubset <file> --unicodes=<list> --layout-features='*' --flavor=woff2`.
