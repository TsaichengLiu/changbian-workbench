#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");

const STORAGE_FILE =
  process.env.CHANGBIAN_MCP_STORE ||
  path.join(os.homedir(), ".changbian-workbench", "workspace.json");

const TAG_REGEX = /#([^\s#，。；、,.;:!?！？【】（）()<>《》]+)/g;
const CITATION_TITLE_REGEX = /《([^》\n\r]+)》/g;

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractTags(text) {
  const tags = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(TAG_REGEX)) {
    const token = `#${(match[1] || "").trim()}`;
    if (!token || token === "#") {
      continue;
    }
    const key = token.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(token);
  }
  return tags;
}

function extractCitationTitles(text) {
  const titles = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(CITATION_TITLE_REGEX)) {
    const token = (match[1] || "").trim();
    if (!token) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    titles.push(token);
  }
  return titles;
}

function includesIgnoreCase(text, query) {
  if (!query) {
    return true;
  }
  return String(text || "").toLowerCase().includes(query.toLowerCase());
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function createInitialWorkspace() {
  const projectId = createId("project");
  return {
    projectOrder: [projectId],
    projects: {
      [projectId]: {
        id: projectId,
        title: "MCP 新建專案",
        chapterIds: [],
        entryIds: [],
        createdAt: Date.now(),
      },
    },
    chapters: {},
    entries: {},
    activeProjectId: projectId,
    activeChapterId: null,
    selectedEntryId: null,
  };
}

function loadWorkspace() {
  try {
    if (!fs.existsSync(STORAGE_FILE)) {
      const initial = createInitialWorkspace();
      saveWorkspace(initial);
      return initial;
    }
    const raw = fs.readFileSync(STORAGE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid workspace payload");
    }
    return parsed;
  } catch (error) {
    const fallback = createInitialWorkspace();
    saveWorkspace(fallback);
    return fallback;
  }
}

function saveWorkspace(workspace) {
  ensureDirForFile(STORAGE_FILE);
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(workspace, null, 2), "utf8");
}

function uniqueProjectTitle(workspace, rawTitle) {
  const base = String(rawTitle || "").trim() || "新建專案";
  const used = new Set(Object.values(workspace.projects || {}).map((project) => project.title));
  if (!used.has(base)) {
    return base;
  }
  let counter = 2;
  while (used.has(`${base} (${counter})`)) {
    counter += 1;
  }
  return `${base} (${counter})`;
}

function appendEntry(workspace, payload) {
  const project = workspace.projects[payload.projectId];
  if (!project) {
    throw new Error("project_id 不存在");
  }

  if (payload.chapterId) {
    const chapter = workspace.chapters[payload.chapterId];
    if (!chapter) {
      throw new Error("chapter_id 不存在");
    }
    if (chapter.projectId !== payload.projectId) {
      throw new Error("chapter_id 不屬於 project_id");
    }
  }

  const entryId = createId("entry");
  const now = Date.now();
  workspace.entries[entryId] = {
    id: entryId,
    projectId: payload.projectId,
    chapterId: payload.chapterId || null,
    timeText: payload.timeText || "",
    sourceText: payload.sourceText || "",
    note: payload.note || "",
    citation: payload.citation || "",
    createdAt: now,
    updatedAt: now,
  };

  if (payload.chapterId) {
    workspace.chapters[payload.chapterId].entryIds.push(entryId);
  } else {
    project.entryIds.push(entryId);
  }

  workspace.activeProjectId = payload.projectId;
  workspace.activeChapterId = payload.chapterId || null;
  workspace.selectedEntryId = entryId;

  return entryId;
}

