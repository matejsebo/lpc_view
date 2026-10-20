// lpc_view: the ingest worker. Parses a chunk and bins its points by cell off
// the main thread (cells.js parseChunk and binChunk), then hands the arrays back
// with their buffers transferred, not copied. Chunks are answered in the order
// they arrive; the main thread (cells.js binAsync) relies on that.

import { binChunk, binnedBuffers, parseChunk } from "./cells.js";

onmessage = (e) => {
  const { buf, grid, start } = e.data;
  try {
    const b = binChunk(parseChunk(buf, start), grid, start);
    postMessage(b, binnedBuffers(b));
  } catch (err) {
    postMessage({ error: err.message });
  }
};
