import { mkdirSync } from "fs";
import { resolve } from "path";

const projectRoot = resolve(import.meta.dir, "../..");
const aStarDir = resolve(
  projectRoot,
  "src/pages/rolling-blocks-solver/a-star",
);
const outDir = resolve(projectRoot, "src/pages/rolling-blocks-solver/wasm");

mkdirSync(outDir, { recursive: true });

const sources = [
  resolve(aStarDir, "wasm_bindings.cpp"),
  resolve(aStarDir, "AStar.cpp"),
  resolve(aStarDir, "Block.cpp"),
];
const outputJs = resolve(outDir, "astar.mjs");

const boostInclude =
  process.env.BOOST_INCLUDE ??
  (process.platform === "win32"
    ? "E:\\packages\\vcpkg\\installed\\x64-windows\\include"
    : null);

const args = [
  ...sources,
  "-o",
  outputJs,
  ...(boostInclude ? ["-I", boostInclude] : []),
  "-std=c++23",
  "-O3",
  "-s",
  "WASM=1",
  "-s",
  "MODULARIZE=1",
  "-s",
  "EXPORT_NAME=createAStarModule",
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

const emcc = process.platform === "win32" ? "em++.bat" : "em++";
const proc = Bun.spawn([emcc, ...args], { stdout: "inherit", stderr: "inherit" });
const exitCode = await proc.exited;
if (exitCode !== 0) {
  throw new Error(`em++ exited with code ${exitCode}`);
}
