import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Presentation, PresentationFile } from "@oai/artifact-tool";

const workspaceDir = "/Users/aaronarquillano/Projects/store-pos";
const SKILL_DIR = "/Users/aaronarquillano/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.22227/skills/presentations";
const TMP_DIR = path.join(workspaceDir, "presentation-build", "runtime");
const FINAL_PPTX = path.join(workspaceDir, "presentation-output", "GMA-Store-POS-Project-Proposal-Revised-Objectives.pptx");
const RUNTIME_PYTHON = "/Users/aaronarquillano/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const { finalizePresentation } = await import(
  pathToFileURL(path.join(SKILL_DIR, "container_tools/artifact_tool_utils.mjs")).href,
);

await fs.mkdir(TMP_DIR, { recursive: true });
await fs.mkdir(path.dirname(FINAL_PPTX), { recursive: true });

const coverBytes = await fs.readFile(path.join(workspaceDir, "presentation-assets", "store-pos-cover.png"));
const usersBytes = await fs.readFile(path.join(workspaceDir, "presentation-assets", "store-pos-users.png"));
const iconBytes = await fs.readFile(path.join(workspaceDir, "apps", "web", "public", "icon-512.png"));

const W = 1280;
const H = 720;
const FONT = "Avenir Next";
const SERIF = "Georgia";
const CREAM = "#F7F5EF";
const PAPER = "#FFFDF8";
const INK = "#1B2A24";
const MUTED = "#66736D";
const LINE = "#DEDed4";
const GREEN = "#116149";
const GREEN_DARK = "#0B4937";
const MINT = "#DCEBE2";
const YELLOW = "#F2C94C";
const RED = "#BA4A3D";

const presentation = Presentation.create({ slideSize: { width: W, height: H } });

function addText(slide, text, position, options = {}) {
  const shape = slide.shapes.add({
    geometry: "textbox",
    name: options.name,
    position,
    fill: options.fill ?? "none",
    line: options.line ?? { fill: "none", width: 0 },
    ...(options.borderRadius ? { borderRadius: options.borderRadius } : {}),
  });
  shape.text = text;
  shape.text.style = {
    typeface: options.typeface ?? FONT,
    fontSize: options.fontSize ?? 22,
    bold: options.bold ?? false,
    italic: options.italic ?? false,
    color: options.color ?? INK,
    alignment: options.alignment ?? "left",
    verticalAlignment: options.verticalAlignment ?? "top",
    autoFit: options.autoFit ?? "none",
    wrap: "square",
    lineSpacing: options.lineSpacing ?? 1.08,
    insets: options.insets ?? { top: 0, right: 0, bottom: 0, left: 0 },
  };
  return shape;
}

function addRect(slide, position, fill, options = {}) {
  return slide.shapes.add({
    geometry: options.geometry ?? "rect",
    name: options.name,
    position,
    fill,
    line: options.line ?? { fill: "none", width: 0 },
    ...(options.borderRadius ? { borderRadius: options.borderRadius } : {}),
    ...(options.shadow ? { shadow: options.shadow } : {}),
  });
}

function addTitle(slide, title, number) {
  addText(slide, String(number).padStart(2, "0"), { left: 72, top: 44, width: 54, height: 28 }, {
    fontSize: 16, bold: true, color: GREEN, name: `slide-${number}-number`,
  });
  addText(slide, title, { left: 138, top: 34, width: 1040, height: 58 }, {
    typeface: SERIF, fontSize: 40, color: INK, name: `slide-${number}-title`,
  });
  addRect(slide, { left: 72, top: 105, width: 1136, height: 2 }, GREEN);
}

function addFooter(slide, number) {
  addText(slide, "GMA STORE POS  ·  PROJECT PROPOSAL", { left: 72, top: 680, width: 360, height: 16 }, {
    fontSize: 10, bold: true, color: MUTED,
  });
  addText(slide, String(number).padStart(2, "0"), { left: 1156, top: 678, width: 52, height: 18 }, {
    fontSize: 11, bold: true, color: GREEN, alignment: "right",
  });
}

function addSectionLabel(slide, label, position) {
  addText(slide, label.toUpperCase(), position, {
    fontSize: 12, bold: true, color: GREEN,
  });
}

