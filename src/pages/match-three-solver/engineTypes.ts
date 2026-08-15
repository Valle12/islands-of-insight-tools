// What a match-three search is asked for and what it answers with, plus the
// three sampling constants every arm shares.
//
// A module of its own so `engine.ts`, `prover.ts` and `cheapArms.ts` can all
// speak this vocabulary without importing each other: the prover and the cheap
// arms are peers under the engine, and a type living in either of them would
// make one the other's dependency for no reason. Everything here is re-exported
// from `engine.ts`, which stays the page's front door.

import type { Move } from "./rules";

/**
 * What the engine is doing right now. `greedy`, `beam` and `nrpa` are the cheap
 * arms; `exhaustive` is the full-depth search that runs when none of them found
 * anything, and which is the only thing that can call a board unclearable.
 */
export type SolvePhase = "greedy" | "beam" | "nrpa" | "exhaustive";

export interface SolveProgress {
  readonly phase: SolvePhase;
  readonly nodes: number;
}

export interface SolveOptions {
  readonly budgetMs?: number;
  /**
   * Failed-state table ceiling override — a knob for tests and the bench,
   * not a page setting. Tiny values force eviction on every store, which is
   * how the tests prove eviction cannot change an answer.
   */
  readonly tableBytes?: number;
  readonly onProgress?: (progress: SolveProgress) => void;
  /**
   * Streams every improvement to the best-known solution, as it is found.
   * The client that holds the latest of these can stop the search at any
   * point and still have a playable answer.
   */
  readonly onBest?: (moves: Move[]) => void;
  /** Called once, as the search returns, with what it spent getting there. */
  readonly onStats?: (stats: SolveStats) => void;
}

/** What a finished search spent, however it ended. */
export interface SolveStats {
  /** Work units — fast-arm moves applied plus prover edges considered. */
  readonly nodes: number;
  /** Transposition-table entries held at return. */
  readonly tableEntries: number;
  /** The deepest prover iteration entered, completed or not. */
  readonly depthReached: number;
}

export type SolveResult =
  /**
   * A clearing sequence. Nothing is claimed about its length: the search stops
   * at the first solution it can play, because measured over the captured
   * corpus that first solution is already the shortest on 48 of 49 boards, and
   * proving the last one cost minutes.
   */
  | { status: "solved"; moves: Move[] }
  /**
   * A completed proof that the board cannot be cleared at all. This is an
   * EXISTENCE proof, not a length one, and it is the only proof left here: it
   * comes from exhausting `maxDepth = floor(blocks / MIN_RUN)`, which
   * terminates on its own because every move clears at least `MIN_RUN` cells.
   */
  | { status: "unsolvable" }
  /** The budget ran out with nothing found. Says nothing about the board. */
  | { status: "budget" };

/** Nodes between clock reads. Reading the clock per node costs more than the
 * search itself. */
export const CHECK_INTERVAL = 2_000;

/** Progress posts at most this often; the page reads it at human speed. */
export const PROGRESS_INTERVAL_MS = 100;

/**
 * Failed-state table ceiling. Past it the table evicts instead of growing — the
 * search slows down rather than dying, which is the point: the unbounded
 * predecessor took tens of GB into an OS kill on exactly the boards this solver
 * exists for.
 */
export const TABLE_BYTES = 256 * 1024 * 1024;
