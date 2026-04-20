import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { beforeEach } from "bun:test";

GlobalRegistrator.register();

beforeEach(() => {
  Bun.env.NODE_ENV = "test";
});