// Slide 1: Cover
{
  const slide = presentation.slides.add();
  slide.background.fill = CREAM;
  slide.images.add({
    blob: coverBytes,
    contentType: "image/png",
    alt: "Illustration of a sari-sari store owner using a tablet point-of-sale system",
    fit: "cover",
    position: { left: 0, top: 0, width: W, height: H },
  });
  addRect(slide, { left: 68, top: 56, width: 66, height: 66 }, PAPER, {
    geometry: "roundRect", borderRadius: 18, shadow: "shadow-sm",
  });
  slide.images.add({
    blob: iconBytes,
    contentType: "image/png",
    alt: "GMA Store POS application icon",
    fit: "contain",
    position: { left: 76, top: 64, width: 50, height: 50 },
  });
  addText(slide, "CCE106L PROJECT PROPOSAL", { left: 68, top: 160, width: 420, height: 24 }, {
    fontSize: 13, bold: true, color: GREEN,
  });
  addText(slide, "GMA Store POS", { left: 68, top: 197, width: 560, height: 100 }, {
    typeface: SERIF, fontSize: 68, color: INK, lineSpacing: 0.92,
  });
  addText(slide, "An Offline-First Point-of-Sale System\nfor Sari-Sari Stores", { left: 72, top: 310, width: 520, height: 82 }, {
    fontSize: 25, color: GREEN_DARK, lineSpacing: 1.16,
  });
  addRect(slide, { left: 72, top: 430, width: 60, height: 7 }, YELLOW);
  addText(slide, "Presenters: [Names]\nInstructor: [Instructor Name]\nDate: [Presentation Date]", { left: 72, top: 470, width: 420, height: 94 }, {
    fontSize: 17, color: MUTED, lineSpacing: 1.35,
  });
  slide.speakerNotes.textFrame.setText("Cover illustration generated for this presentation. Project details are based on the GMA Store POS repository and README.");
}

// Slide 2: Overview and problem
{
  const slide = presentation.slides.add();
  slide.background.fill = CREAM;
  addTitle(slide, "Project overview and problem", 2);

  addSectionLabel(slide, "Current challenge", { left: 78, top: 145, width: 240, height: 20 });
  addText(slide, "Small stores often rely on handwritten records and memory during busy selling hours.", { left: 78, top: 176, width: 520, height: 112 }, {
    typeface: SERIF, fontSize: 35, color: INK, lineSpacing: 1.08,
  });

  addText(slide, "01", { left: 78, top: 336, width: 60, height: 34 }, { fontSize: 20, bold: true, color: RED });
  addText(slide, "Manual sales and stock records take time and can contain errors.", { left: 152, top: 330, width: 430, height: 72 }, {
    fontSize: 21, color: INK, lineSpacing: 1.16,
  });
  addText(slide, "02", { left: 78, top: 432, width: 60, height: 34 }, { fontSize: 20, bold: true, color: RED });
  addText(slide, "Internet-dependent systems can stop the checkout process when the connection fails.", { left: 152, top: 426, width: 430, height: 78 }, {
    fontSize: 21, color: INK, lineSpacing: 1.16,
  });

  addRect(slide, { left: 660, top: 150, width: 492, height: 440 }, GREEN_DARK, {
    geometry: "roundRect", borderRadius: 28,
  });
  addText(slide, "PROPOSED SOLUTION", { left: 710, top: 202, width: 340, height: 22 }, {
    fontSize: 12, bold: true, color: YELLOW,
  });
  addText(slide, "A mobile-friendly POS that keeps the store operating offline", { left: 710, top: 244, width: 380, height: 150 }, {
    typeface: SERIF, fontSize: 39, color: PAPER, lineSpacing: 1.04,
  });
  addText(slide, "Sales save on the device first. The system updates cloud data and backups when internet access returns.", { left: 710, top: 430, width: 370, height: 102 }, {
    fontSize: 20, color: MINT, lineSpacing: 1.25,
  });
  addFooter(slide, 2);
  slide.speakerNotes.textFrame.setText("The offline model and feature scope come from README.md and docs/sale-sync-resilience.md in the project repository.");
}

