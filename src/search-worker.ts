import { type IndexedEntry, type SearchCriteria, searchInIndex } from "./search-engine";

type SearchChannel = "global" | "advanced";

type WorkerRequest =
  | { type: "index"; payload: IndexedEntry[] }
  | { type: "search"; payload: { requestId: number; channel: SearchChannel; criteria: SearchCriteria } };

type WorkerResponse =
  | {
      type: "result";
      payload: { requestId: number; channel: SearchChannel; results: ReturnType<typeof searchInIndex> };
    }
  | { type: "error"; payload: { requestId: number; channel: SearchChannel; message: string } };

let currentIndex: IndexedEntry[] = [];

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (!data) {
    return;
  }

  if (data.type === "index") {
    currentIndex = data.payload;
    return;
  }

  const { requestId, channel, criteria } = data.payload;
  try {
    const results = searchInIndex(currentIndex, criteria);
    const response: WorkerResponse = {
      type: "result",
      payload: { requestId, channel, results },
    };
    self.postMessage(response);
  } catch (error) {
    const response: WorkerResponse = {
      type: "error",
      payload: {
        requestId,
        channel,
        message: error instanceof Error ? error.message : "search worker error",
      },
    };
    self.postMessage(response);
  }
};
