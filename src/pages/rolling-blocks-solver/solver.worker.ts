import { Block } from "./block";
import { AStar } from "./ida";
import { Node } from "./node";

self.onmessage = (event: MessageEvent) => {
  const { gridWidth, gridHeight, cells, root } = event.data;

  // Rehydrate blocks as Block instances
  const hydratedBlocks = root.blocks.map(
    (b: any) => new Block(b.id, b.x, b.y, b.width, b.depth, b.height),
  );
  const hydratedRoot = new Node(
    hydratedBlocks,
    root.mustTouchCellsSatisfied,
    root.currentCost,
    root.cost,
  );

  const aStar = new AStar(gridWidth, gridHeight, cells, 2);
  aStar.onProgress = (progress: number) => {
    self.postMessage({ type: "progress", progress });
  };
  aStar.onDownload = (blob: Blob) => {
    self.postMessage({ type: "download", blob });
  };
  const path = aStar.search(hydratedRoot);
  self.postMessage({ type: "done", path });
};