const TOOLS = [
  {
    name: "list_projects",
    description: "列出全部專案、章節與史料數量摘要。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "create_project",
    description: "建立新專案。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "專案標題" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "create_chapter",
    description: "在指定專案下建立新章節。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "目標專案 ID" },
        title: { type: "string", description: "章節標題" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
  },
  {
    name: "add_entry",
    description: "錄入一條史料。",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "目標專案 ID" },
        chapter_id: { type: "string", description: "目標章節 ID（可選）" },
        time_text: { type: "string", description: "時間文本" },
        source_text: { type: "string", description: "史料文本" },
        note: { type: "string", description: "備註（可含 #標籤）" },
        citation: { type: "string", description: "引文註釋" },
      },
      required: ["project_id", "source_text"],
      additionalProperties: false,
    },
  },
  {
    name: "search_entries",
    description: "檢索史料，可按關鍵詞、標籤、引文《》書名篩選。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "關鍵詞" },
        tag: { type: "string", description: "標籤，如 #人物" },
        citation_title: { type: "string", description: "引文《》內書名" },
        limit: { type: "number", description: "返回數量上限（預設 50）" },
      },
      additionalProperties: false,
    },
  },
];

function toolText(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function parseArgs(params) {
  if (!params || typeof params !== "object") {
    return {};
  }
  const args = params.arguments;
  if (!args || typeof args !== "object") {
    return {};
  }
  return args;
}

function handleToolCall(name, args) {
  const workspace = loadWorkspace();

  if (name === "list_projects") {
    const projects = workspace.projectOrder
      .map((projectId) => workspace.projects[projectId])
      .filter(Boolean)
      .map((project) => {
        const chapterCount = project.chapterIds.length;
        const chapterEntryCount = project.chapterIds.reduce((sum, chapterId) => {
          const chapter = workspace.chapters[chapterId];
          return sum + (chapter ? chapter.entryIds.length : 0);
        }, 0);
        return {
          id: project.id,
          title: project.title,
          chapter_count: chapterCount,
          entry_count: project.entryIds.length + chapterEntryCount,
          chapters: project.chapterIds
            .map((chapterId) => workspace.chapters[chapterId])
            .filter(Boolean)
            .map((chapter) => ({
              id: chapter.id,
              title: chapter.title,
              entry_count: chapter.entryIds.length,
            })),
        };
      });

    return toolText({
      storage_file: STORAGE_FILE,
      project_count: projects.length,
      projects,
    });
  }

  if (name === "create_project") {
    const projectId = createId("project");
    const title = uniqueProjectTitle(workspace, args.title);
    workspace.projects[projectId] = {
      id: projectId,
      title,
      chapterIds: [],
      entryIds: [],
      createdAt: Date.now(),
    };
    workspace.projectOrder.push(projectId);
    workspace.activeProjectId = projectId;
    workspace.activeChapterId = null;
    workspace.selectedEntryId = null;
    saveWorkspace(workspace);

    return toolText({
      ok: true,
      project_id: projectId,
      title,
    });
  }

  if (name === "create_chapter") {
    const projectId = String(args.project_id || "").trim();
    if (!projectId || !workspace.projects[projectId]) {
      throw new Error("project_id 不存在");
    }

    const chapterId = createId("chapter");
    const title = String(args.title || "").trim() || "新章節";

    workspace.chapters[chapterId] = {
      id: chapterId,
      projectId,
      title,
      entryIds: [],
      createdAt: Date.now(),
    };
    workspace.projects[projectId].chapterIds.push(chapterId);
    workspace.activeProjectId = projectId;
    workspace.activeChapterId = chapterId;
    workspace.selectedEntryId = null;
    saveWorkspace(workspace);

    return toolText({
      ok: true,
      chapter_id: chapterId,
      project_id: projectId,
      title,
    });
  }

  if (name === "add_entry") {
    const projectId = String(args.project_id || "").trim();
    const chapterId = String(args.chapter_id || "").trim();

    const entryId = appendEntry(workspace, {
      projectId,
      chapterId: chapterId || null,
      timeText: String(args.time_text || ""),
      sourceText: String(args.source_text || ""),
      note: String(args.note || ""),
      citation: String(args.citation || ""),
    });
    saveWorkspace(workspace);

    return toolText({
      ok: true,
      entry_id: entryId,
      project_id: projectId,
      chapter_id: chapterId || null,
    });
  }

  if (name === "search_entries") {
    const query = String(args.query || "").trim();
    const tagRaw = String(args.tag || "").trim();
    const tag = tagRaw ? (tagRaw.startsWith("#") ? tagRaw.toLowerCase() : `#${tagRaw.toLowerCase()}`) : "";
    const citationTitle = String(args.citation_title || "").trim();
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));

    const rows = [];

    for (const projectId of workspace.projectOrder) {
      const project = workspace.projects[projectId];
      if (!project) {
        continue;
      }

      const projectLevel = project.entryIds.map((entryId) => ({
        entry: workspace.entries[entryId],
        chapterId: null,
        chapterTitle: "未分章",
      }));

      const chapterLevel = project.chapterIds.flatMap((chapterId) => {
        const chapter = workspace.chapters[chapterId];
        if (!chapter) {
          return [];
        }
        return chapter.entryIds.map((entryId) => ({
          entry: workspace.entries[entryId],
          chapterId,
          chapterTitle: chapter.title,
        }));
      });

      for (const item of [...projectLevel, ...chapterLevel]) {
        const entry = item.entry;
        if (!entry) {
          continue;
        }

        const queryPass = query
          ? includesIgnoreCase(
              [project.title, item.chapterTitle, entry.timeText, entry.sourceText, entry.note, entry.citation].join("\n"),
              query,
            )
          : true;

        const tagPass = tag
          ? extractTags(entry.note).some((token) => token.toLowerCase() === tag)
          : true;

        const citationPass = citationTitle
          ? extractCitationTitles(entry.citation).some((token) => includesIgnoreCase(token, citationTitle)) ||
            includesIgnoreCase(entry.citation, citationTitle)
          : true;

        if (!queryPass || !tagPass || !citationPass) {
          continue;
        }

        rows.push({
          entry_id: entry.id,
          project_id: project.id,
          project_title: project.title,
          chapter_id: item.chapterId,
          chapter_title: item.chapterTitle,
          time_text: entry.timeText,
          source_text: entry.sourceText,
          note: entry.note,
          citation: entry.citation,
          tags: extractTags(entry.note),
        });

        if (rows.length >= limit) {
          break;
        }
      }

      if (rows.length >= limit) {
        break;
      }
    }

    return toolText({
      count: rows.length,
      rows,
    });
  }

  throw new Error(`未知工具：${name}`);
}

