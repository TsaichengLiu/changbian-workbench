import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TableOfContents,
  TextRun,
  UnderlineType,
  type IRunOptions,
} from "docx";
import * as XLSX from "xlsx";
import type { Chapter, Entry, OrderedEntryRef, Project, WorkspaceData } from "./types";
import { downloadBlob, sanitizeFilename } from "./utils";

export type ExportScope = "active" | "all";

function getExportProjects(workspace: WorkspaceData, scope: ExportScope): Project[] {
  if (scope === "active" && workspace.activeProjectId) {
    const active = workspace.projects[workspace.activeProjectId];
    return active ? [active] : [];
  }

  return workspace.projectOrder
    .map((projectId) => workspace.projects[projectId])
    .filter((project): project is Project => Boolean(project));
}

function collectEntriesForProject(workspace: WorkspaceData, project: Project): OrderedEntryRef[] {
  let counter = 1;
  const collected: OrderedEntryRef[] = [];

  const collectEntry = (entry: Entry, chapterId: string | null) => {
    const chapter = chapterId ? workspace.chapters[chapterId] ?? null : null;
    collected.push({ entry, project, chapter, order: counter });
    counter += 1;
  };

  for (const entryId of project.entryIds) {
    const entry = workspace.entries[entryId];
    if (entry) {
      collectEntry(entry, null);
    }
  }

  for (const chapterId of project.chapterIds) {
    const chapter = workspace.chapters[chapterId];
    if (!chapter) {
      continue;
    }
    for (const entryId of chapter.entryIds) {
      const entry = workspace.entries[entryId];
      if (entry) {
        collectEntry(entry, chapter.id);
      }
    }
  }

  return collected;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString("zh-Hant");
}

