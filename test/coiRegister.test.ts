import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { registerCoiShim } from "../src/common/coiRegister";

/**
 * happy-dom has no ServiceWorkerContainer, no `isSecureContext` and no
 * `crossOriginIsolated`, which is exactly the degraded environment the shim
 * must stay quiet in. The other branches get their globals defined by hand
 * and removed again after each case, so nothing leaks into the next file
 * (`--parallel` isolates files; a bare `bun test` does not).
 */
const defined: { target: object; key: string }[] = [];

function define(target: object, key: string, value: unknown) {
  Object.defineProperty(target, key, {
    value,
    configurable: true,
    writable: true,
  });
  defined.push({ target, key });
}

function serviceWorker(register: () => Promise<unknown>) {
  const container = { register: mock(register), ready: Promise.resolve({}) };
  define(navigator, "serviceWorker", container);
  return container;
}

const secure = () => define(window, "isSecureContext", true);

/** Enough turns of the event loop for `register().then(async …)` to run out. */
const settled = async () => {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0));
};

const reload = mock();

beforeEach(() => {
  reload.mockClear();
  define(window.location, "reload", reload);
  sessionStorage.clear();
});

afterEach(() => {
  for (const { target, key } of defined.splice(0)) {
    delete (target as Record<string, unknown>)[key];
  }
});

describe("registerCoiShim", () => {
  test("stays quiet where service workers do not exist", async () => {
    secure();
    registerCoiShim();
    await settled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("stays quiet in a non-secure context", async () => {
    const container = serviceWorker(() => Promise.resolve({}));
    registerCoiShim();
    await settled();
    expect(container.register).not.toHaveBeenCalled();
  });

  test("stays quiet once the page is already isolated", async () => {
    secure();
    define(window, "crossOriginIsolated", true);
    const container = serviceWorker(() => Promise.resolve({}));
    registerCoiShim();
    await settled();
    expect(container.register).not.toHaveBeenCalled();
  });

  test("registers the shim page-relative and reloads once it is active", async () => {
    secure();
    const container = serviceWorker(() => Promise.resolve({}));
    registerCoiShim();
    expect(container.register).toHaveBeenCalledWith("../coi-serviceworker.js");
    await settled();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem("coi-shim-reloaded")).toBe("1");
  });

  test("never reloads twice: the guard survives the first reload", async () => {
    secure();
    sessionStorage.setItem("coi-shim-reloaded", "1");
    serviceWorker(() => Promise.resolve({}));
    registerCoiShim();
    await settled();
    expect(reload).not.toHaveBeenCalled();
  });

  test("a registration that fails is logged and reloads nothing", async () => {
    secure();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    serviceWorker(() => Promise.reject(new Error("blocked by policy")));
    registerCoiShim();
    await settled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
