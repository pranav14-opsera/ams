// Boots the full NestJS DI graph against the COMPILED build (dist/,
// tsc-compiled — same artifact CI's own Build step and a real deployment
// produce) and confirms every provider resolves, then exits.
//
// Why this exists and why it must run against dist/, not source via tsx:
// WO-015 found a real gap — none of this repo's tests ever exercise
// actual NestJS dependency injection (they all construct classes
// directly with `new Foo(...)`, bypassing the DI container entirely), so
// a wiring mistake in a *.module.ts file had no automated test that could
// have caught it. It was only found by manually booting the app. Worse,
// a bug surfaced this way ONLY when running TypeScript source directly
// via tsx/esbuild (used for this repo's own quick verification scripts
// and for `npm test`'s test runner) — esbuild's emitDecoratorMetadata
// support is known to be less complete than tsc's for constructor
// parameters typed by a concrete class sitting next to interface-typed,
// @Inject()-token parameters. The real tsc-compiled build (what actually
// ships) resolved correctly the whole time. Running this check against
// dist/ is what makes it a genuine regression guard for the artifact that
// actually deploys, rather than a tsx-toolchain-specific false alarm.
const path = require("node:path");

async function main() {
  const distAppModulePath = path.join(__dirname, "..", "dist", "app.module.js");
  let AppModule;
  try {
    ({ AppModule } = require(distAppModulePath));
  } catch (err) {
    console.error(`Could not load ${distAppModulePath} — run "npm run build" first.`);
    console.error(err);
    process.exit(1);
  }

  require("reflect-metadata");
  const { NestFactory } = require("@nestjs/core");

  process.env.JWT_PUBLIC_KEY_PEM = process.env.JWT_PUBLIC_KEY_PEM ?? "";

  try {
    const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn"] });
    console.log("Full AppModule DI graph resolved successfully.");
    await app.close();
    process.exit(0);
  } catch (err) {
    console.error("NestJS DI graph failed to resolve:", err);
    process.exit(1);
  }
}

main();
