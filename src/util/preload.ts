// `node:worker_threads` FIRST, before happy-dom. bun >= 1.4 patches
// `MessagePort.prototype` when its worker_threads shim first loads, and
// `GlobalRegistrator.register()` replaces `globalThis.MessagePort` with
// happy-dom's class: registered first, the shim patches the wrong class and
// every `new Worker` from node:worker_threads — the shifting-mosaic wasm
// suite's arms — dies with "port.on is not a function". Putting the global
// back afterwards does not help; loading the shim first does (measured on
// 1.4.0, both in plain `bun test` and under `--parallel`).
import "node:worker_threads";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach } from "bun:test";

GlobalRegistrator.register();

beforeEach(() => {
  Bun.env.NODE_ENV = "test";
});
