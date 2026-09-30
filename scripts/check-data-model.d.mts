/** Types for `check-data-model.mjs`, which stays plain JavaScript because `verify:static` runs it. */

export declare const MIGRATIONS_DIRECTORY: string;
export declare const MIGRATOR_SOURCE: string;
export declare const DATA_MODEL_PAGE: string;
export declare const UNDOCUMENTED_TABLES: Readonly<Record<string, string>>;
export declare const SPECIFIED_NOT_CREATED: Readonly<Record<string, string>>;

export declare function withoutCommentsAndLiterals(sql: string): string;

export declare function tablesCreated(
  documents: readonly { readonly path: string; readonly sql: string }[],
): { tables: Map<string, string>; partitions: Map<string, string> };

export declare function describedTables(page: string): Set<string>;
export declare function entryTables(page: string): Set<string>;

export declare function dataModelProblems(input: {
  readonly tables: ReadonlyMap<string, string>;
  readonly page: string;
  readonly undocumented?: Readonly<Record<string, string>>;
  readonly specified?: Readonly<Record<string, string>>;
}): string[];

export declare function migratorDdl(source: string): string | null;

export declare function checkDataModel(root: string): {
  readonly migrations: number;
  readonly tables: Map<string, string>;
  readonly partitions: Map<string, string>;
  readonly problems: string[];
};
