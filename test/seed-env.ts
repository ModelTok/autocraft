// Preloaded by `pnpm test` (`node --import ./test/seed-env.ts --test`). A new database tracks nothing unless
// AUTOCRAFT_SEED_REPOS names repos; the suite's fixtures were written around a database that starts with these
// repos tracked, so every test process starts from that list.
process.env.AUTOCRAFT_SEED_REPOS ??= [
  "photocraft", "pdfcraft", "wordcraft", "filmcraft", "gridcraft", "lightcraft", "cadcraft", "vectorcraft", "effectcraft",
  "designcraft", "deckcraft", "artcraft", "soundcraft", "figcraft", "texturecraft", "materialcraft", "stencilcraft",
  "craft-libs", "craft-launcher", "craft-anything", "craft-i18n", "craft-fonts", "font-preview-service",
  "artcraft-services", "egui", "winit",
].join(",");
