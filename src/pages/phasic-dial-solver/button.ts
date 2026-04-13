export class Button {
  private turns: number[];

  constructor(turns: number[]) {
    this.turns = turns;
  }

  public getTurns() {
    return this.turns;
  }
}
