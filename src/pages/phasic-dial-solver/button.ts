export class Button {
  private readonly turns: number[];

  constructor(turns: number[]) {
    this.turns = turns;
  }

  public getTurns() {
    return this.turns;
  }
}
