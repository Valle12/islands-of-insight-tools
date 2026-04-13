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
