// Config-file plumbing shared by the solver pages. Every editor that can be
// filled in by hand also wants to save that work and get it back: a download,
// a file picker, and a drop target anywhere on the page. Only the *validation*
// of the parsed JSON differs per puzzle, so that stays with each page.

/** Serialises a config to pretty-printed JSON and triggers a download. */
export function downloadJson(data: unknown, filename: string) {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export type JsonFileResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Checks a picked/dropped file looks like JSON, reads it and parses it.
 * The `error` is user-facing: it says which of the three steps failed.
 */
export async function readJsonFile(file: File): Promise<JsonFileResult> {
  if (
    !file.name.toLowerCase().endsWith(".json") &&
    file.type !== "application/json"
  ) {
    return { ok: false, error: "Please choose a JSON config file." };
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: "Could not read the selected file." };
  }

  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, error: "The file is not valid JSON." };
  }
}

/**
 * Lets the user drop a config JSON anywhere on the page to load it, showing
 * `overlay` while a drag carrying files is in flight.
 */
export function setupDragAndDrop(
  overlay: HTMLElement,
  onFile: (file: File) => void,
) {
  let dragDepth = 0;
  const hasFiles = (event: DragEvent) =>
    event.dataTransfer != null &&
    Array.from(event.dataTransfer.types).includes("Files");

  window.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth++;
    overlay.classList.remove("hidden");
  });
  window.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
  });
  window.addEventListener("dragleave", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.classList.add("hidden");
  });
  window.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    // dragover already accepted this drop, so the default action (the browser
    // navigating to the dropped file) must be cancelled even when the payload
    // turns out to hold no readable file.
    event.preventDefault();
    dragDepth = 0;
    overlay.classList.add("hidden");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    onFile(file);
  });
}