// Slide 3: Objectives
{
  const slide = presentation.slides.add();
  slide.background.fill = PAPER;
  addTitle(slide, "Project objectives", 3);
  addText(slide, "The project focuses on four development goals", { left: 78, top: 132, width: 620, height: 36 }, {
    fontSize: 21, color: MUTED,
  });

  const objectives = [
    ["01", "Develop an accessible POS", "Create a mobile-friendly system suited to the daily operations of sari-sari stores."],
    ["02", "Implement offline operation", "Allow staff to complete and save sales without a continuous internet connection."],
    ["03", "Integrate store management tools", "Combine checkout, inventory, utang, expenses, and daily reporting in one system."],
    ["04", "Support secure and reliable data", "Implement role-based access, synchronization, and encrypted backups."],
  ];
  const positions = [
    { left: 78, top: 205 }, { left: 650, top: 205 },
    { left: 78, top: 418 }, { left: 650, top: 418 },
  ];
  objectives.forEach(([num, heading, body], index) => {
    const p = positions[index];
    addText(slide, num, { left: p.left, top: p.top, width: 72, height: 44 }, {
      typeface: SERIF, fontSize: 34, color: index === 3 ? YELLOW : GREEN,
    });
    addText(slide, heading, { left: p.left + 92, top: p.top + 2, width: 390, height: 38 }, {
      fontSize: 22, bold: true, color: INK,
    });
    addText(slide, body, { left: p.left + 92, top: p.top + 53, width: 395, height: 82 }, {
      fontSize: 19, color: MUTED, lineSpacing: 1.22,
    });
    addRect(slide, { left: p.left, top: p.top + 164, width: 480, height: 2 }, index === 3 ? YELLOW : MINT);
  });
  addFooter(slide, 3);
  slide.speakerNotes.textFrame.setText("These objectives describe what the team aims to achieve while developing the GMA Store POS project.");
}

// Slide 4: Target users
{
  const slide = presentation.slides.add();
  slide.background.fill = CREAM;
  slide.images.add({
    blob: usersBytes,
    contentType: "image/png",
    alt: "Illustration of a sari-sari store owner, cashier, and system administrator",
    fit: "cover",
    crop: { left: 0.08, top: 0, right: 0, bottom: 0.05 },
    position: { left: 520, top: 0, width: 760, height: 720 },
  });
  addRect(slide, { left: 0, top: 0, width: 570, height: 720 }, CREAM);
  addText(slide, "04", { left: 72, top: 48, width: 54, height: 28 }, { fontSize: 16, bold: true, color: GREEN });
  addText(slide, "Target users", { left: 72, top: 92, width: 430, height: 68 }, {
    typeface: SERIF, fontSize: 48, color: INK,
  });

  const roles = [
    ["Owner or administrator", "Manages products, stock, expenses, reports, staff access, and backups."],
    ["Cashier", "Processes sales through a focused checkout view and records the payment method."],
    ["System superadministrator", "Creates stores and manages owner or administrator access across deployments."],
  ];
  roles.forEach(([heading, body], index) => {
    const top = 210 + index * 132;
    addRect(slide, { left: 74, top: top + 4, width: 10, height: 70 }, index === 1 ? YELLOW : GREEN);
    addText(slide, heading, { left: 108, top, width: 370, height: 32 }, {
      fontSize: 22, bold: true, color: INK,
    });
    addText(slide, body, { left: 108, top: top + 40, width: 378, height: 64 }, {
      fontSize: 17, color: MUTED, lineSpacing: 1.2,
    });
  });
  addText(slide, "ROLE-BASED ACCESS", { left: 72, top: 646, width: 270, height: 20 }, {
    fontSize: 11, bold: true, color: GREEN,
  });
  slide.speakerNotes.textFrame.setText("Role definitions are based on the contracts and authentication flows in packages/contracts and apps/web/components/auth-shell.tsx. Illustration generated for this presentation.");
}

