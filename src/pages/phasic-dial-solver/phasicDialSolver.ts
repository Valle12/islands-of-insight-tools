import "@material/web/button/filled-button";
import "@material/web/icon/icon";
import "@material/web/iconbutton/icon-button";
import "@material/web/textfield/outlined-text-field";

import blueDial from "./../../../images/blue-dial.png";
import cyanDial from "./../../../images/cyan-dial.png";
import greenDial from "./../../../images/green-dial.png";
import redDial from "./../../../images/red-dial.png";
import yellowDial from "./../../../images/yellow-dial.png";

const DIAL_IMAGES: Record<string, string> = {
  blue: blueDial,
  red: redDial,
  green: greenDial,
  yellow: yellowDial,
  cyan: cyanDial,
};

const DIAL_ORDER = ["blue", "red", "green", "yellow", "cyan"] as const;

let dialCount = 2;
let buttonCount = 1;

function getDialImgSrc(color: string): string {
  return DIAL_IMAGES[color]!;
}

function rebuildTable() {
  const activeDials = DIAL_ORDER.slice(0, dialCount);

  // Header row: empty cell + dial images
  const header = document.getElementById("table-header")!;
  header.innerHTML =
    "<th></th>" +
    activeDials
      .map(
        c =>
          `<th><img src="${getDialImgSrc(c)}" width="32" height="32" /></th>`,
      )
      .join("");

  // Update footer colspan to span all columns
  const footerCell = document.getElementById("add-button-cell")!;
  footerCell.colSpan = activeDials.length + 1;

  // Body rows: button label + text fields
  const body = document.getElementById("table-body")!;
  body.innerHTML = "";
  for (let i = 1; i <= buttonCount; i++) {
    const row = document.createElement("tr");
    row.innerHTML =
      `<td>Button ${i}</td>` +
      activeDials
        .map(
          c =>
            `<td><md-outlined-text-field type="number" value="0" label="${c}"></md-outlined-text-field></td>`,
        )
        .join("");
    body.appendChild(row);
  }
}

// Add dial
document.getElementById("add-dial")!.addEventListener("click", () => {
  if (dialCount >= DIAL_ORDER.length) return;
  const color = DIAL_ORDER[dialCount];
  const dialsRow = document.getElementById("dials-row")!;
  const addBtn = document.getElementById("add-dial")!;
  const img = document.createElement("img");
  img.src = getDialImgSrc(color);
  img.width = 32;
  img.height = 32;
  dialsRow.insertBefore(img, addBtn);
  dialCount++;

  if (dialCount >= DIAL_ORDER.length) {
    addBtn.style.display = "none";
  }

  rebuildTable();
});

// Add button row
document.getElementById("add-button")!.addEventListener("click", () => {
  buttonCount++;
  rebuildTable();
});

// Calculate
document.getElementById("calculate")!.addEventListener("click", () => {
  const rows = document.querySelectorAll("#table-body tr");
  const data: Record<string, number[]> = {};
  rows.forEach((row, i) => {
    const fields = row.querySelectorAll("md-outlined-text-field");
    const values: number[] = [];
    fields.forEach(f => values.push(Number((f as any).value) || 0));
    data[`Button ${i + 1}`] = values;
  });
  console.log("Calculate turns:", data);
});

// Initial build
rebuildTable();
