import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  openResetDialog,
  parsePositiveInt,
  warningBanner,
  wireConfigIo,
  wireResetDialog,
} from "../src/util/editorShell";

describe("parsePositiveInt", () => {
  test.each([
    ["6", 6],
    ["32", 32],
    ["1", 1],
  ])("reads %p as %p", (value, expected) => {
    expect(parsePositiveInt(value, 32)).toBe(expected);
  });

  test.each([
    ["zero", "0"],
    ["a negative", "-4"],
    ["a fraction", "2.5"],
    ["past the cap", "33"],
    ["empty", ""],
    ["not a number", "wide"],
  ])("refuses %s", (_name, value) => {
    expect(parsePositiveInt(value, 32)).toBeNull();
  });
});

describe("warningBanner", () => {
  let banner: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="warning-banner" class="hidden"></div>';
    banner = document.getElementById("warning-banner")!;
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  test("shows the message and reveals the banner", () => {
    warningBanner(banner)("Invalid config: nope.");
    expect(banner.textContent).toBe("Invalid config: nope.");
    expect(banner.classList.contains("hidden")).toBeFalse();
  });

  /** The real delay is 3.5s, so the timer is captured and fired by hand. */
  test("hides itself again when the timer fires", () => {
    const timers: (() => void)[] = [];
    spyOn(window, "setTimeout").mockImplementation(((fn: () => void) => {
      timers.push(fn);
      return timers.length;
    }) as unknown as typeof window.setTimeout);

    warningBanner(banner)("Gone in a moment.");
    expect(banner.classList.contains("hidden")).toBeFalse();
    timers[0]!();
    expect(banner.classList.contains("hidden")).toBeTrue();
  });

  /** A second problem gets its own full reading time, not the first's rest. */
  test("restarts the timer rather than letting the first one run on", () => {
    const cleared: unknown[] = [];
    spyOn(window, "setTimeout").mockImplementation(
      (() => 7) as unknown as typeof window.setTimeout,
    );
    spyOn(window, "clearTimeout").mockImplementation(id => {
      cleared.push(id);
    });

    const show = warningBanner(banner);
    show("First.");
    expect(cleared).toEqual([]);
    show("Second.");
    expect(cleared).toEqual([7]);
  });

  test("each banner keeps its own timer", () => {
    document.body.innerHTML += '<div id="other" class="hidden"></div>';
    const other = document.getElementById("other")!;
    const cleared: unknown[] = [];
    spyOn(window, "setTimeout").mockImplementation(
      (() => 1) as unknown as typeof window.setTimeout,
    );
    spyOn(window, "clearTimeout").mockImplementation(id => {
      cleared.push(id);
    });

    warningBanner(banner)("One.");
    warningBanner(other)("Two.");
    // Two separate closures, so neither cancels the other's timer.
    expect(cleared).toEqual([]);
  });
});

describe("wireResetDialog", () => {
  const dialog = () =>
    document.getElementById("reset-dialog") as HTMLDialogElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <md-dialog id="reset-dialog">
        <md-text-button id="reset-cancel">Cancel</md-text-button>
        <md-filled-button id="reset-confirm">Reset</md-filled-button>
      </md-dialog>
    `;
    // The test DOM does not register `md-dialog`, so provide what is called.
    const element = dialog() as HTMLDialogElement & { show: () => void };
    element.show = () => {
      element.open = true;
    };
    element.close = () => {
      element.open = false;
    };
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  test("confirming runs the callback and closes", () => {
    const onConfirm = mock(() => {});
    wireResetDialog(onConfirm);
    openResetDialog();
    expect(dialog().open).toBeTrue();

    document.getElementById("reset-confirm")!.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBeFalse();
  });

  test("cancelling closes without running the callback", () => {
    const onConfirm = mock(() => {});
    wireResetDialog(onConfirm);
    openResetDialog();

    document.getElementById("reset-cancel")!.click();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(dialog().open).toBeFalse();
  });
});

describe("wireConfigIo", () => {
  let files: File[];
  let downloads: number;

  const fileInput = () =>
    document.getElementById("config-file-input") as HTMLInputElement;

  beforeEach(() => {
    document.body.innerHTML = `
      <md-icon-button id="upload-config"></md-icon-button>
      <md-icon-button id="download-config"></md-icon-button>
      <input id="config-file-input" type="file" />
      <div id="drop-overlay" class="hidden"></div>
    `;
    files = [];
    downloads = 0;
    wireConfigIo({
      fileInput: fileInput(),
      dropOverlay: document.getElementById("drop-overlay")!,
      onFile: file => files.push(file),
      onDownload: () => downloads++,
    });
  });

  afterEach(() => {
    mock.restore();
    document.body.innerHTML = "";
  });

  test("the download button calls back", () => {
    document.getElementById("download-config")!.click();
    expect(downloads).toBe(1);
  });

  test("the upload button opens the hidden file input", () => {
    const click = spyOn(fileInput(), "click").mockImplementation(() => {});
    document.getElementById("upload-config")!.click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  test("a picked file reaches the callback", () => {
    const file = new File(["{}"], "puzzle.json");
    Object.defineProperty(fileInput(), "files", {
      value: [file],
      configurable: true,
    });
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
    expect(files).toEqual([file]);
  });

  /**
   * Otherwise re-picking the same file fires no "change" at all. The writes are
   * recorded rather than read back: happy-dom refuses any non-empty value on a
   * file input, so there is no "dirty" state to observe being cleared.
   */
  test("the input is cleared so the same file can be picked twice", () => {
    const writes: string[] = [];
    Object.defineProperty(fileInput(), "files", {
      value: [new File(["{}"], "puzzle.json")],
      configurable: true,
    });
    Object.defineProperty(fileInput(), "value", {
      get: () => "",
      set: (written: string) => writes.push(written),
      configurable: true,
    });

    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
    expect(writes).toEqual([""]);
  });

  test("a change carrying no file calls nothing", () => {
    fileInput().dispatchEvent(new Event("change", { bubbles: true }));
    expect(files).toEqual([]);
  });
});
