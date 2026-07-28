import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  downloadJson,
  readJsonFile,
  setupDragAndDrop,
} from "../src/util/configFile";

/** A drag event carrying the given `dataTransfer.types`. */
function dragEvent(type: string, types: string[] | null, files: File[] = []) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: types === null ? null : { types, files },
    configurable: true,
  });
  return event;
}

describe("configFile", () => {
  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  describe("readJsonFile", () => {
    test("parses a JSON file", async () => {
      const result = await readJsonFile(
        new File(['{"a":1}'], "config.json", { type: "application/json" }),
      );
      expect(result).toEqual({ ok: true, data: { a: 1 } });
    });

    test("accepts a .json name even without the JSON mime type", async () => {
      const result = await readJsonFile(new File(["[]"], "CONFIG.JSON"));
      expect(result.ok).toBeTrue();
    });

    test("rejects a file that is neither named nor typed JSON", async () => {
      const result = await readJsonFile(
        new File(["{}"], "config.txt", { type: "text/plain" }),
      );
      expect(result).toEqual({
        ok: false,
        error: "Please choose a JSON config file.",
      });
    });

    test("reports an unreadable file", async () => {
      const file = new File(["{}"], "config.json");
      spyOn(file, "text").mockImplementation(() =>
        Promise.reject(new Error("boom")),
      );
      const result = await readJsonFile(file);
      expect(result).toEqual({
        ok: false,
        error: "Could not read the selected file.",
      });
    });

    test("reports malformed JSON", async () => {
      const result = await readJsonFile(new File(["{oops"], "config.json"));
      expect(result).toEqual({
        ok: false,
        error: "The file is not valid JSON.",
      });
    });
  });

  test("downloadJson serialises pretty-printed and names the file", async () => {
    const blobs: Blob[] = [];
    spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
      blobs.push(blob);
      return "blob:mock";
    });
    const revoke = spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const downloadNames: string[] = [];
    const createElement = document.createElement.bind(document);
    spyOn(document, "createElement").mockImplementation((tag: string) => {
      const element = createElement(tag);
      if (tag === "a") {
        spyOn(element, "click").mockImplementation(() => {
          downloadNames.push((element as HTMLAnchorElement).download);
        });
      }
      return element;
    });

    downloadJson({ a: 1 }, "phasicDialTest.json");

    expect(blobs).toHaveLength(1);
    expect(await blobs[0]!.text()).toBe('{\n  "a": 1\n}');
    expect(blobs[0]!.type).toBe("application/json");
    expect(downloadNames).toEqual(["phasicDialTest.json"]);
    // The object URL must not be left behind.
    expect(revoke).toHaveBeenCalledWith("blob:mock");
    expect(document.querySelector("a")).toBeNull();
  });

  describe("setupDragAndDrop", () => {
    test("shows the overlay while files are dragged and loads the drop", () => {
      const overlay = document.createElement("div");
      overlay.classList.add("hidden");
      const dropped: File[] = [];
      setupDragAndDrop(overlay, file => dropped.push(file));

      window.dispatchEvent(dragEvent("dragenter", ["Files"]));
      expect(overlay.classList.contains("hidden")).toBeFalse();

      // A nested dragenter must not let the matching dragleave hide it early.
      window.dispatchEvent(dragEvent("dragenter", ["Files"]));
      window.dispatchEvent(dragEvent("dragleave", ["Files"]));
      expect(overlay.classList.contains("hidden")).toBeFalse();

      const file = new File(["{}"], "config.json");
      window.dispatchEvent(dragEvent("drop", ["Files"], [file]));
      expect(overlay.classList.contains("hidden")).toBeTrue();
      expect(dropped).toEqual([file]);
    });

    test("hides the overlay once the last drag leaves", () => {
      const overlay = document.createElement("div");
      overlay.classList.add("hidden");
      setupDragAndDrop(overlay, () => {});

      window.dispatchEvent(dragEvent("dragenter", ["Files"]));
      window.dispatchEvent(dragEvent("dragleave", ["Files"]));
      expect(overlay.classList.contains("hidden")).toBeTrue();
    });

    test("ignores drags that carry no files", () => {
      const overlay = document.createElement("div");
      overlay.classList.add("hidden");
      const dropped: File[] = [];
      setupDragAndDrop(overlay, file => dropped.push(file));

      window.dispatchEvent(dragEvent("dragenter", ["text/plain"]));
      window.dispatchEvent(dragEvent("dragover", null));
      expect(overlay.classList.contains("hidden")).toBeTrue();

      // A drop announcing files but delivering none must still be swallowed,
      // otherwise the browser navigates away to the dropped payload.
      const empty = dragEvent("drop", ["Files"], []);
      window.dispatchEvent(empty);
      expect(empty.defaultPrevented).toBeTrue();
      expect(dropped).toHaveLength(0);
    });
  });
});