function exportLabel(workspace: WorkspaceData, scope: ExportScope): string {
  if (scope === "active" && workspace.activeProjectId) {
    const title = workspace.projects[workspace.activeProjectId]?.title;
    if (title) {
      return `${title}-史料匯出`;
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  return `長編工作臺-全部專案-${date}`;
}

function entryHeadline(entry: Entry): string {
  return entry.timeText || "未著錄時間";
}

interface MarkupSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function parseLightMarkupSegments(text: string): MarkupSegment[] {
  const source = text || "";
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*)/g;
  const segments: MarkupSegment[] = [];
  let cursor = 0;

  for (const match of source.matchAll(pattern)) {
    const token = match[0] ?? "";
    const index = match.index ?? 0;
    if (index > cursor) {
      segments.push({ text: source.slice(cursor, index) });
    }

    if (token.startsWith("**") && token.endsWith("**")) {
      segments.push({ text: token.slice(2, -2), bold: true });
    } else if (token.startsWith("__") && token.endsWith("__")) {
      segments.push({ text: token.slice(2, -2), underline: true });
    } else if (token.startsWith("*") && token.endsWith("*")) {
      segments.push({ text: token.slice(1, -1), italic: true });
    } else {
      segments.push({ text: token });
    }
    cursor = index + token.length;
  }

  if (cursor < source.length) {
    segments.push({ text: source.slice(cursor) });
  }

  return segments;
}

function segmentToRuns(
  segment: MarkupSegment,
  baseOptions: Omit<IRunOptions, "text" | "break" | "bold" | "italics" | "underline"> = {},
): TextRun[] {
  const lines = segment.text.split(/\r?\n/);
  const runs: TextRun[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    runs.push(
      new TextRun({
        ...baseOptions,
        text: lines[index] ?? "",
        bold: segment.bold,
        italics: segment.italic,
        underline: segment.underline ? { type: UnderlineType.SINGLE } : undefined,
        break: index > 0 ? 1 : undefined,
      }),
    );
  }
  return runs;
}

function sourceTextRuns(
  text: string,
  baseOptions: Omit<IRunOptions, "text" | "break" | "bold" | "italics" | "underline"> = {},
): TextRun[] {
  const segments = parseLightMarkupSegments(text);
  if (segments.length === 0) {
    return [new TextRun({ ...baseOptions, text: "" })];
  }
  return segments.flatMap((segment) => segmentToRuns(segment, baseOptions));
}

function plainTextRuns(
  text: string,
  baseOptions: Omit<IRunOptions, "text" | "break"> = {},
): TextRun[] {
  const lines = (text || "").split(/\r?\n/);
  return lines.map(
    (line, index) =>
      new TextRun({
        ...baseOptions,
        text: line,
        break: index > 0 ? 1 : undefined,
      }),
  );
}

const DOCX_INDENT = {
  chapter: 360,
  entry: 720,
} as const;

const KAITI_FONT: IRunOptions["font"] = {
  ascii: "KaiTi",
  hAnsi: "KaiTi",
  eastAsia: "KaiTi",
  cs: "KaiTi",
};

const SONGTI_FONT: IRunOptions["font"] = {
  ascii: "SimSun",
  hAnsi: "SimSun",
  eastAsia: "SimSun",
  cs: "SimSun",
};

export function exportAsTxt(workspace: WorkspaceData, scope: ExportScope): void {
  const projects = getExportProjects(workspace, scope);
  const lines: string[] = ["長編工作臺匯出", ""];

  for (const project of projects) {
    lines.push(`# 專案：${project.title}`);

    const directEntries = project.entryIds
      .map((entryId) => workspace.entries[entryId])
      .filter((entry): entry is Entry => Boolean(entry));

    if (directEntries.length > 0) {
      lines.push("## 未分章史料");
      directEntries.forEach((entry, index) => {
        lines.push(`### ${index + 1}. ${entryHeadline(entry)}`);
        lines.push("摘要：");
        lines.push(entry.summary || "");
        lines.push("史料文本：");
        lines.push(entry.sourceText || "");
        lines.push("備註：");
        lines.push(entry.note || "");
        lines.push("引文註釋：");
        lines.push(entry.citation || "");
        lines.push("");
      });
    }

    for (const chapterId of project.chapterIds) {
      const chapter = workspace.chapters[chapterId];
      if (!chapter) {
        continue;
      }
      lines.push(`## 章節：${chapter.title}`);
      chapter.entryIds.forEach((entryId, index) => {
        const entry = workspace.entries[entryId];
        if (!entry) {
          return;
        }
        lines.push(`### ${index + 1}. ${entryHeadline(entry)}`);
        lines.push("摘要：");
        lines.push(entry.summary || "");
        lines.push("史料文本：");
        lines.push(entry.sourceText || "");
        lines.push("備註：");
        lines.push(entry.note || "");
        lines.push("引文註釋：");
        lines.push(entry.citation || "");
        lines.push("");
      });
    }

    lines.push("");
  }

  const content = `\uFEFF${lines.join("\n")}`;
  const filename = sanitizeFilename(exportLabel(workspace, scope));
  downloadBlob(new Blob([content], { type: "text/plain;charset=utf-8" }), `${filename}.txt`);
}

function appendEntryParagraphs(children: Paragraph[], order: number, entry: Entry): void {
  const sharedIndent = DOCX_INDENT.entry;
  const summaryLabel = entry.summary.trim() || "（無摘要）";

  children.push(
    new Paragraph({
      text: `${order}. ${entryHeadline(entry)}｜${summaryLabel}`,
      heading: HeadingLevel.HEADING_3,
      indent: { left: sharedIndent },
      spacing: { before: 80, after: 60 },
    }),
  );

  children.push(
    new Paragraph({
      indent: { left: sharedIndent },
      spacing: { after: 80 },
      children: [
        new TextRun({ text: "史料文本：", bold: true }),
        new TextRun({ text: "", break: 1 }),
        ...sourceTextRuns(entry.sourceText || "（無）", { font: SONGTI_FONT }),
      ],
    }),
  );

  children.push(
    new Paragraph({
      indent: { left: sharedIndent },
      spacing: { after: 80 },
      children: [
        new TextRun({ text: "備註：", bold: true, font: KAITI_FONT }),
        new TextRun({ text: "", break: 1 }),
        ...plainTextRuns(entry.note || "（無）", { font: KAITI_FONT }),
      ],
    }),
  );

  children.push(
    new Paragraph({
      indent: { left: sharedIndent },
      spacing: { after: 120 },
      children: [
        new TextRun({ text: "引文註釋：", bold: true }),
        new TextRun({ text: "", break: 1 }),
        ...plainTextRuns(entry.citation || "（無）", { font: SONGTI_FONT }),
      ],
    }),
  );
}

export async function exportAsDocx(workspace: WorkspaceData, scope: ExportScope): Promise<void> {
  const projects = getExportProjects(workspace, scope);
  const children: Paragraph[] = [
    new Paragraph({
      text: "長編工作臺匯出",
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      children: [new TextRun({ text: `匯出時間：${formatDate(Date.now())}` })],
      spacing: { after: 180 },
    }),
    new TableOfContents("目錄", {
      headingStyleRange: "1-3",
      hyperlink: true,
      beginDirty: true,
    }),
  ];

  for (const [projectIndex, project] of projects.entries()) {
    children.push(
      new Paragraph({
        text: `專案：${project.title}`,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
        spacing: { before: projectIndex === 0 ? 200 : 120, after: 100 },
      }),
    );

    let order = 1;

    const directEntries = project.entryIds
      .map((entryId) => workspace.entries[entryId])
      .filter((entry): entry is Entry => Boolean(entry));

    const chapterEntries = project.chapterIds
      .map((chapterId) => workspace.chapters[chapterId])
      .filter((chapter): chapter is Chapter => Boolean(chapter))
      .map((chapter) => ({
        chapter,
        entries: chapter.entryIds
          .map((entryId) => workspace.entries[entryId])
          .filter((entry): entry is Entry => Boolean(entry)),
      }))
      .filter((group) => group.entries.length > 0);

    if (directEntries.length === 0 && chapterEntries.length === 0) {
      children.push(
        new Paragraph({
          text: "（此專案暫無史料）",
          indent: { left: DOCX_INDENT.chapter },
        }),
      );
      continue;
    }

    if (directEntries.length > 0) {
      children.push(
        new Paragraph({
          text: "未分章史料",
          heading: HeadingLevel.HEADING_2,
          indent: { left: DOCX_INDENT.chapter },
        }),
      );
      for (const entry of directEntries) {
        appendEntryParagraphs(children, order, entry);
        order += 1;
      }
    }

    for (const group of chapterEntries) {
      children.push(
        new Paragraph({
          text: `章節：${group.chapter.title}`,
          heading: HeadingLevel.HEADING_2,
          indent: { left: DOCX_INDENT.chapter },
        }),
      );

      for (const entry of group.entries) {
        appendEntryParagraphs(children, order, entry);
        order += 1;
      }
    }
  }

  const doc = new Document({
    features: {
      updateFields: true,
    },
    styles: {
      default: {
        document: {
          run: {
            font: SONGTI_FONT,
          },
        },
        heading1: {
          run: {
            font: SONGTI_FONT,
          },
        },
        heading2: {
          run: {
            font: SONGTI_FONT,
          },
        },
        heading3: {
          run: {
            font: SONGTI_FONT,
          },
        },
      },
    },
    sections: [
      {
        properties: {},
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const filename = sanitizeFilename(exportLabel(workspace, scope));
  downloadBlob(blob, `${filename}.docx`);
}

export function exportAsXlsx(workspace: WorkspaceData, scope: ExportScope): void {
  const projects = getExportProjects(workspace, scope);

  const rows: Array<Array<string | number>> = [
    [
      "專案",
      "章節",
      "序號",
      "時間",
      "摘要",
      "史料文本",
      "備註",
      "引文註釋",
      "建立時間",
      "更新時間",
    ],
  ];

  for (const project of projects) {
    const entries = collectEntriesForProject(workspace, project);
    for (const item of entries) {
      rows.push([
        project.title,
        item.chapter?.title ?? "未分章",
        item.order,
        item.entry.timeText,
        item.entry.summary,
        item.entry.sourceText,
        item.entry.note,
        item.entry.citation,
        formatDate(item.entry.createdAt),
        formatDate(item.entry.updatedAt),
      ]);
    }
  }

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet["!cols"] = [
    { wch: 20 },
    { wch: 20 },
    { wch: 8 },
    { wch: 24 },
    { wch: 36 },
    { wch: 70 },
    { wch: 40 },
    { wch: 40 },
    { wch: 22 },
    { wch: 22 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "史料匯出");

  const filename = sanitizeFilename(exportLabel(workspace, scope));
  XLSX.writeFile(workbook, `${filename}.xlsx`);
}
