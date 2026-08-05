/**
 * The page's own markup, trimmed to the ids and hooks the editor reaches for.
 *
 * Its own module rather than a constant inside one suite, so the suites that
 * mount the editor cannot drift into mounting two different pages — the same
 * reason `boards.ts` sits beside them.
 * It is mounted for real rather than stubbed through `getElementById` because
 * the editor also runs `querySelectorAll` over `#paint-tools` and delegates the
 * clicks on `#symbol-row` and `#rule-row` to the rows themselves.
 *
 * The tool buttons are split across the same rows the page uses, so a selector
 * that only ever found them in one of them fails here too.
 */
export const MARKUP = `
  <div id="editor-section">
    <div id="warning-banner" class="hidden"></div>
    <input id="grid-width" />
    <input id="grid-height" />
    <div id="grid"></div>
    <div id="tool-status"></div>
    <div id="paint-tools">
      <div id="command-row" class="tool-row">
        <button class="tool-button icon-tool" data-tool="erase" type="button">Eraser</button>
        <button class="tool-button icon-tool" data-tool="reset" type="button">Reset</button>
      </div>
      <div id="color-row" class="tool-row">
        <button class="tool-button icon-tool" data-tool="dark" type="button">Dark</button>
        <button class="tool-button icon-tool" data-tool="light" type="button">Light</button>
        <button class="tool-button icon-tool" data-tool="unplayable" type="button">Unplayable</button>
        <button class="tool-button icon-tool" data-tool="merge" type="button">Merge cells</button>
      </div>
      <div id="symbol-row" class="tool-row"></div>
    </div>
    <div id="rule-section">
      <div id="rule-row"></div>
    </div>
    <md-filled-button id="solve-puzzle">Solve Grid</md-filled-button>
    <md-icon-button id="upload-config"></md-icon-button>
    <md-icon-button id="download-config"></md-icon-button>
    <input id="config-file-input" type="file" />
    <output id="solution-panel" class="hidden">
      <span id="solution-status"></span>
      <div id="solution-spinner" class="hidden">
        <span id="solution-progress-text"></span>
        <md-text-button id="solution-cancel">Cancel</md-text-button>
      </div>
      <div id="solution-message"></div>
    </output>
  </div>
  <div id="solution-view" class="hidden">
    <span id="solution-count"></span>
    <div id="solution-grid"></div>
    <div id="solution-note"></div>
    <md-text-button id="solution-exit">Back to editor</md-text-button>
  </div>
  <md-dialog id="reset-dialog">
    <md-text-button id="reset-cancel">Cancel</md-text-button>
    <md-filled-button id="reset-confirm">Reset</md-filled-button>
  </md-dialog>
  <div id="drop-overlay" class="hidden"></div>
`;
