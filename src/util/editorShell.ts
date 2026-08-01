// The chrome every solver editor puts around its puzzle: a warning banner, the
// numeric grid-size fields, a confirm-before-clearing dialog, and the config
// file buttons. Only the puzzle itself differs per page, so the frame lives
// here and each editor wires its own callbacks into it.
//
// The ids are the contract. Every page's markup names these elements the same
// way, which is what lets one function find them.

import { setupDragAndDrop } from "./configFile";

/**
 * How long a warning stays up. Long enough to read a sentence, short enough
 * that it does not sit over the board while the mistake is being corrected.
 */
const WARNING_MS = 3500;

/**
 * Wraps a banner element and returns the function that shows a message on it.
 *
 * The timer is restarted on every call rather than left running, so a second
 * problem gets its own full reading time instead of inheriting whatever was
 * left of the first one's.
 */
export function warningBanner(banner: HTMLElement): (message: string) => void {
  let timeoutId: number | null = null;

  return message => {
    banner.textContent = message;
    banner.classList.remove("hidden");
    if (timeoutId !== null) window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => {
      banner.classList.add("hidden");
      timeoutId = null;
    }, WARNING_MS);
  };
}

/**
 * A grid dimension as typed into a size field, or null when it is not one.
 *
 * The upper bound is not decoration: every page builds `width * height` DOM
 * cells from this, and the wasm-backed ones narrow the dimensions at the module
 * boundary, so an unbounded value would either hang the editor or quietly solve
 * a different board.
 */
export function parsePositiveInt(value: string, max: number): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    return null;
  }
  return parsed;
}

/** Opens the reset dialog. Separate from the wiring: any tool may raise it. */
export function openResetDialog(): void {
  (document.getElementById("reset-dialog") as HTMLDialogElement).show();
}

/**
 * The confirm-before-clearing dialog. `onConfirm` runs before it closes, so the
 * page can redraw into a dialog that is still up rather than after it vanishes.
 */
export function wireResetDialog(onConfirm: () => void): void {
  const dialog = document.getElementById("reset-dialog") as HTMLDialogElement;

  document.getElementById("reset-cancel")?.addEventListener("click", () => {
    dialog.close();
  });

  document.getElementById("reset-confirm")?.addEventListener("click", () => {
    onConfirm();
    dialog.close();
  });
}

export type ConfigIoOptions = {
  /** The hidden `<input type="file">` the upload button opens. */
  fileInput: HTMLInputElement;
  /** Shown while a drag carrying files is over the page. */
  dropOverlay: HTMLElement;
  /** A file was picked or dropped. Validating it is the page's business. */
  onFile: (file: File) => void;
  onDownload: () => void;
};

/**
 * The download button, the upload button and its hidden file input, and the
 * whole-page drop target.
 */
export function wireConfigIo(options: ConfigIoOptions): void {
  const { fileInput, dropOverlay, onFile, onDownload } = options;

  document
    .getElementById("download-config")
    ?.addEventListener("click", onDownload);

  document.getElementById("upload-config")?.addEventListener("click", () => {
    fileInput.click();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) onFile(file);
    // Clear the value so re-selecting the same file fires "change" again.
    fileInput.value = "";
  });

  setupDragAndDrop(dropOverlay, onFile);
}
