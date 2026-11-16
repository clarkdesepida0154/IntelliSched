# Bundled look-alike fonts (Phase 8 Part 2, decision 3)

The exports' PDFs are made offline by a headless browser. On a computer with Microsoft Office the
installed Arial, Arial Narrow and Old English Text MT are used (and embedded by the browser); on a
computer without them, these open look-alikes are used instead, and the Export card says so in one
line. The DOCX files only name the fonts; Word draws them.

| In place of | Bundled file | Licence |
|---|---|---|
| Arial | `Arimo-wght.ttf` (Arimo, metric-compatible with Arial) | SIL OFL 1.1 (`OFL-Arimo.txt`) |
| Arial Narrow | `ArchivoNarrow-wght.ttf` (Archivo Narrow) | SIL OFL 1.1 (`OFL-ArchivoNarrow.txt`) |
| Old English Text MT | `PirataOne-Regular.ttf` (Pirata One, a blackletter) | SIL OFL 1.1 (`OFL-PirataOne.txt`) |

All three come from the google/fonts repository (github.com/google/fonts). No proprietary font file
is committed (decision 3); `src/exports/fonts.js` decides per computer which set the PDF uses.
