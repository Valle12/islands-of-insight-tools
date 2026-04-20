import type { Button } from "../pages/phasic-dial-solver/button";

export type SolverTest = {
  maxValues: number[];
  initialValues: number[];
  buttons: Button[];
  result: number[];
};

export type LcmTest = {
  values: number[];
  result: number;
};

export type CartesianProductTest = {
  limits: number[];
  result: number[][];
};

export type Tile = "regular" | "mustTouch" | "goal" | "unplayable";

export type PaintTool =
  | "regular"
  | "mustTouch"
  | "goal"
  | "unplayable"
  | "block"
  | "fillRegular"
  | "fillMustTouch"
  | "reset";

export type Position = {
  x: number;
  y: number;
};