// Slide 5: Main proposed features
{
  const slide = presentation.slides.add();
  slide.background.fill = PAPER;
  addTitle(slide, "Main proposed features", 5);
  addText(slide, "The proposal covers the store’s daily sales cycle and the records around it.", { left: 78, top: 132, width: 760, height: 36 }, {
    fontSize: 21, color: MUTED,
  });

  const features = [
    ["01", "Checkout and payments", "Barcode-assisted selling with cash, GCash, Maya, and utang options."],
    ["02", "Inventory control", "Product units, restocking, stock adjustments, and low-stock monitoring."],
    ["03", "Customer utang ledger", "Customer balances, purchase entries, and payment recording."],
    ["04", "Reports and expenses", "Daily sales summary, expenses, transactions, and top products."],
    ["05", "Access and recovery", "Staff roles, offline synchronization, product images, and encrypted backups."],
  ];
  features.forEach(([num, heading, body], index) => {
    const top = 200 + index * 88;
    addText(slide, num, { left: 82, top: top + 2, width: 50, height: 28 }, {
      fontSize: 16, bold: true, color: index === 4 ? RED : GREEN,
    });
    addText(slide, heading, { left: 150, top, width: 330, height: 31 }, {
      fontSize: 22, bold: true, color: INK,
    });
    addText(slide, body, { left: 500, top, width: 650, height: 56 }, {
      fontSize: 18, color: MUTED, lineSpacing: 1.2,
    });
    if (index < features.length - 1) addRect(slide, { left: 82, top: top + 67, width: 1068, height: 1 }, LINE);
  });

  addRect(slide, { left: 1042, top: 126, width: 108, height: 9 }, YELLOW);
  addFooter(slide, 5);
  slide.speakerNotes.textFrame.setText("Feature statements are grounded in the current web components, contracts, API services, and tests in the GMA Store POS repository.");
}

// Slide 6: Workflow
{
  const slide = presentation.slides.add();
  slide.background.fill = CREAM;
  addTitle(slide, "Basic system workflow", 6);
  addText(slide, "Core selling steps remain available after the first online setup.", { left: 78, top: 132, width: 720, height: 36 }, {
    fontSize: 21, color: MUTED,
  });

  const nodes = [];
  const data = [
    ["1", "Staff sign-in", "Role and store access"],
    ["2", "Find products", "Search or scan barcode"],
    ["3", "Build the cart", "Set quantity or amount"],
    ["4", "Select payment", "Cash, e-wallet, or utang"],
    ["5", "Save the sale", "Stored on the device first"],
    ["6", "Update records", "Stock, ledger, and reports"],
    ["7", "Sync data", "Back up when online"],
  ];
  const positions = [
    { left: 78, top: 210 }, { left: 360, top: 210 }, { left: 642, top: 210 }, { left: 924, top: 210 },
    { left: 924, top: 465 }, { left: 642, top: 465 }, { left: 360, top: 465 },
  ];
  data.forEach(([num, heading, body], index) => {
    const p = positions[index];
    const node = addRect(slide, { left: p.left, top: p.top, width: 236, height: 128 }, index === 4 ? GREEN_DARK : PAPER, {
      geometry: "roundRect", borderRadius: 20,
      line: { style: "solid", fill: index === 4 ? GREEN_DARK : LINE, width: 1 },
      shadow: "shadow-sm", name: `workflow-step-${num}`,
    });
    addText(slide, num, { left: p.left + 18, top: p.top + 17, width: 36, height: 32 }, {
      typeface: SERIF, fontSize: 24, color: index === 4 ? YELLOW : GREEN,
    });
    addText(slide, heading, { left: p.left + 62, top: p.top + 18, width: 154, height: 28 }, {
      fontSize: 19, bold: true, color: index === 4 ? PAPER : INK,
    });
    addText(slide, body, { left: p.left + 18, top: p.top + 65, width: 198, height: 48 }, {
      fontSize: 15, color: index === 4 ? MINT : MUTED, lineSpacing: 1.16,
    });
    nodes.push(node);
  });
  for (let i = 0; i < 3; i += 1) {
    slide.shapes.connect(nodes[i], nodes[i + 1], {
      kind: "straight", fromSide: "right", toSide: "left",
      line: { style: "solid", fill: GREEN, width: 3 },
      tail: { type: "triangle", width: "sm", length: "sm" },
    });
  }
  slide.shapes.connect(nodes[3], nodes[4], {
    kind: "straight", fromSide: "bottom", toSide: "top",
    line: { style: "solid", fill: GREEN, width: 3 },
    tail: { type: "triangle", width: "sm", length: "sm" },
  });
  slide.shapes.connect(nodes[4], nodes[5], {
    kind: "straight", fromSide: "left", toSide: "right",
    line: { style: "solid", fill: GREEN, width: 3 },
    tail: { type: "triangle", width: "sm", length: "sm" },
  });
  slide.shapes.connect(nodes[5], nodes[6], {
    kind: "straight", fromSide: "left", toSide: "right",
    line: { style: "solid", fill: GREEN, width: 3 },
    tail: { type: "triangle", width: "sm", length: "sm" },
  });
  addText(slide, "OFFLINE CORE", { left: 80, top: 369, width: 190, height: 20 }, { fontSize: 11, bold: true, color: GREEN });
  addRect(slide, { left: 78, top: 398, width: 1082, height: 2 }, MINT);
  addText(slide, "ONLINE WHEN AVAILABLE", { left: 962, top: 618, width: 198, height: 20 }, { fontSize: 11, bold: true, color: GREEN, alignment: "right" });
  addFooter(slide, 6);
  slide.speakerNotes.textFrame.setText("Editable workflow diagram. The device-first sale and later synchronization flow are described in README.md and docs/sale-sync-resilience.md.");
}

