export class Button {
  // Copied on the way in and handed out read-only. The copy matters because
  // `validateConfig` builds Buttons straight from the parsed upload
  // (`new Button(entry.turns)`), so without it a Button aliases the caller's
  // array and changes under it. The GETTER deliberately does not copy:
  // `turnSolver` calls it once per button per combination inside the search,
  // and that is the only search on this site running on the main thread.
  private readonly turns: readonly number[];

  constructor(turns: readonly number[]) {
    this.turns = [...turns];
  }

  public getTurns(): readonly number[] {
    return this.turns;
  }
}
