declare module "better-sqlite3" {
  export type RunResult = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  export type Statement = {
    all: (...params: unknown[]) => unknown[];
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => RunResult;
  };

  export default class Database {
    constructor(filename: string);
    pragma(source: string): unknown;
    exec(source: string): unknown;
    prepare(source: string): Statement;
    close(): void;
  }
}

declare module "node:sqlite" {
  export type StatementSync = {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  };

  export class DatabaseSync {
    constructor(filename: string);
    exec(source: string): void;
    prepare(source: string): StatementSync;
    close(): void;
  }
}
