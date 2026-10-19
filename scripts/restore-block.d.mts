/** Types for `restore-block.mjs`, which stays plain JavaScript because a Docker script runs it. */

export declare const RESTORE_BLOCK_START: string;
export declare const RESTORE_BLOCK_END: string;
export declare const PRE_UPGRADE_DUMP_START: string;
export declare const PRE_UPGRADE_DUMP_END: string;

export declare function restoreBlockProblems(markdown: string): string[];

export declare function preUpgradeDumpProblems(markdown: string): string[];

export declare function readRestoreBlock(markdown: string): string;

export declare function readPreUpgradeDump(markdown: string): string;
