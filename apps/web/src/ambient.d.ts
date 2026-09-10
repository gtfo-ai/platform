/**
 * The non-JavaScript imports Vite resolves and `tsc` does not.
 *
 * Kept to exactly what is used: a stylesheet import has no runtime value in this app (Vite emits a
 * `<link>` for it), so it is declared as `void` rather than as `any`, and a module that tries to
 * read something out of it fails to compile.
 */
declare module '*.css' {
  const stylesheet: void;
  export default stylesheet;
}
