// Preloaded by `pnpm test` (`node --import ./test/owner-env.ts --test`). This fork's default owner is ModelTok, but the
// suite's fixtures are written around `storytold` repos, so every test file runs with that owner. The default itself is
// tested in test/default-owner.test.ts, which starts its own process without this variable.
process.env.AUTOCRAFT_OWNER = "storytold";
