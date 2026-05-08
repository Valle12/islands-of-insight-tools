declare module "*.png" {
  const value: string;
  export default value;
}

declare module "/astar.mjs" {
  const createAStarModule: (opts?: {
    locateFile?: (path: string) => string;
  }) => Promise<EmscriptenModule & { search: Function }>;
  export default createAStarModule;
}