function sendMessage(payload) {
  const json = JSON.stringify(payload);
  const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
  process.stdout.write(header + json);
}

function sendResult(id, result) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  sendMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

async function handleRequest(request) {
  const { id, method, params } = request;

  if (!method) {
    if (id !== undefined) {
      sendError(id, -32600, "Invalid Request");
    }
    return;
  }

  try {
    if (method === "initialize") {
      const protocolVersion = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05";
      sendResult(id, {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "changbian-workbench-mcp",
          version: "0.1.0",
        },
      });
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    if (method === "tools/list") {
      sendResult(id, { tools: TOOLS });
      return;
    }

    if (method === "tools/call") {
      const name = String(params?.name || "").trim();
      const args = parseArgs(params);
      const result = handleToolCall(name, args);
      sendResult(id, result);
      return;
    }

    if (method === "resources/list") {
      sendResult(id, { resources: [] });
      return;
    }

    if (method === "prompts/list") {
      sendResult(id, { prompts: [] });
      return;
    }

    if (method === "shutdown") {
      sendResult(id, {});
      return;
    }

    if (id !== undefined) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    if (id !== undefined) {
      sendError(id, -32000, error instanceof Error ? error.message : "Internal error");
    }
  }
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);

  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      return;
    }

    const headerText = buffer.slice(0, headerEnd).toString("utf8");
    const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      buffer = Buffer.alloc(0);
      return;
    }

    const bodyLength = Number(lengthMatch[1]);
    const messageStart = headerEnd + 4;
    const messageEnd = messageStart + bodyLength;

    if (buffer.length < messageEnd) {
      return;
    }

    const payload = buffer.slice(messageStart, messageEnd).toString("utf8");
    buffer = buffer.slice(messageEnd);

    let request;
    try {
      request = JSON.parse(payload);
    } catch {
      continue;
    }

    void handleRequest(request);
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});