// Slide 7: Technologies and tools
{
  const slide = presentation.slides.add();
  slide.background.fill = PAPER;
  addTitle(slide, "Technologies and tools", 7);
  addText(slide, "A web stack supports mobile use, offline operation, and centralized store data.", { left: 78, top: 132, width: 810, height: 36 }, {
    fontSize: 21, color: MUTED,
  });

  const layers = [
    ["INTERFACE", "Next.js  ·  React  ·  TypeScript  ·  Progressive Web App", GREEN_DARK, PAPER],
    ["DEVICE DATA", "Dexie  ·  IndexedDB  ·  Offline command queue", MINT, INK],
    ["APPLICATION SERVER", "NestJS  ·  Fastify  ·  Role-based API", "#E7EEE9", INK],
    ["DATA AND BACKUPS", "PostgreSQL  ·  S3-compatible MinIO  ·  Docker", "#F7E7B1", INK],
  ];
  layers.forEach(([label, tools, fill, textColor], index) => {
    const top = 205 + index * 100;
    addRect(slide, { left: 78, top, width: 1100 - index * 72, height: 72 }, fill, {
      geometry: "roundRect", borderRadius: 16,
    });
    addText(slide, label, { left: 102, top: top + 23, width: 210, height: 24 }, {
      fontSize: 12, bold: true, color: index === 0 ? YELLOW : GREEN,
    });
    addText(slide, tools, { left: 326, top: top + 18, width: 760 - index * 40, height: 34 }, {
      fontSize: 21, bold: index === 0, color: textColor,
    });
  });
  addText(slide, "Local-first experience", { left: 82, top: 624, width: 260, height: 26 }, {
    typeface: SERIF, fontSize: 22, color: GREEN_DARK,
  });
  addText(slide, "The browser handles daily work. The server supports shared access, synchronization, and recovery.", { left: 370, top: 621, width: 740, height: 44 }, {
    fontSize: 17, color: MUTED,
  });
  addFooter(slide, 7);
  slide.speakerNotes.textFrame.setText("Technology choices are taken from package.json, apps/web/package.json, apps/api/package.json, docker-compose.yml, and README.md.");
}

const stagingDir = path.join(workspaceDir, ".codex-finalizer");
await fs.mkdir(stagingDir, { recursive: true });
const candidatePath = path.join(stagingDir, "gma-store-pos-proposal-candidate.pptx");
await (await PresentationFile.exportPptx(presentation)).save(candidatePath);

const requirements = {
  explicitTotalSlideCount: 7,
  requiredNativeTableOwnerSlides: [],
  requiredNativeChartOwnerSlides: [],
};

const result = await finalizePresentation({
  ...requirements,
  workspaceDir,
  candidatePath,
  finalPath: FINAL_PPTX,
  pythonExecutable: RUNTIME_PYTHON,
  integrityValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_package_integrity.py"),
  layoutValidatorPath: path.join(SKILL_DIR, "container_tools/inspect_presentation_layout_geometry.py"),
  layoutArgs: [
    "--expected-slide-size-emu", "12192000,6858000",
    "--validate-bullet-geometry",
    "--validate-heading-fit",
  ],
  fontPolicy: { basis: "design", families: [FONT, SERIF] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(stagingDir, "GMA-Store-POS-Project-Proposal-Revised-Objectives.validation.json"),
});

console.log(JSON.stringify({ finalPath: FINAL_PPTX, candidatePath, result }, null, 2));
