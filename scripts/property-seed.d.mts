/** Types for `property-seed.mjs`, plain JavaScript because a plain Node script reads it too. */

export declare const PROPERTY_SEED_VARIABLE: string;
export declare const GATE_PROPERTY_SEED: number;

export declare function seedFrom(env: Readonly<Record<string, string | undefined>>): {
  readonly seed: number;
  readonly source: 'gate' | 'environment';
};
