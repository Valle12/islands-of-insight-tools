import { mkdirSync } from "fs";
import { resolve } from "path";

const projectRoot = resolve(import.meta.dir, "../..");

const boostInclude =
  process.env.BOOST_INCLUDE ??
  (process.platform === "win32"
    ? "E:\\packages\\vcpkg\\installed\\x64-windows\\include"
    : null);

const emcc = process.platform === "win32" ? "em++.bat" : "em++";

async function build({
  aStarDir,
  outDir,
  sources,
  outputJs,
  exportName,
  needsBoost,
}: {
  aStarDir: string;
  outDir: string;
  sources: string[];
  outputJs: string;
  exportName: string;
  needsBoost: boolean;
}) {
  mkdirSync(outDir, { recursive: true });

  const args = [
    ...sources.map(s => resolve(aStarDir, s)),
    "-o",
    resolve(outDir, outputJs),
    ...(needsBoost && boostInclude ? ["-I", boostInclude] : []),
    "-std=c++23",
    "-O3",
    "-s",
    "WASM=1",
    "-s",
    "MODULARIZE=1",
    "-s",
    `EXPORT_NAME=${exportName}`,
    "-s",
    "ENVIRONMENT=web,worker",
    "-s",
    "ALLOW_MEMORY_GROWTH=1",
    "-s",
    "INITIAL_MEMORY=16777216",
    "--bind",
    "-flto",
    "-fno-exceptions",
  ];

  const proc = Bun.spawn([emcc, ...args], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`em++ exited with code ${exitCode}`);
  }
}

await build({
  aStarDir: resolve(projectRoot, "src/pages/rolling-blocks-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/rolling-blocks-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp", "Block.cpp"],
  outputJs: "astar.mjs",
  exportName: "createAStarModule",
  needsBoost: true,
});

await build({
  aStarDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/a-star"),
  outDir: resolve(projectRoot, "src/pages/shifting-mosaic-solver/wasm"),
  sources: ["wasm_bindings.cpp", "AStar.cpp"],
  outputJs: "astar.mjs",
  exportName: "createShiftingMosaicAStarModule",
  needsBoost: false,
});
