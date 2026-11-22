# Caption fonts

The fonts in `assets/fonts/` are under the SIL Open Font License 1.1 (licence text in this folder, one per family).
Downloaded 2026-11-22 from https://github.com/google/fonts (branch main).

This folder sits one level down on purpose: `assets/fonts/` is ffmpeg's `fontsdir`, and libass tries to load every
file directly in it (a text file there logged "error opening memory font 'readme.md'"). Sub-folders are skipped.
`trigger.config.ts` copies `./assets/fonts/**`, so these licences still ship with the build.

| File (in assets/fonts/) | Source path | License (in this folder) |
|---|---|---|
| Anton-Regular.ttf | ofl/anton/Anton-Regular.ttf | anton/OFL.txt |
| Poppins-ExtraBold.ttf | ofl/poppins/Poppins-ExtraBold.ttf | poppins/OFL.txt |
| Poppins-Bold.ttf | ofl/poppins/Poppins-Bold.ttf | poppins/OFL.txt |
| Poppins-SemiBold.ttf | ofl/poppins/Poppins-SemiBold.ttf | poppins/OFL.txt |
